import { randomUUID } from "node:crypto";
import type { ProviderRegistration, ProviderEvent, ProviderInput, ProviderSessionConfig,
  ProviderLaunch, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { negotiateProviderCapabilities, requireProviderCapabilities } from "@getpaseo/plugin/server/provider";
import { launchBridge, type BridgeClient, type WireEvent } from "./bridge-client.js";

import { parseSlash } from "./slash-commands.js";
import { preparePrompt } from "./prompt-content.js";

const SUPPORTED = ["prompt.message", "prompt.steer", "prompt.image", "prompt.command", "session.configure", "session.persistence", "permission"] as const;
export type BridgeFactory = (env: Record<string, string>, cwd?: string, command?: string, args?: readonly string[]) => BridgeClient;
function environment(launch?: ProviderLaunch, session?: ProviderSessionConfig): Record<string, string> {
  return { ...(launch?.env ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))), ...session?.env };
}
function persistence(nativeId: string) { return { version: 1, data: { nativeId } }; }
function resumeId(value: any): string {
  if (value?.version !== 1 || typeof value?.data?.nativeId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.data.nativeId)) {
    throw new Error("Invalid Hermes Direct persistence data");
  }
  return value.data.nativeId;
}
export function createHermesProvider(factory: BridgeFactory = launchBridge): ProviderRegistration {
  return {
    id: "hermes-direct", label: "Hermes Direct", icon: "hermes.svg",
    description: "Native Hermes AIAgent token streaming (no ACP)", command: ["python3"],
    async status(request) {
      const bridge = factory(environment(request?.launch), undefined, request?.launch?.command, request?.launch?.args);
      try { await bridge.ready; return { available: true }; }
      catch (e) { return { available: false, diagnostic: `${String(e)} Set PASEO_HERMES_PYTHON to Hermes's venv Python and PASEO_HERMES_ROOT to its checkout.` }; }
      finally { await bridge.close(); }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol v1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, SUPPORTED);
      const listeners = new Set<(e: ProviderEvent) => void>();
      const sessions = new Map<string, {
        bridge: BridgeClient; config: ProviderSessionConfig; nativeId: string;
        active?: string; configuring: boolean; canceled: boolean; closing: boolean; opening: boolean; permissions: Set<string>; commands: Set<string>;
      }>();
      const owned = new Set<BridgeClient>();
      let closed = false;
      const emit = (event: ProviderEvent) => {
        if (!closed) for (const listener of listeners) listener(event);
      };
      const startBridge = (config?: ProviderSessionConfig) => {
        const b = factory(environment(request.launch, config), config?.cwd, request.launch?.command, request.launch?.args);
        owned.add(b);
        return b;
      };
      const closeBridge = async (bridge: BridgeClient) => { await bridge.close(); owned.delete(bridge); };
      const clearPermissions = (sessionId: string, state: { permissions: Set<string> }) => {
        for (const id of state.permissions) emit({ type: "session.permission_resolved", sessionId, permissionId: id });
        state.permissions.clear();
      };
      const session = (id: string) => {
        const state = sessions.get(id);
        if (!state || state.closing || state.opening) throw new Error("Hermes session is not ready");
        return state;
      };
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() {
          if (closed) return;
          closed = true;
          for (const s of sessions.values()) s.closing = true;
          await Promise.all([...owned].map(closeBridge));
          sessions.clear(); listeners.clear();
        },
        async send(input: ProviderInput) {
          if (closed) throw new Error("Connection closed");
          try {
            requireProviderCapabilities(capabilities, input);
            switch (input.type) {
              case "catalog": {
                const bridge = startBridge();
                try {
                  const ready = await bridge.ready;
                  if (closed) return;
                  emit({ type: "catalog", requestId: input.requestId, catalog: ready.catalog });
                } finally { await closeBridge(bridge); }
                return;
              }
              case "session.open": {
                if (sessions.has(input.sessionId)) throw new Error("Session is already open");
                const c = input.config;
                if (Object.keys(c.mcpServers).length) throw new Error("Configure MCP in Hermes config.yaml; Paseo-injected MCP is not supported");
                if (c.mode || c.thinkingOption || Object.keys(c.settings).length || Object.keys(c.providerOptions ?? {}).length)
                  throw new Error("Use Hermes config.yaml for modes, reasoning and provider options");
                if (c.persist && !capabilities.includes("session.persistence")) throw new Error("Session persistence was not negotiated");
                const nativeId = input.persistence ? resumeId(input.persistence) : randomUUID();
                if ([...sessions.values()].some(s => s.nativeId === nativeId)) throw new Error("This native session is already open in this connection");
                const bridge = startBridge(c);
                const state = { bridge, config: c, nativeId, active: undefined as string | undefined,
                  configuring: false, canceled: false, closing: false, opening: true, permissions: new Set<string>(), commands: new Set<string>() };
                sessions.set(input.sessionId, state);
                const sessionId = input.sessionId;
                bridge.onExit(error => {
                  if (state.closing || state.opening || closed) return;
                  clearPermissions(sessionId, state);
                  if (state.active) {
                    emit({ type: "session.turn", sessionId, turnId: state.active, state: "failed", error: { message: error.message } });
                    state.active = undefined;
                  }
                  emit({ type: "session.runtime_failed", sessionId, error: { message: error.message } });
                  state.closing = true;
                });
                bridge.onEvent(e => {
                  if (state.closing || state.opening || closed) return;
                  if (e.type === "turn_started") {
                    state.active = e.turnId; state.canceled = false;
                    emit({ type: "session.turn", sessionId, turnId: e.turnId, state: "started" });
                  }
                  if (e.type === "config") {
                    state.config = { ...state.config, model: e.config.model };
                    emit({ type: "session.config", sessionId, config: e.config });
                  }
                  if (e.type === "item") emit({ type: "timeline.item", sessionId, item: e.item as ProviderTimelineItem });
                  if (e.type === "permission") {
                    if (!capabilities.includes("permission")) {
                      bridge.send({ type: "permission", permissionId: e.id, response: { behavior: "deny" } });
                      return;
                    }
                    state.permissions.add(e.id);
                    emit({ type: "session.permission", sessionId, request: {
                      id: e.id, name: "Hermes approval", kind: "tool", title: "Hermes 请求批准",
                      description: e.description, detail: { type: "shell", command: e.command, cwd: c.cwd },
                      actions: [{ id: "once", label: "Allow once", behavior: "allow" }, { id: "deny", label: "Deny", behavior: "deny" }],
                    } });
                  }
                  if (e.type === "permission_resolved" && state.permissions.delete(e.id))
                    emit({ type: "session.permission_resolved", sessionId, permissionId: e.id });
                  if (e.type === "turn_done" && e.turnId === state.active) {
                    clearPermissions(sessionId, state);
                    const terminal = state.canceled ? "canceled" : e.state;
                    emit({ type: "session.turn", sessionId, turnId: state.active!, state: terminal,
                      ...(terminal === "failed" ? { error: { message: e.error || "Hermes turn failed" } } : {}) });
                    state.active = undefined;
                  }
                  if (e.type === "error" || e.type === "fatal") {
                    clearPermissions(sessionId, state);
                    if (state.active) {
                      emit({ type: "session.turn", sessionId, turnId: state.active, state: "failed", error: { message: e.error } });
                      state.active = undefined;
                    } else emit({ type: "session.runtime_failed", sessionId, error: { message: e.error } });
                  }
                });
                try {
                  await bridge.ready;
                  if (closed || state.closing) return;
                  const openedPromise = bridge.waitFor("opened");
                  const [opened] = await Promise.all([openedPromise, Promise.resolve().then(() =>
                    bridge.send({ type: "open", nativeId, cwd: c.cwd, model: c.model, persist: c.persist,
                      systemPrompt: c.systemPrompt, resume: !!input.persistence, replay: input.history === "replay" }))]);
                  if (closed || state.closing) return;
                  state.opening = false;
                  emit({ type: "session.opened", requestId: input.requestId, sessionId, capabilities,
                    restoration: "core", cwd: c.cwd, ...(c.persist ? { persistence: persistence(nativeId) } : {}) });
                  emit({ type: "session.config", sessionId, config: { model: opened.model, models: opened.catalog.models, modes: [], thinkingOptions: [], settings: [] } });
                  state.commands = new Set((opened.commands || []).map((c: { name: string }) => c.name));
                  if (capabilities.includes("prompt.command")) {
                    emit({ type: "session.commands", sessionId, commands: opened.commands || [] });
                  }
                  for (const item of opened.timeline || []) emit({ type: "timeline.item", sessionId, item });
                  emit({ type: "session.ready", requestId: input.requestId, sessionId });
                } catch (error) {
                  state.closing = true; sessions.delete(sessionId); await closeBridge(bridge); throw error;
                }
                return;
              }
              case "session.configure": {
                const state = session(input.sessionId);
                const changes = input.changes;
                // Validate the entire request before changing anything. Null/empty values
                // for unavailable options are harmless clears, not mode/reasoning support.
                if (changes.mode != null || changes.thinkingOption != null || Object.keys(changes.settings ?? {}).length)
                  throw new Error("Hermes Direct session.configure supports model changes only; configure modes/reasoning in Hermes config.yaml");
                if (state.active || state.configuring) throw new Error("Hermes is busy; wait or stop the active turn before changing models");
                if (changes.model === undefined) {
                  emit({ type: "request.completed", requestId: input.requestId });
                  return;
                }
                if (changes.model !== null && !changes.model.trim()) throw new Error("Model ID cannot be empty");
                state.configuring = true;
                try {
                  const done = state.bridge.waitFor("configure_result", 180_000, input.requestId);
                  const [result] = await Promise.all([done, Promise.resolve().then(() => state.bridge.send({
                    type: "configure", requestId: input.requestId, model: changes.model,
                  }))]);
                  if (!result.ok) throw new Error(result.error || "Hermes model switch failed");
                  emit({ type: "request.completed", requestId: input.requestId });
                } finally { state.configuring = false; }
                return;
              }
              case "session.prompt": {
                const state = session(input.sessionId);
                if (state.configuring) throw new Error("Hermes is changing models; wait before sending another prompt");
                const command = input.prompt.delivery === "steer" ? {
                  name: "steer", arguments: input.prompt.input.type === "message"
                    ? input.prompt.input.content.map(part => {
                        if (part.type !== "text") throw new Error("Steering supports text only; use a normal image prompt");
                        return part.text;
                      }).join("\n") : (() => { throw new Error("Steering requires a text message"); })(),
                } : parseSlash(input.prompt);
                if (command && ((input.prompt.delivery !== "steer" && !capabilities.includes("prompt.command")) || !state.commands.has(command.name)))
                  throw new Error(`Unsupported slash command: /${command.name}. Use /help.`);
                if (command && ["steer", "queue", "goal", "subgoal"].includes(command.name)) {
                  const requestId = randomUUID();
                  const active = state.active;
                  const done = state.bridge.waitFor("control_result", 180_000, requestId);
                  const [result] = await Promise.all([done, Promise.resolve().then(() => state.bridge.send({ type: "control", requestId, command }))]);
                  if (!result.ok) throw new Error(result.error || "Hermes rejected command");
                  emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
                    result: command.name === "steer" && active ? { type: "steer", turnId: active } : { type: "completed" } });
                  return;
                }
                if (command?.name === "stop") {
                  if (command.arguments) throw new Error("Usage: /stop");
                  if (state.active) state.canceled = true;
                  state.bridge.send({ type: "interrupt" });
                  emit({ type: "timeline.item", sessionId: input.sessionId, item: { id: randomUUID(), type: "notification", level: "info", message: state.active ? "Stop requested; waiting for Hermes to finish canceling." : "No active turn." } });
                  emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "completed" } });
                  return;
                }
                if (state.active) throw new Error("Hermes is busy; wait or interrupt the active turn before sending again");
                const prepared = command ? { text: `/${command.name}${command.arguments ? " " + command.arguments : ""}`, content: "", imageCount: 0 }
                  : await preparePrompt(input.prompt.input.type === "message" ? input.prompt.input.content : []);
                // Reading uploads is asynchronous; recheck admission after preparation.
                if (closed || state.closing || state.active || state.configuring) throw new Error("Hermes is busy or the session has closed");
                if (prepared.imageCount && !capabilities.includes("prompt.image")) throw new Error("Image capability was not negotiated");
                const turnId = randomUUID();
                state.active = turnId; state.canceled = false;
                try { state.bridge.send({ type: "prompt", text: prepared.text, content: prepared.content, command, turnId, clientMessageId: input.prompt.clientMessageId }); }
                catch (e) { state.active = undefined; throw e; }
                emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
                emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
                return;
              }
              case "session.interrupt": {
                const state = session(input.sessionId);
                if (state.active) {
                  state.canceled = true;
                  const done = state.bridge.waitFor("interrupted", 10_000);
                  await Promise.all([done, Promise.resolve().then(() =>
                    state.bridge.send({ type: "interrupt", requestId: input.requestId }))]);
                }
                emit({ type: "request.completed", requestId: input.requestId });
                return;
              }
              case "session.permission": {
                const state = session(input.sessionId);
                if (!state.permissions.has(input.permissionId)) throw new Error("Unknown or expired approval");
                state.bridge.send({ type: "permission", permissionId: input.permissionId, response: input.response });
                return;
              }
              case "session.close": {
                const state = sessions.get(input.sessionId);
                if (state) {
                  state.closing = true;
                  clearPermissions(input.sessionId, state);
                  if (state.active) emit({ type: "session.turn", sessionId: input.sessionId, turnId: state.active, state: "canceled" });
                  await closeBridge(state.bridge); sessions.delete(input.sessionId);
                }
                emit({ type: "session.closed", sessionId: input.sessionId });
                emit({ type: "request.completed", requestId: input.requestId });
                return;
              }
              default: throw new Error(`Unsupported operation: ${input.type}`);
            }
          } catch (error) {
            const detail = { message: error instanceof Error ? error.message : String(error) };
            if (input.type === "session.prompt") emit({ type: "session.prompt_result", sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: detail } });
            else if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: detail });
            else throw error;
          }
        },
      };
    },
  };
}

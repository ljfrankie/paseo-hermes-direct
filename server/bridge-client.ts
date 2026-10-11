import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { BRIDGE_SOURCE } from "./generated-bridge.js";

export type WireEvent = { type: string; [key: string]: any };
export interface BridgeClient {
  ready: Promise<WireEvent>;
  send(message: Record<string, unknown>): void;
  onEvent(listener: (event: WireEvent) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  waitFor(type: string, timeout?: number, requestId?: string): Promise<WireEvent>;
  close(): Promise<void>;
}
export function launchBridge(env: Record<string, string>, cwd?: string, command?: string, args: readonly string[] = []): BridgeClient {
  const python = env.PASEO_HERMES_PYTHON || command || "python3";
  const child = spawn(python, [...args, "-u", "-c", BRIDGE_SOURCE], { env: { ...env, PYTHONUNBUFFERED: "1" }, cwd, stdio: "pipe" });
  return processBridge(child);
}
export function processBridge(child: ChildProcessWithoutNullStreams): BridgeClient {
  const events = new Set<(e: WireEvent) => void>();
  const exits = new Set<(e: Error) => void>();
  let ended: Error | undefined;
  let closing = false;
  let diagnostics = "";
  const fail = (error: Error) => {
    if (ended) return;
    ended = error;
    for (const listener of exits) listener(error);
  };
  const readline = createInterface({ input: child.stdout });
  readline.on("line", line => {
    try {
      const event = JSON.parse(line) as WireEvent;
      if (typeof event.type !== "string") throw new Error("missing event type");
      for (const listener of events) listener(event);
    } catch (e) {
      fail(new Error(`Invalid Hermes bridge event: ${String(e)}`));
      child.kill();
    }
  });
  child.stderr.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-4096); });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(closing ? "Bridge closed" : `Hermes bridge exited (${code ?? signal}). ${diagnostics}`));
    readline.close();
  });
  const client: BridgeClient = {
    ready: null as unknown as Promise<WireEvent>,
    send(message) {
      if (ended || closing) throw ended || new Error("Bridge is closing");
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    onEvent(listener) { events.add(listener); return () => events.delete(listener); },
    onExit(listener) {
      if (ended) { queueMicrotask(() => listener(ended!)); return () => {}; }
      exits.add(listener); return () => exits.delete(listener);
    },
    waitFor(type, timeout = 60_000, requestId) {
      return new Promise((resolve, reject) => {
        let offEvent = () => {}, offExit = () => {};
        const cleanup = () => { clearTimeout(timer); offEvent(); offExit(); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Hermes bridge ${type} timeout`)); }, timeout);
        offEvent = client.onEvent(e => {
          if (e.type === type && (!requestId || e.requestId === requestId)) { cleanup(); resolve(e); }
          else if (e.type === "error" || e.type === "fatal") { cleanup(); reject(new Error(e.error)); }
        });
        offExit = client.onExit(e => { cleanup(); reject(e); });
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => { clearTimeout(kill); resolve(); });
        child.stdin.end(JSON.stringify({ type: "close" }) + "\n");
      });
    },
  };
  client.ready = client.waitFor("ready");
  return client;
}

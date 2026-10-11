"""One isolated Hermes process per Paseo session. stdout is NDJSON only."""
import contextlib
import inspect
import importlib.util
from collections import Counter
import json
import logging
import os
import queue
from pathlib import Path
import sys
import threading
import time
import uuid

WIRE = sys.stdout
sys.stdout = sys.stderr  # Hermes, plugins and tools must not corrupt the protocol.
LOCK = threading.Lock()

def emit(kind, **fields):
    with LOCK:
        WIRE.write(json.dumps({"type": kind, **fields}, ensure_ascii=False, default=str) + "\n")
        WIRE.flush()


def bootstrap():
    root = os.environ.get("PASEO_HERMES_ROOT")
    if root:
        sys.path.insert(0, str(Path(root).expanduser().resolve()))
    import hermes_bootstrap
    hermes_bootstrap.harden_import_path()
    from hermes_cli.env_loader import load_hermes_dotenv
    from hermes_constants import get_hermes_home
    load_hermes_dotenv(hermes_home=get_hermes_home())


def config_catalog():
    from hermes_cli.config import load_config
    cfg = load_config()
    mc = cfg.get("model") or {}
    model = str(mc.get("default") or "") if isinstance(mc, dict) else str(mc)
    override = os.environ.get("PASEO_HERMES_MODEL")
    model = override or model
    choices = [s.strip() for s in os.environ.get("PASEO_HERMES_MODELS", "").split(",") if s.strip()]
    if model and model not in choices:
        choices.insert(0, model)
    if not choices:
        choices = ["default"]
    return cfg, model, {"models": [{"id": m, "label": m, "isDefault": m == (model or "default")} for m in choices],
                         "modes": [], "defaultModel": model or "default"}


class Bridge:
    def __init__(self):
        self.agent = None
        self.history = []
        self.timeline = []
        self.thread = None
        self.interrupted = threading.Event()
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.persist = False
        self.session_id = None
        self.model = None
        self.busy = False
        self.session_lock = None
        self.requested_provider = None
        self.scheduler_lock = threading.RLock()
        self.jobs = []
        self.queue_paused = False
        self.halted = threading.Event()
        self.goal_halted = threading.Event()
        self.goals = None
        self.in_model = False
        self.waiting_goal = False
        self.closing = False
        self.controls = queue.Queue()
        self.control_pending = 0

    def snapshot_path(self):
        from hermes_constants import get_hermes_home
        # UUID validation prevents path traversal through persisted Paseo metadata.
        sid = str(uuid.UUID(self.session_id))
        return get_hermes_home() / "paseo-direct" / (sid + ".json")

    def save(self):
        with self.scheduler_lock:
            self._save()

    def _save(self):
        if not self.persist:
            return
        path = self.snapshot_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        payload = {"version": 1, "history": self.history, "timeline": self.timeline, "cwd": self.cwd, "model": self.model, "provider": self.requested_provider, "queue": self.jobs}
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, default=str)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def item(self, item):
        existing = next((i for i, x in enumerate(self.timeline) if x["id"] == item["id"]), None)
        if existing is None:
            self.timeline.append(item.copy())
        else:
            self.timeline[existing] = item.copy()
        emit("item", item=item)

    def open(self, msg):
        cfg, default, catalog = config_catalog()
        self.session_id = str(uuid.UUID(msg["nativeId"]))
        self.cwd = str(Path(msg["cwd"]).resolve(strict=True))
        self.persist = bool(msg.get("persist"))
        self.system_prompt = msg.get("systemPrompt")
        if self.persist:
            import fcntl
            path = self.snapshot_path()
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600)
            self.session_lock = os.fdopen(fd, "w")
            try:
                fcntl.flock(self.session_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("Hermes Direct session is already in use by another process")
        selected = msg.get("model")
        self.model = selected if selected and selected != "default" else default
        if msg.get("resume"):
            if not self.persist:
                raise ValueError("Cannot resume an ephemeral session")
            saved = json.loads(self.snapshot_path().read_text(encoding="utf-8"))
            if saved.get("version") != 1:
                raise ValueError("Unsupported snapshot version")
            if saved["cwd"] != self.cwd:
                raise ValueError("Session cwd changed; resume in its original workspace")
            self.requested_provider = saved.get("provider")
            self.history = saved["history"]
            self.timeline = saved["timeline"]
            self.jobs = saved.get("queue", [])
            self.queue_paused = bool(self.jobs)  # Restore pending work, never replay it silently.
            if not selected:
                self.model = saved.get("model") or self.model
        from run_agent import AIAgent
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names
        from hermes_constants import resolve_reasoning_config
        from agent.skill_utils import parse_config_string_list
        runtime = resolve_runtime_provider(requested=self.requested_provider or ((cfg.get("model") or {}).get("provider")
                                           if isinstance(cfg.get("model"), dict) else None),
                                           target_model=self.model or None)
        tools = _get_platform_tools(cfg, "cli")
        mcp = enabled_mcp_server_names(cfg)
        tools = sorted((tools - mcp) | {"mcp-" + n for n in tools & mcp})
        kwargs = {"model": self.model, "cwd": self.cwd, "platform": "cli", "quiet_mode": True,
                  "session_id": self.session_id, "enabled_toolsets": tools,
                  "disabled_toolsets": parse_config_string_list((cfg.get("agent") or {}).get("disabled_toolsets")) or None,
                  "reasoning_config": resolve_reasoning_config(cfg, self.model),
                  "skip_background_review": True,
                  "stream_delta_callback": self.text_delta, "reasoning_callback": self.reasoning_delta,
                  "tool_start_callback": self.tool_start, "tool_complete_callback": self.tool_complete}
        for key in ("provider", "api_mode", "base_url", "api_key", "credential_pool", "command", "args", "request_overrides"):
            if runtime.get(key) is not None:
                kwargs[key] = runtime[key]
        if self.persist:
            from hermes_state import SessionDB
            self.db = SessionDB()
            kwargs["session_db"] = self.db
        params = inspect.signature(AIAgent).parameters
        required = ("stream_delta_callback", "reasoning_callback", "tool_start_callback", "tool_complete_callback", "cwd")
        if any(k not in params for k in required):
            raise RuntimeError("This Hermes version lacks required native callbacks/cwd. Update Hermes first.")
        kwargs = {k: v for k, v in kwargs.items() if k in params}
        # Prime Hermes MCP discovery using its own configuration; Paseo-injected MCP is rejected by provider.
        from hermes_cli.mcp_startup import ensure_mcp_discovery_before_agent_build
        ensure_mcp_discovery_before_agent_build(logger=logging.getLogger("paseo-hermes-direct"))
        self.agent = AIAgent(**kwargs)
        self.agent._print_fn = lambda *a, **kw: print(*a, file=sys.stderr, **{k: v for k, v in kw.items() if k != "file"})
        if self.model and self.model not in {m["id"] for m in catalog["models"]}:
            catalog["models"].append({"id": self.model, "label": self.model})
        if importlib.util.find_spec("hermes_cli.goal_command") is not None:
            from hermes_cli.goals import GoalManager
            budget = int((cfg.get("goals") or {}).get("max_turns", 20))
            self.goals = GoalManager(self.session_id, default_max_turns=budget)
            if msg.get("resume") and self.goals.is_active():
                self.goals.pause(reason="direct-session-restored")
        threading.Thread(target=self.control_worker, daemon=True).start()
        if self.goals is not None:
            threading.Thread(target=self.poll_goal_wait, daemon=True).start()
        self.save()
        emit("opened", nativeId=self.session_id, model=self.model or "default", catalog=catalog,
             timeline=self.timeline if msg.get("replay") else [], commands=self.command_catalog())

    def command_catalog(self):
        commands = [
            {"name": "help", "description": "列出可用命令"},
            {"name": "tools", "description": "查看当前会话工具"},
            {"name": "context", "description": "查看历史、图片及上下文用量"},
            {"name": "model", "description": "查看或切换当前会话模型", "argumentHint": "[model 或 provider:model]"},
            {"name": "version", "description": "查看 Hermes 版本"},
            {"name": "stop", "description": "停止正在执行的回合"},
        ]
        if hasattr(self.agent, "reset_session_state"):
            commands.append({"name": "reset", "description": "清空模型上下文，保留显示时间线"})
        if importlib.util.find_spec("agent.conversation_compression_manual") is not None:
            commands.extend([
                {"name": "compress", "description": "使用 Hermes 压缩上下文", "argumentHint": "[here N | focus] [--preview]"},
                {"name": "compact", "description": "/compress 的别名", "argumentHint": "[here N | focus] [--preview]"},
            ])
        if callable(getattr(self.agent, "steer", None)):
            commands.append({"name": "steer", "description": "当前工具批次结束后加入指令", "argumentHint": "<text>"})
        commands.append({"name": "queue", "description": "排队或管理待执行消息", "argumentHint": "<text> | list | pause | resume | clear | remove N"})
        if self.goals is not None:
            commands.extend([
                {"name": "goal", "description": "设置和管理持续目标", "argumentHint": "<text> | status | show | pause | resume | clear | draft <text>"},
                {"name": "subgoal", "description": "管理目标验收条件", "argumentHint": "<text> | list | remove N | clear"},
            ])
        return commands

    def publish_config(self):
        _, _, catalog = config_catalog()
        models = catalog["models"]
        model = self.model or "default"
        if model not in {m["id"] for m in models}:
            models.append({"id": model, "label": model})
        emit("config", config={"model": model, "models": models, "modes": [], "thinkingOptions": [], "settings": []})

    def execute_command(self, name, args, turn_id):
        if name == "compact":
            name = "compress"
        if name not in {c["name"] for c in self.command_catalog()}:
            raise ValueError("Unsupported slash command: /" + name)
        if args and name not in {"model", "compress"}:
            raise ValueError("Usage: /" + name)
        if name == "help":
            return "可用命令：\n" + "\n".join("/" + c["name"] + " " + c.get("argumentHint", "") + " — " + c["description"] for c in self.command_catalog())
        if name == "version":
            from hermes_cli.version_info import get_version_info
            return "Hermes Agent v" + str(get_version_info().derived_version)
        if name == "tools":
            tools = getattr(self.agent, "tools", []) or []
            lines = []
            for tool in tools:
                fn = tool.get("function", tool)
                lines.append(str(fn.get("name", "?")) + ": " + str(fn.get("description", ""))[:160])
            return "当前工具（" + str(len(lines)) + "）：\n" + "\n".join(lines)
        if name == "context":
            counts = Counter(m.get("role", "unknown") for m in self.history)
            images = sum(1 for m in self.history for part in (m.get("content") if isinstance(m.get("content"), list) else []) if part.get("type") in {"image_url", "input_image"})
            from agent.model_metadata import estimate_request_tokens_rough
            tokens = estimate_request_tokens_rough(self.history, system_prompt=getattr(self.agent, "_cached_system_prompt", "") or "", tools=getattr(self.agent, "tools", None))
            compressor = getattr(self.agent, "context_compressor", None)
            window = getattr(compressor, "context_length", 0) or 0
            return (f"历史消息：{len(self.history)}，图片：{images}\n"
                    + ", ".join(f"{role}: {count}" for role, count in counts.items())
                    + f"\n估算上下文：{tokens} tokens" + (f" / {window}" if window else "")
                    + f"\n模型：{self.model or 'default'}\nProvider：{getattr(self.agent, 'provider', 'auto')}")
        if name == "reset":
            with self.scheduler_lock:
                self.jobs.clear()
                if self.goals is not None:
                    self.goals.clear()
            previous = list(self.history)
            self.agent.reset_session_state(previous_messages=previous)
            db = getattr(self.agent, "_session_db", None)
            if db:
                db.clear_messages(getattr(self.agent, "session_id", self.session_id))
            self.history = []
            self.save()
            return "模型对话上下文已清空；显示时间线保留。"
        if name == "model":
            if not args:
                return f"模型：{self.model or 'default'}\nProvider：{getattr(self.agent, 'provider', 'auto')}"
            if not hasattr(self.agent, "switch_model"):
                raise RuntimeError("Installed Hermes does not support native model switching")
            from hermes_cli.config import load_config, get_compatible_custom_providers
            from hermes_cli.model_switch import switch_model
            from hermes_cli.models import parse_model_input
            cfg = load_config()
            explicit, model_input = parse_model_input(args, "")
            result = switch_model(
                raw_input=model_input, explicit_provider=explicit,
                current_provider=getattr(self.agent, "provider", None) or "openrouter", current_model=self.model or "",
                current_base_url=str(getattr(self.agent, "base_url", "") or ""),
                current_api_key=str(getattr(self.agent, "api_key", "") or ""),
                user_providers=cfg.get("providers") if isinstance(cfg.get("providers"), dict) else {},
                custom_providers=get_compatible_custom_providers(cfg))
            if not result.success:
                raise ValueError(result.error_message or "Cannot switch to " + args)
            self.agent.switch_model(result.new_model, result.target_provider, api_key=result.api_key,
                                    base_url=result.base_url, api_mode=result.api_mode,
                                    capabilities=result.runtime_capabilities)
            self.model = result.new_model
            self.requested_provider = result.target_provider
            self.save()
            self.publish_config()
            return f"当前会话模型已切换：{self.model} ({self.requested_provider})"
        if name == "compress":
            from agent.conversation_compression_manual import compress_now, parse_compress_args, render_compress_result, AGGRESSIVE_UNSUPPORTED
            from agent.conversation_compression import finalize_context_engine_compression_notification
            if not self.history:
                return "对话为空，无需压缩。"
            request = parse_compress_args(args)
            if request.aggressive:
                raise ValueError(AGGRESSIVE_UNSUPPORTED)
            item_id = str(uuid.uuid4())
            self.item({"id": item_id, "type": "compaction", "status": "loading", "trigger": "manual"})
            db = getattr(self.agent, "_session_db", None)
            try:
                # Keep this bridge's stable native ID, as Hermes's headless adapter does.
                self.agent._session_db = None
                result = compress_now(self.agent, self.history, request, system_message=self.system_prompt, task_id=turn_id)
                if result.status == "compressed":
                    self.history = result.after_messages
                    self.save()
                    finalize_context_engine_compression_notification(self.agent, committed=True)
                return "\n".join(render_compress_result(result))
            except Exception:
                finalize_context_engine_compression_notification(self.agent, committed=False)
                raise
            finally:
                self.agent._session_db = db
                self.item({"id": item_id, "type": "compaction", "status": "completed", "trigger": "manual"})
        raise ValueError("Command must be handled by provider: /" + name)

    def run_command_turn(self, msg):
        turn_id = msg["turnId"]
        try:
            self.item({"id": msg["clientMessageId"], "type": "user_message", "text": msg["text"], "clientMessageId": msg["clientMessageId"]})
            # Compression/model resolution must see the same cwd and session scope as regular turns.
            with contextlib.ExitStack() as stack:
                from gateway.session_context import set_session_vars, clear_session_vars
                tokens = set_session_vars(session_key=self.session_id, session_id=self.session_id, cwd=self.cwd, cron_session="")
                stack.callback(clear_session_vars, tokens)
                from agent.runtime_cwd import set_session_cwd
                set_session_cwd(self.cwd)
                command = msg["command"]
                result = self.execute_command(command["name"], command.get("arguments", ""), turn_id)
            self.item({"id": str(uuid.uuid4()), "type": "assistant_message", "text": result})
            self.save()
            self.finish(turn_id, "canceled" if self.interrupted.is_set() else "completed")
        except Exception as exc:
            self.finish(turn_id, "canceled" if self.interrupted.is_set() else "failed", str(exc))

    def text_delta(self, delta):
        if delta is None:
            self.text_id = None
            self.reason_id = None
            return
        if not delta:
            return
        if self.text_id is None:
            self.text_id, self.text = str(uuid.uuid4()), ""
        self.text += str(delta)
        self.turn_streamed = True
        self.item({"id": self.text_id, "type": "assistant_message", "text": self.text})

    def reasoning_delta(self, delta):
        if not delta:
            return
        if self.reason_id is None:
            self.reason_id, self.reason = str(uuid.uuid4()), ""
        self.reason += str(delta)
        self.item({"id": self.reason_id, "type": "reasoning", "text": self.reason})

    def tool_start(self, call_id, name, args):
        self.text_id = self.reason_id = None
        self.item({"id": str(call_id), "callId": str(call_id), "type": "tool_call", "name": name,
                   "status": "running", "error": None, "detail": {"type": "unknown", "input": args, "output": None}})

    def tool_complete(self, call_id, name, args, result):
        self.item({"id": str(call_id), "callId": str(call_id), "type": "tool_call", "name": name,
                   "status": "completed", "error": None, "detail": {"type": "unknown", "input": args, "output": result}})

    def approval(self, command, description, **kwargs):
        request_id = str(uuid.uuid4())
        waiter, answer = threading.Event(), {}
        with self.pending_lock:
            self.pending[request_id] = (waiter, answer)
        try:
            emit("permission", id=request_id, command=command, description=description)
            timeout = float(os.environ.get("PASEO_HERMES_APPROVAL_TIMEOUT", "300"))
            waiter.wait(timeout)
            return "once" if not self.interrupted.is_set() and answer.get("behavior") == "allow" else "deny"
        finally:
            with self.pending_lock:
                self.pending.pop(request_id, None)
            emit("permission_resolved", id=request_id)

    def permission(self, msg):
        with self.pending_lock:
            pending = self.pending.get(msg["permissionId"])
            if pending:
                pending[1].update(msg["response"])
                pending[0].set()

    def interrupt(self):
        self.halted.set()
        self.queue_paused = True
        self.interrupted.set()
        if self.goals is not None and not self.busy and not self.closing:
            self.control({"requestId": str(uuid.uuid4()), "command": {"name": "goal", "arguments": "pause"}})
        if self.agent and self.thread and self.thread.is_alive():
            self.agent.interrupt()
        with self.pending_lock:
            for waiter, _ in self.pending.values():
                waiter.set()

    def notice(self, text):
        self.item({"id": str(uuid.uuid4()), "type": "notification", "level": "info", "message": text})

    def enqueue(self, text, *, goal=False):
        self.jobs.append({"type": "prompt", "text": text, "content": text,
                          "turnId": str(uuid.uuid4()), "clientMessageId": str(uuid.uuid4()), "goal": goal})

    def drain(self):
        # Caller owns scheduler_lock. Every continuation is a normal serial native turn.
        if self.busy or self.queue_paused or self.closing or self.halted.is_set() or self.control_pending:
            return
        if self.jobs:
            job = self.jobs.pop(0)
            self.save()  # Remove before execution: a crash must not execute it twice.
            emit("turn_started", turnId=job["turnId"])
            self.prompt(job)

    def finish(self, turn_id, state, error=""):
        with self.scheduler_lock:
            self.in_model = False
            self.busy = False
            if state != "completed":
                self.halted.set()
                self.queue_paused = True
            if self.halted.is_set():
                self.jobs = [j for j in self.jobs if not j.get("goal")]
            if self.halted.is_set() and self.goals is not None and self.goals.is_active():
                self.goals.pause(reason="direct-stopped")
            self.save()
            emit("turn_done", turnId=turn_id, state=state, error=error)
            self.drain()

    def control_worker(self):
        while not self.closing:
            try:
                work = self.controls.get(timeout=0.5)
            except queue.Empty:
                continue
            work()

    def control(self, msg):
        command = msg["command"]
        name, args = command["name"], command.get("arguments", "").strip()
        # Stop scheduling immediately even if a judge/draft call currently owns the goal lock.
        if name == "goal" and (args.lower() in {"clear", "stop", "done"} or args.lower().split(" ")[0] == "pause"):
            self.goal_halted.set()
        def work():
            tokens = None
            try:
                from gateway.session_context import set_session_vars, clear_session_vars
                from agent.runtime_cwd import set_session_cwd
                tokens = set_session_vars(session_key=self.session_id, session_id=self.session_id, cwd=self.cwd, cron_session="")
                set_session_cwd(self.cwd)
                with self.scheduler_lock:
                    if self.closing:
                        raise RuntimeError("Session is closing")
                    if name == "steer":
                        if not args:
                            raise ValueError("Usage: /steer <text>")
                        if not self.in_model or self.interrupted.is_set():
                            raise ValueError("/steer requires an active model turn; use /queue when idle")
                        if not self.agent.steer(args):
                            raise RuntimeError("Hermes rejected steering")
                        output = "Steering accepted; applied after the current tool batch."
                    elif name == "queue":
                        if args.lower() in {"", "list"}:
                            output = ("Queue paused" if self.queue_paused else "Queue ready") + ":\n" + "\n".join(f"{i+1}. {j['text']}" for i,j in enumerate(self.jobs))
                        elif args.lower() == "clear":
                            self.jobs.clear()
                            output = "Queue cleared."
                        elif args.lower() == "pause":
                            self.queue_paused = True
                            output = "Queue paused; current turn continues."
                        elif args.lower() == "resume":
                            self.queue_paused = False
                            self.halted.clear()
                            output = "Queue resumed."
                        elif args.lower().startswith("remove "):
                            index = int(args.split(None, 1)[1])
                            if index < 1 or index > len(self.jobs):
                                raise ValueError("Queue index out of range")
                            self.jobs.pop(index-1)
                            output = "Queued message removed."
                        else:
                            text = args[3:].strip() if args.startswith("-- ") else args
                            if not text:
                                raise ValueError("Usage: /queue <text>")
                            self.enqueue(text)
                            output = f"Queued ({len(self.jobs)} pending)."
                    elif name == "goal":
                        if self.goals is None:
                            raise RuntimeError("This Hermes version lacks native goal support")
                        # Native gates bypass the usual tool approval callback; do not expose that path.
                        from hermes_cli.goal_command import dispatch_goal_command
                        from hermes_cli.goals import last_user_message_content
                        result = dispatch_goal_command(self.goals, args,
                            authorize_gate=lambda: "Shell quality gates are not supported in Direct; use verification criteria/subgoals.",
                            last_user_message=last_user_message_content(self.history), progress=self.notice)
                        if result.error:
                            raise ValueError(result.output)
                        if result.clear_pending or result.prompt:
                            self.waiting_goal = False
                            self.jobs = [j for j in self.jobs if not j.get("goal")]
                        if result.prompt:
                            self.goal_halted.clear()
                            self.halted.clear()
                            self.queue_paused = False
                            self.enqueue(result.prompt, goal=True)
                        if args.lower() == "unwait" and self.goals.is_active():
                            prompt = self.goals.next_continuation_prompt()
                            if prompt:
                                self.enqueue(prompt, goal=True)
                        if args.lower().split(" ")[0] == "wait":
                            self.waiting_goal = True
                            self.jobs = [j for j in self.jobs if not j.get("goal")]
                        output = result.output
                    elif name == "subgoal":
                        if self.goals is None:
                            raise RuntimeError("This Hermes version lacks native goal support")
                        if args.lower() in {"", "list"}:
                            output = self.goals.render_subgoals()
                        elif args.lower() == "clear":
                            output = f"Cleared {self.goals.clear_subgoals()} subgoals."
                        elif args.lower().startswith("remove "):
                            output = "Removed: " + self.goals.remove_subgoal(int(args.split(None, 1)[1]))
                        else:
                            output = "Added: " + self.goals.add_subgoal(args)
                    else:
                        raise ValueError("Unsupported control command")
                    self.notice("/" + name + " " + args + "\n" + output)
                    self.save()
                    emit("control_result", requestId=msg["requestId"], ok=True)
                    self.drain()
            except Exception as exc:
                emit("control_result", requestId=msg["requestId"], ok=False, error=str(exc))
            finally:
                if tokens is not None:
                    clear_session_vars(tokens)
                with self.scheduler_lock:
                    self.control_pending -= 1
                    self.drain()
        self.control_pending += 1
        self.controls.put(work)

    def poll_goal_wait(self):
        while not self.closing:
            time.sleep(0.5)
            with self.scheduler_lock:
                if (self.waiting_goal and not self.busy and self.goals.is_active()
                        and not self.goals.is_waiting() and not self.halted.is_set()
                        and not self.goal_halted.is_set()):
                    self.waiting_goal = False
                    prompt = self.goals.next_continuation_prompt()
                    if prompt:
                        self.enqueue(prompt, goal=True)
                        self.save()
                        self.drain()

    def goal_after_turn(self, final, turn_id):
        with self.scheduler_lock:
            if self.goals is None or not self.goals.is_active() or self.halted.is_set() or self.goal_halted.is_set():
                return
            from gateway.session_context import set_session_vars, clear_session_vars
            from agent.runtime_cwd import set_session_cwd
            from hermes_cli.goals import gather_background_processes, count_active_delegations
            tokens = set_session_vars(session_key=self.session_id, session_id=self.session_id, cwd=self.cwd, cron_session="")
            try:
                set_session_cwd(self.cwd)
                decision = self.goals.evaluate_after_turn(final, background_processes=gather_background_processes(owner_task_id=self.session_id),
                    active_delegations=count_active_delegations(self.session_id))
                if self.halted.is_set() or self.goal_halted.is_set():
                    self.goals.pause(reason="direct-stopped")
                    return
                self.waiting_goal = self.goals.is_waiting()
                if decision.get("message"):
                    self.notice(decision["message"])
                if decision.get("should_continue") and decision.get("continuation_prompt"):
                    if not any(j.get("goal") for j in self.jobs):
                        self.enqueue(decision["continuation_prompt"], goal=True)
            finally:
                clear_session_vars(tokens)

    def prompt(self, msg):
        with self.scheduler_lock:
            self._prompt(msg)

    def _prompt(self, msg):
        if not self.agent:
            raise RuntimeError("Session not open")
        if self.busy:
            raise RuntimeError("A foreground turn is already active")
        self.busy = True
        self.in_model = not bool(msg.get("command"))
        self.interrupted.clear()
        self.text_id = self.reason_id = None
        self.turn_streamed = False
        prior = next((x for x in reversed(self.timeline) if x["type"] == "assistant_message"), None)
        self.prior_assistant_id = prior["id"] if prior else None
        # Set the thread before starting it so a second prompt cannot slip through.
        self.thread = threading.Thread(target=self.run_command_turn if msg.get("command") else self.run_turn, args=(msg,), daemon=True)
        self.thread.start()

    def run_turn(self, msg):
        turn_id = msg["turnId"]
        try:
            self.item({"id": msg["clientMessageId"], "type": "user_message", "text": msg["text"],
                       "clientMessageId": msg["clientMessageId"]})
            with contextlib.ExitStack() as stack:
                from tools import terminal_tool
                from tools.approval_context import set_hermes_interactive_context, reset_hermes_interactive_context
                from gateway.session_context import set_session_vars, clear_session_vars
                tokens = set_session_vars(session_key=self.session_id, session_id=self.session_id, cwd=self.cwd, cron_session="")
                stack.callback(clear_session_vars, tokens)
                token = set_hermes_interactive_context(True)
                stack.callback(reset_hermes_interactive_context, token)
                prev = terminal_tool._get_approval_callback()
                terminal_tool.set_approval_callback(self.approval)
                stack.callback(terminal_tool.set_approval_callback, prev)
                # Also used by some CLI tools; safe because every session has its own process.
                os.environ["HERMES_SESSION_ID"] = self.session_id
                result = self.agent.run_conversation(user_message=msg.get("content", msg["text"]), conversation_history=self.history,
                                                     persist_user_message=msg["text"],
                                                     system_message=self.system_prompt, task_id=turn_id)
            self.in_model = False
            self.history = result.get("messages", self.history)
            final = result.get("final_response") or ""
            last = next((x for x in reversed(self.timeline) if x["type"] == "assistant_message"), None)
            final_seen = bool(last and last["id"] != self.prior_assistant_id and last["text"].strip() == str(final).strip())
            if final and (not final_seen or result.get("response_transformed")):
                # Rewrites replace the last visible assistant item rather than duplicating it.
                if result.get("response_transformed"):
                    last = next((x for x in reversed(self.timeline) if x["type"] == "assistant_message"), None)
                    if last:
                        self.text_id = last["id"]
                self.item({"id": self.text_id or str(uuid.uuid4()), "type": "assistant_message", "text": final})
            canceled = self.interrupted.is_set() or result.get("interrupted")
            for item in list(self.timeline):
                if item.get("type") == "tool_call" and item.get("status") == "running":
                    self.item({**item, "status": "canceled" if canceled else "failed", "error": None if canceled else "No tool completion"})
            self.save()
            # Hermes errors must not masquerade as successful completed turns.
            state = "canceled" if canceled else "failed" if result.get("error") else "completed"
            self.in_model = False
            if state == "completed":
                self.goal_after_turn(str(final), turn_id)
            self.finish(turn_id, state, str(result.get("error") or ""))
        except Exception as exc:
            self.finish(turn_id, "canceled" if self.interrupted.is_set() else "failed", str(exc))


def main():
    try:
        bootstrap()
        _, _, catalog = config_catalog()
        emit("ready", catalog=catalog)
    except Exception as exc:
        emit("fatal", error=str(exc))
        return 1
    bridge = Bridge()
    for line in sys.stdin:
        msg = None
        try:
            msg = json.loads(line)
            kind = msg["type"]
            if kind == "open":
                bridge.open(msg)
            elif kind == "prompt":
                bridge.prompt(msg)
            elif kind == "control":
                bridge.control(msg)
            elif kind == "permission":
                bridge.permission(msg)
            elif kind == "interrupt":
                bridge.interrupt()
                emit("interrupted", requestId=msg.get("requestId"))
            elif kind == "close":
                bridge.closing = True
                bridge.interrupt()
                if bridge.thread:
                    bridge.thread.join(timeout=2)
                return 0
            else:
                raise ValueError("Unknown bridge input: " + kind)
        except Exception as exc:
            emit("error", error=str(exc), requestId=msg.get("requestId") if isinstance(msg, dict) else None)
    bridge.closing = True
    bridge.interrupt()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

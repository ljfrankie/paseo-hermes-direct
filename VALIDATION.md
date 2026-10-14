# Verification record

- `npm run build`: passed.
- `npm run typecheck`: passed against @getpaseo/plugin 0.11.2.
- `npm test`: 40 Node tests and 1 Python source check passed.
- Integration tests execute the shipped Python bridge in real subprocesses, with a controlled fake Hermes installation. All observed provider events are validated using the public Paseo ProviderEventSchema.
- Confirmed text events arrive before turn completion, with stable message IDs and no repeated final message. Covered replay and model history resume, busy rejection, interruption, permissions, failure recovery, absent capabilities, session locking, unexpected subprocess exit, and invalid cwd.
- Image update: verified text/image order, image-only input, multiple images, uploaded-file inlining, base64/MIME/size rejection, negotiated image capability, and image history through close/resume.
- Slash update: verified command menu/schema, text and structured inputs, no model calls for queries, reset and model-switch resume, compression/preview/failed compression recovery, busy rejection, stop, and capability negotiation.
- Steering/queue/goals update: native steer history injection and negotiated Paseo steer delivery; FIFO lifecycle balance; pending queue resume paused; goal completion, budget exhaustion and blocked verdict; pause suppressing stale continuation; persisted subgoals; wait/unwait and automatic process-barrier wakeup; concurrent FIFO admissions; idle stop updating goal state; stop pausing pending work; shell gate creation rejected.
- Loaded the actual baseline Hermes goal dispatcher and GoalManager and checked contract parsing, continuation, budget exhaustion, resume and gate authorization with stubbed persistence/judge. This did not make a model request.
- Checked the manifest with the baseline Paseo manifest reader and checked both README JSON examples against the installed 0.11.2 ProviderOverridesSchema; all passed.
- macOS compatibility update: removed manifest `name` for installed 0.11 builds with a stricter manifest schema; retained npm package `name` and the registered provider label. Added explicit config `label` and macOS `venv/bin/python` instructions.
- User-reported macOS checks: `hermes_bootstrap` and `run_agent` imports succeeded; `paseo provider models hermes-direct` returned the user's configured model. Android conversation, streaming and tool execution are not established by those checks.
- Model-selector update: negotiated session.configure independent of slash-command capability; config-before-completion event order; no extra turn/timeline messages; history and selected model/provider survive resume; route and native rebuild failures leave the session usable; busy and concurrent requests rejected; unsupported multi-field changes rejected before mutation; no-op clears and default model/provider reset.
- Real Hermes/model request, Paseo daemon installation and Android UI verification have NOT been run in this environment. Use `npm run smoke`, then the mobile checklist in README.
- Source contract baseline: Hermes 97a9ae8ee55d31bebce49f1fb6b5ef775323976a; Paseo 114389383d6f6c78a9e1580ab245b3edc81feae8. Other versions are not certified.

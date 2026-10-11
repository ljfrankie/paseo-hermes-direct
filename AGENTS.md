# Project instructions

This is a Paseo 0.11 Direct Provider, not an ACP adapter. Keep transport stdout reserved for NDJSON. Native Hermes stdout must remain on stderr. Do not emulate token streaming by splitting completed responses.

Changes to `server/hermes_bridge.py` require `npm run build`. Validate with `npm run typecheck` and `npm test`. `npm run smoke` invokes a real user's configured model and is separate from fixture tests.

Retain one subprocess per session, explicit capability negotiation, truthful unsupported-feature errors, stable timeline IDs, and terminal lifecycle events. Never unlock a turn merely because an interrupt request was acknowledged. Keep session file locks, atomic snapshot writes and 0600 files. No automatic yolo or approval bypass.

Check actual Hermes function signatures against the installed source; fixtures must track required arguments. Keep source-baseline and verification limits in README current. Do not claim a real model/phone test based on fixture tests.

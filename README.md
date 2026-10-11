# paseo-hermes-direct

English | [中文](./README.zh.md)

`paseo-hermes-direct` connects a local [Hermes AIAgent](https://github.com/NousResearch/hermes-agent) to [Paseo](https://getpaseo.com) through a Direct Provider — no ACP in between.

## Install

You need Paseo 0.11.x and a working Hermes agent install on the machine that runs the Paseo daemon (the plugin pins the Paseo 0.11 SDK line; it does not claim compatibility with 0.12). Point the provider at the Python environment where Hermes is installed — not the `hermes` command:

```bash
export PASEO_HERMES_ROOT="$HOME/.hermes/hermes-agent"
export PASEO_HERMES_PYTHON="$PASEO_HERMES_ROOT/.venv/bin/python"
```

In Paseo, open **Settings → Plugins → Install Plugin** and paste the Git source:

```
https://github.com/ljfrankie/paseo-hermes-direct
```

To update, run on the daemon machine (the app's plugin menu has no update entry):

```
paseo plugin update paseo-hermes-direct --check   # see if a new version exists
paseo plugin update paseo-hermes-direct --yes     # update to the latest
```

The package is not published to npm yet, so there is no `npm:` install source. See the [Chinese documentation](./README.zh.md) for the full setup walkthrough, including daemon config and phone-app verification.

## Why "Direct"

Most Hermes integrations go through ACP, a generic protocol every agent can speak. This plugin skips it and talks to Hermes natively through AIAgent callbacks, so what Hermes does shows up in Paseo the way Paseo expects:

- Text and reasoning stream through Hermes's native incremental callbacks, updated in place on one timeline — no slicing of a finished answer.
- Tool approvals surface as Paseo approval cards; Hermes's terminal approval callback is honored (single allow/deny, never auto-yolo).
- Each session gets its own isolated Python bridge process — no cwd, env, or approval-callback interference between sessions.
- Hermes slash commands (`/model`, `/compress`, `/goal`, `/queue`, `/steer`, ...) appear in Paseo's `/` menu.
- Images (PNG/JPEG/WebP/GIF, up to 20 MiB per message) ride along as native OpenAI-style `image_url` multimodal content.
- Sessions persist as atomic snapshots and can be resumed.

## Versioning

v0.1.0 is experimental. The plugin targets the Paseo 0.11 line (`paseo-plugin.json` requires `>=0.11.0 <0.12.0`); the patch number is the plugin's own release count.

Hermes's internal APIs change fast. The bridge is validated against Hermes main `97a9ae8ee55d31bebce49f1fb6b5ef775323976a` and Paseo main `114389383d6f6c78a9e1580ab245b3edc81fe8`. Unsupported Hermes signatures fail loudly with a clear error instead of silently degrading.

## Use

Create a conversation with the **Hermes Direct** provider. Models and credentials come from your existing Hermes configuration — the plugin reads them through Hermes's own env loader, config loader, and runtime provider resolver, so nothing is copied into the plugin.

```json
{
  "agents": {
    "providers": {
      "hermes-direct": {
        "label": "Hermes Direct",
        "command": ["/home/ubuntu/.hermes/hermes-agent/.venv/bin/python"],
        "env": {
          "PASEO_HERMES_ROOT": "/home/ubuntu/.hermes/hermes-agent",
          "HERMES_HOME": "/home/ubuntu/.hermes"
        }
      }
    }
  }
}
```

Existing Hermes CLI sessions are not imported; start a new conversation. Persistent sessions recover through snapshots stored at `$HERMES_HOME/paseo-direct/<uuid>.json` (written 0600).

## Install from source

```bash
git clone https://github.com/ljfrankie/paseo-hermes-direct.git
cd paseo-hermes-direct
npm ci --legacy-peer-deps
npm run build
paseo plugin install "$PWD"
```

## Development

```bash
npm run build
npm run typecheck
npm test
npm run smoke
```

`smoke` performs a real model request through your Hermes configuration and prints each text update with timing, so you can verify streaming end to end before touching the phone app.

## Acknowledgments

The Direct Provider architecture is inspired by [Jecvay/paseo-dsh-direct](https://github.com/Jecvay/paseo-dsh-direct) (MIT), which established the pattern of talking to an agent harness natively instead of through ACP. This project contains none of that project's code — it is built on the public Paseo Provider SDK and Hermes's native AIAgent callbacks.

## License

[MIT](./LICENSE)

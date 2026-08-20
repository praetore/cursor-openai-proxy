# Cursor OpenAI Proxy

Local OpenAI-compatible **chat completions** API backed by the official Cursor Agent CLI. Runs in the system tray; click the icon to paste your API key.

## Prerequisites

1. **Node.js 20+**
2. **Cursor Agent CLI** on your PATH (`agent`) — see [Cursor CLI docs](https://cursor.com/docs/cli/overview)
3. A **Cursor API key** from [Dashboard → Integrations](https://cursor.com/dashboard/integrations)

## Install & run

```bash
npm install
npm run dev
```

Production:

```bash
npm run build
npm start
```

Background (hidden window on Windows):

```bash
npm run build
npm run start:bg
```

Or from Task Scheduler / Startup folder:

```text
node C:\path\to\cursor-openai-proxy\dist\index.js
```

## Settings (tray)

1. Click the tray icon (or **Open settings**)
2. Paste your Cursor API key and click **Save key**
3. Use base URL: `http://127.0.0.1:4646/v1`

Config is stored at `%APPDATA%\cursor-openai-proxy\config.json`.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health + whether an API key is set |
| `GET` | `/v1/models` | Models from `agent --list-models` |
| `POST` | `/v1/chat/completions` | Chat completion (`stream` supported) |
| `GET` | `/openapi.json` | OpenAPI 3 document |
| `GET` | `/ui/` | Settings UI |

### Example

```bash
curl http://127.0.0.1:4646/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in one sentence.\"}]}"
```

Point any OpenAI-compatible client at:

- **Base URL:** `http://127.0.0.1:4646/v1`
- **API key:** any non-empty value (auth is your saved Cursor key on the server)

## How it works

Requests are converted to a prompt and run with:

```bash
agent -p --mode ask --output-format stream-json --stream-partial-output --model <model> --api-key <key> "<prompt>"
```

Ask mode keeps this bridge chat-oriented (no file edits by default).

## Notes

- This uses the **official Cursor Agent CLI**, not private IDE endpoints.
- Host/port changes in config require a restart.
- Default listen address: `127.0.0.1:4646`

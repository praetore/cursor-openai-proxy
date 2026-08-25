# Cursor OpenAI Proxy

Local OpenAI-compatible **chat completions** API backed by the official [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). Runs in the system tray.

## Prerequisites

1. **Node.js 22.13+**
2. A **Cursor API key** from [Dashboard → API Keys](https://cursor.com/dashboard/api)

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

## Auth (required)

Every OpenAI client must send your Cursor key as a Bearer token:

```http
Authorization: Bearer cursor_...
```

| Endpoint | Behavior |
|----------|----------|
| `GET /` or `GET /v1` | **200 only** if Bearer auth works **and** Cursor API is reachable (`Cursor.me`) |
| `GET /v1/models` | Models from `Cursor.models.list()` (Bearer required) |
| `POST /v1/chat/completions` | Chat via `@cursor/sdk` `Agent` (Bearer required) |

Settings UI: `http://127.0.0.1:4646/ui/`

Config file: `%APPDATA%\cursor-openai-proxy\config.json`.

## Client setup

- **Base URL:** `http://127.0.0.1:4646/v1`
- **API key:** your Cursor API key (the client sends it as `Authorization: Bearer …`)

### Example

```bash
curl http://127.0.0.1:4646/v1/chat/completions ^
  -H "Authorization: Bearer %CURSOR_API_KEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in one sentence.\"}]}"
```

Live auth check:

```bash
curl -i http://127.0.0.1:4646/ ^
  -H "Authorization: Bearer %CURSOR_API_KEY%"
```

## How it works

Requests are handled with `@cursor/sdk`:

- Auth probe → `Cursor.me({ apiKey })`
- Models → `Cursor.models.list({ apiKey })`
- Chat → `Agent.create` + `agent.send` (local runtime, isolated workspace under the config dir)

## Notes

- Host/port changes in config require a restart.
- Default listen address: `127.0.0.1:4646`
- SDK usage follows the same Cursor billing / privacy rules as IDE and Cloud Agents.

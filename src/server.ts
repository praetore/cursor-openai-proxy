import {
  baseUrl,
  configPath,
  loadConfig,
  requestLogPath,
  saveConfig,
  type AppConfig,
} from "./config.js";
import {
  getCachedModels,
  listModels,
  runAgentCompletion,
  runAgentStream,
  verifyCursorAuth,
  type ChatCompletionRequest,
} from "./cursor-agent.js";
import open from "open";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Human-readable request log → stdout + %APPDATA%/cursor-openai-proxy/requests.log */
function sysout(message: string, detail?: unknown): void {
  const safeDetail = detail === undefined ? undefined : redactSecrets(detail);
  const line =
    safeDetail === undefined
      ? message
      : `${message} ${typeof safeDetail === "string" ? safeDetail : JSON.stringify(safeDetail)}`;
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  void mkdir(dirname(requestLogPath()), { recursive: true })
    .then(() => appendFile(requestLogPath(), `${stamped}\n`, "utf8"))
    .catch(() => {
      // ignore log file errors
    });
}

function previewText(value: unknown, max = 240): string {
  const text =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : JSON.stringify(value);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** Strip Bearer tokens / cursor_ keys that may appear in error strings. */
function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\bcursor_[A-Za-z0-9_-]+/g, "cursor_[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|api[_-]?key|token|secret|password/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function looksLikeCommitMessage(messages: ChatCompletionRequest["messages"]): boolean {
  const blob = messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
    .toLowerCase();
  return (
    blob.includes("commit message") ||
    blob.includes("commit msg") ||
    blob.includes("git diff") ||
    blob.includes("generate a commit") ||
    /\bdiff --git\b/.test(blob)
  );
}

export interface ServerHandle {
  config: AppConfig;
  reloadConfig: () => Promise<AppConfig>;
  close: () => Promise<void>;
}

function openaiError(message: string, type = "invalid_request_error", status = 400) {
  return {
    status,
    body: {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
  };
}

function completionId(): string {
  return `chatcmpl_${randomUUID().replace(/-/g, "")}`;
}

function extractBearer(authorization: string | string[] | undefined): string | null {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)/i.exec(raw.trim());
  return match?.[1] ?? null;
}

function openApiSpec(config: AppConfig) {
  const url = `${baseUrl(config)}/v1`;
  return {
    openapi: "3.0.3",
    info: {
      title: "Cursor OpenAI Proxy",
      version: "1.0.0",
      description:
        "OpenAI-compatible chat completions backed by the Cursor TypeScript SDK. Pass your Cursor API key as Authorization: Bearer <key>.",
    },
    servers: [{ url }],
    paths: {
      "/": {
        get: {
          summary: "Live auth check against Cursor API (requires Bearer)",
          responses: {
            "200": { description: "Auth and Cursor API connection OK" },
            "401": { description: "Missing/invalid Bearer or Cursor auth failed" },
          },
        },
      },
      "/v1/models": {
        get: {
          summary: "List models",
          responses: { "200": { description: "Model list" } },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "Create chat completion",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["messages"],
                  properties: {
                    model: { type: "string" },
                    messages: { type: "array" },
                    stream: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Chat completion or SSE stream" },
          },
        },
      },
    },
  };
}

function modelsResponse(ids: string[]) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list" as const,
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "cursor",
    })),
  };
}

export async function startServer(initial: AppConfig): Promise<ServerHandle> {
  let config = initial;
  // Custom sysout handles request logs; keep Fastify quiet so Authorization is never dumped.
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "public", "ui"),
    prefix: "/ui/",
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
    // chat/completions has its own compact logs (esp. commit-message flow)
    if (req.url.split("?")[0] === "/v1/chat/completions") return;
    sysout(`→ ${req.method} ${req.url}`, {
      ua: req.headers["user-agent"] ?? null,
      hasAuth: Boolean(req.headers.authorization),
    });
  });

  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (req.url.split("?")[0] === "/v1/chat/completions") return;
    sysout(`← ${req.method} ${req.url} ${reply.statusCode}`);
  });

  const requireApiKey = (
    authorization: string | string[] | undefined,
  ): { apiKey: string } | { error: ReturnType<typeof openaiError> } => {
    const apiKey = extractBearer(authorization);
    if (!apiKey) {
      return {
        error: openaiError(
          "Missing Authorization Bearer token. Pass your Cursor API key as: Authorization: Bearer <key>",
          "authentication_error",
          401,
        ),
      };
    }
    return { apiKey };
  };

  /** Base URL probe: 200 only when Bearer auth + Cursor API connectivity succeed. */
  const handleBaseProbe = async (
    req: { headers: { authorization?: string | string[] } },
    reply: {
      code: (status: number) => { send: (body: unknown) => unknown };
    },
  ) => {
    const auth = requireApiKey(req.headers.authorization);
    if ("error" in auth) {
      return reply.code(auth.error.status).send(auth.error.body);
    }

    try {
      const me = await verifyCursorAuth(auth.apiKey);
      return reply.code(200).send({
        ok: true,
        object: "cursor.auth",
        apiKeyName: me.apiKeyName,
        userEmail: me.userEmail ?? null,
        v1: `${baseUrl(config)}/v1`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const err = openaiError(
        `Cursor API auth/connection failed: ${message}`,
        "authentication_error",
        401,
      );
      return reply.code(err.status).send(err.body);
    }
  };

  app.get("/", handleBaseProbe);
  // Clients often set base URL to .../v1 — same live check there.
  app.get("/v1", handleBaseProbe);

  app.get("/ui", async (_req, reply) => reply.redirect("/ui/"));

  app.get("/health", async () => ({
    ok: true,
    baseUrl: baseUrl(config),
    v1: `${baseUrl(config)}/v1`,
    note: "Use Authorization: Bearer <CURSOR_API_KEY> on /v1/* and for GET / live auth check.",
  }));

  app.get("/openapi.json", async () => openApiSpec(config));

  app.get("/api/config", async () => ({
    host: config.host,
    port: config.port,
    agentBin: config.agentBin,
    baseUrl: baseUrl(config),
    v1: `${baseUrl(config)}/v1`,
    configPath: configPath(),
    logPath: requestLogPath(),
  }));

  app.post("/api/open-logs", async (_req, reply) => {
    try {
      const path = requestLogPath();
      await mkdir(dirname(path), { recursive: true });
      try {
        await access(path, fsConstants.F_OK);
      } catch {
        await writeFile(path, "", "utf8");
      }
      await open(path);
      return { ok: true, path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  app.post<{
    Body: {
      host?: string;
      port?: number;
      agentBin?: string;
    };
  }>("/api/config", async (req) => {
    const body = req.body ?? {};
    const partial: Partial<AppConfig> = {};
    if (typeof body.host === "string" && body.host.trim()) partial.host = body.host.trim();
    if (typeof body.port === "number" && Number.isFinite(body.port)) partial.port = body.port;
    if (typeof body.agentBin === "string" && body.agentBin.trim()) {
      partial.agentBin = body.agentBin.trim();
    }

    config = await saveConfig(partial);
    return {
      ok: true,
      host: config.host,
      port: config.port,
      agentBin: config.agentBin,
      baseUrl: baseUrl(config),
      v1: `${baseUrl(config)}/v1`,
      note:
        body.host || body.port
          ? "Host/port changes apply after restart."
          : undefined,
    };
  });

  const handleListModels = async (
    req: {
      headers: { authorization?: string | string[] };
      query: unknown;
    },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const auth = requireApiKey(req.headers.authorization);
    if ("error" in auth) {
      return reply.code(auth.error.status).send(auth.error.body);
    }

    const query = (req.query ?? {}) as Record<string, unknown>;
    const force = query.refresh === "1" || query.refresh === "true";

    try {
      const ids = await listModels(auth.apiKey, { force });
      return modelsResponse(ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cached = getCachedModels(auth.apiKey);
      if (cached?.length) {
        app.log.warn({ err: message }, "list-models failed; returning cache");
        return modelsResponse(cached);
      }
      const err = openaiError(
        `Failed to list models from Cursor API: ${message}`,
        "server_error",
        502,
      );
      return reply.code(err.status).send(err.body);
    }
  };

  app.get<{ Querystring: { refresh?: string } }>("/v1/models", async (req, reply) =>
    handleListModels(req, reply),
  );
  app.get<{ Querystring: { refresh?: string } }>("/models", async (req, reply) =>
    handleListModels(req, reply),
  );

  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (req, reply) => {
    const auth = requireApiKey(req.headers.authorization);
    if ("error" in auth) {
      sysout("chat/completions REJECTED: missing/invalid Bearer");
      return reply.code(auth.error.status).send(auth.error.body);
    }

    const body = req.body;
    if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      sysout("chat/completions REJECTED: messages required", body);
      const err = openaiError("`messages` is required");
      return reply.code(err.status).send(err.body);
    }

    const created = Math.floor(Date.now() / 1000);
    const id = completionId();
    const model = body.model?.trim() || "auto";
    const commitLike = looksLikeCommitMessage(body.messages);
    if (commitLike) {
      sysout("*** COMMIT MESSAGE REQUEST ***", {
        id,
        model,
        stream: Boolean(body.stream),
      });
    } else {
      sysout("chat/completions", {
        id,
        model,
        stream: Boolean(body.stream),
        messages: body.messages.length,
        roles: body.messages.map((m) => m.role),
        preview: previewText(body.messages.map((m) => m.content).join(" | ")),
      });
    }

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      const writeEvent = (payload: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        let chars = 0;
        for await (const event of runAgentStream(config, auth.apiKey, body)) {
          if (event.kind === "delta") {
            chars += event.text.length;
            writeEvent({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: event.text },
                  finish_reason: null,
                },
              ],
            });
          } else {
            writeEvent({
              id,
              object: "chat.completion.chunk",
              created,
              model: event.result.model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            });
          }
        }
        reply.raw.write("data: [DONE]\n\n");
        sysout(
          commitLike ? "*** COMMIT MESSAGE DONE ***" : "chat/completions stream DONE",
          { id, chars },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sysout(
          commitLike ? "*** COMMIT MESSAGE ERROR ***" : "chat/completions stream ERROR",
          redactSecrets(message),
        );
        writeEvent({
          error: {
            message,
            type: "server_error",
          },
        });
      } finally {
        reply.raw.end();
      }
      return;
    }

    try {
      const result = await runAgentCompletion(config, auth.apiKey, body);
      if (commitLike) {
        sysout("*** COMMIT MESSAGE DONE ***", {
          id,
          model: result.model,
          chars: result.text.length,
        });
      } else {
        sysout("chat/completions DONE", {
          id,
          model: result.model,
          chars: result.text.length,
          preview: previewText(result.text),
        });
      }
      return {
        id,
        object: "chat.completion",
        created,
        model: result.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.text,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sysout(
        commitLike ? "*** COMMIT MESSAGE ERROR ***" : "chat/completions ERROR",
        redactSecrets(message),
      );
      const err = openaiError(message, "server_error", 500);
      return reply.code(err.status).send(err.body);
    }
  });

  app.setNotFoundHandler((req, reply) => {
    sysout(`??? UNKNOWN ROUTE ${req.method} ${req.url} (IntelliJ may be calling an unsupported path)`);
    return reply.code(404).send({
      error: {
        message: `Unknown route: ${req.method} ${req.url}`,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
  });

  await app.listen({ host: config.host, port: config.port });
  sysout(`Request log file: ${requestLogPath()}`);

  return {
    get config() {
      return config;
    },
    async reloadConfig() {
      config = await loadConfig();
      return config;
    },
    async close() {
      await app.close();
    },
  };
}

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseUrl,
  configPath,
  loadConfig,
  maskApiKey,
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

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const app = Fastify({ logger: true });

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
    hasApiKey: Boolean(config.apiKey),
    baseUrl: baseUrl(config),
    v1: `${baseUrl(config)}/v1`,
    note: "Use GET / or GET /v1 with Authorization: Bearer <CURSOR_API_KEY> for a live Cursor auth check.",
  }));

  app.get("/openapi.json", async () => openApiSpec(config));

  app.get("/api/config", async () => ({
    hasApiKey: Boolean(config.apiKey),
    apiKeyMasked: maskApiKey(config.apiKey),
    host: config.host,
    port: config.port,
    agentBin: config.agentBin,
    defaultModel: config.defaultModel,
    baseUrl: baseUrl(config),
    v1: `${baseUrl(config)}/v1`,
    configPath: configPath(),
  }));

  app.post<{
    Body: {
      apiKey?: string;
      host?: string;
      port?: number;
      agentBin?: string;
      defaultModel?: string;
    };
  }>("/api/config", async (req) => {
    const body = req.body ?? {};
    const partial: Partial<AppConfig> = {};
    if (typeof body.apiKey === "string") partial.apiKey = body.apiKey.trim();
    if (typeof body.host === "string" && body.host.trim()) partial.host = body.host.trim();
    if (typeof body.port === "number" && Number.isFinite(body.port)) partial.port = body.port;
    if (typeof body.agentBin === "string" && body.agentBin.trim()) {
      partial.agentBin = body.agentBin.trim();
    }
    if (typeof body.defaultModel === "string" && body.defaultModel.trim()) {
      partial.defaultModel = body.defaultModel.trim();
    }

    config = await saveConfig(partial);
    return {
      ok: true,
      hasApiKey: Boolean(config.apiKey),
      apiKeyMasked: maskApiKey(config.apiKey),
      host: config.host,
      port: config.port,
      agentBin: config.agentBin,
      defaultModel: config.defaultModel,
      baseUrl: baseUrl(config),
      v1: `${baseUrl(config)}/v1`,
      note:
        body.host || body.port
          ? "Host/port changes apply after restart."
          : undefined,
    };
  });

  /** Settings UI helper: verify stored key against Cursor. */
  app.post("/api/verify", async (_req, reply) => {
    if (!config.apiKey) {
      const err = openaiError(
        "API key not set. Paste your Cursor API key and save first.",
        "authentication_error",
        401,
      );
      return reply.code(err.status).send(err.body);
    }
    try {
      const me = await verifyCursorAuth(config.apiKey);
      return { ok: true, apiKeyName: me.apiKeyName, userEmail: me.userEmail ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const err = openaiError(message, "authentication_error", 401);
      return reply.code(err.status).send(err.body);
    }
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
      return reply.code(auth.error.status).send(auth.error.body);
    }

    const body = req.body;
    if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      const err = openaiError("`messages` is required");
      return reply.code(err.status).send(err.body);
    }

    const created = Math.floor(Date.now() / 1000);
    const id = completionId();
    const model = body.model?.trim() || config.defaultModel;

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
        for await (const event of runAgentStream(config, auth.apiKey, body)) {
          if (event.kind === "delta") {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
      const err = openaiError(message, "server_error", 500);
      return reply.code(err.status).send(err.body);
    }
  });

  await app.listen({ host: config.host, port: config.port });

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

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
  listModels,
  runAgentCompletion,
  runAgentStream,
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

function openApiSpec(config: AppConfig) {
  const url = baseUrl(config);
  return {
    openapi: "3.0.3",
    info: {
      title: "Cursor OpenAI Proxy",
      version: "1.0.0",
      description:
        "OpenAI-compatible chat completions backed by the Cursor Agent CLI (ask mode).",
    },
    servers: [{ url }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: { "200": { description: "OK" } },
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

export async function startServer(initial: AppConfig): Promise<ServerHandle> {
  let config = initial;
  const app = Fastify({ logger: true });

  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "public", "ui"),
    prefix: "/ui/",
  });

  app.get("/", async (_req, reply) => reply.redirect("/ui/"));
  app.get("/ui", async (_req, reply) => reply.redirect("/ui/"));

  app.get("/health", async () => ({
    ok: true,
    hasApiKey: Boolean(config.apiKey),
    baseUrl: baseUrl(config),
    v1: `${baseUrl(config)}/v1`,
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
  }>("/api/config", async (req, reply) => {
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

  app.get("/v1/models", async (_req, reply) => {
    if (!config.apiKey) {
      const err = openaiError(
        "API key not set. Open the tray settings and paste your Cursor API key.",
        "authentication_error",
        401,
      );
      return reply.code(err.status).send(err.body);
    }

    try {
      const ids = await listModels(config);
      return {
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cursor",
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Still return auto so clients can work offline from list-models failures.
      app.log.warn({ err: message }, "list-models failed; returning auto");
      return {
        object: "list",
        data: [
          {
            id: "auto",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "cursor",
          },
        ],
      };
    }
  });

  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (req, reply) => {
    if (!config.apiKey) {
      const err = openaiError(
        "API key not set. Open the tray settings and paste your Cursor API key.",
        "authentication_error",
        401,
      );
      return reply.code(err.status).send(err.body);
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
      });

      const writeEvent = (payload: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        for await (const event of runAgentStream(config, body)) {
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
      const result = await runAgentCompletion(config, body);
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

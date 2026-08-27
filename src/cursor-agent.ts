import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { messagesToPrompt, type ChatMessage } from "./prompt.js";

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface AgentRunResult {
  text: string;
  model: string;
  sessionId?: string;
}

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

let modelsCache: {
  apiKey: string;
  ids: string[];
  fetchedAt: number;
} | null = null;

let modelsInflight: Promise<string[]> | null = null;

function workspaceDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "cursor-openai-proxy", "workspace");
  }
  return join(homedir(), ".config", "cursor-openai-proxy", "workspace");
}

async function ensureWorkspace(): Promise<string> {
  const dir = workspaceDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function modelSelection(modelId: string): { id: string } {
  return { id: modelId.trim() || "auto" };
}

function errorMessage(error: unknown): string {
  if (error instanceof CursorAgentError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Verify the API key can reach Cursor (auth + network). */
export async function verifyCursorAuth(apiKey: string): Promise<{
  ok: true;
  apiKeyName: string;
  userEmail?: string;
}> {
  const me = await Cursor.me({ apiKey });
  return {
    ok: true,
    apiKeyName: me.apiKeyName,
    userEmail: me.userEmail,
  };
}

async function fetchModelsFromSdk(apiKey: string): Promise<string[]> {
  const listed = await Cursor.models.list({ apiKey });
  const models = new Set<string>(["auto"]);
  for (const model of listed) {
    if (model.id) models.add(model.id);
    for (const alias of model.aliases ?? []) {
      if (alias) models.add(alias);
    }
  }
  return [...models];
}

export async function listModels(
  apiKey: string,
  options?: { force?: boolean },
): Promise<string[]> {
  const force = options?.force === true;
  const now = Date.now();
  if (
    !force &&
    modelsCache &&
    modelsCache.apiKey === apiKey &&
    now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS
  ) {
    return modelsCache.ids;
  }

  if (!force && modelsInflight) {
    return modelsInflight;
  }

  const pending = fetchModelsFromSdk(apiKey)
    .then((ids) => {
      modelsCache = { apiKey, ids, fetchedAt: Date.now() };
      return ids;
    })
    .finally(() => {
      modelsInflight = null;
    });

  modelsInflight = pending;
  return pending;
}

export function getCachedModels(apiKey: string): string[] | null {
  if (modelsCache && modelsCache.apiKey === apiKey) return modelsCache.ids;
  return null;
}

export async function* runAgentStream(
  _config: AppConfig,
  apiKey: string,
  request: ChatCompletionRequest,
): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "done"; result: AgentRunResult }> {
  const modelId = request.model?.trim() || "auto";
  const prompt = messagesToPrompt(request.messages);
  const cwd = await ensureWorkspace();

  await using agent = await Agent.create({
    apiKey,
    model: modelSelection(modelId),
    local: {
      cwd,
      // Chat bridge: don't load ambient IDE/project settings.
      settingSources: [],
    },
  });

  let finalText = "";
  const pendingDeltas: string[] = [];
  let notify: (() => void) | null = null;

  const run = await agent.send(prompt, {
    model: modelSelection(modelId),
    onDelta: ({ update }) => {
      if (update.type === "text-delta" && update.text) {
        pendingDeltas.push(update.text);
        notify?.();
      }
    },
  });

  try {
    const resultPromise = run.wait().finally(() => {
      notify?.();
    });

    while (true) {
      while (pendingDeltas.length > 0) {
        const delta = pendingDeltas.shift()!;
        finalText += delta;
        yield { kind: "delta", text: delta };
      }

      const settled = await Promise.race([
        resultPromise.then((result) => ({ done: true as const, result })),
        new Promise<{ done: false }>((resolve) => {
          notify = () => resolve({ done: false });
        }),
      ]);
      notify = null;

      if (settled.done) {
        while (pendingDeltas.length > 0) {
          const delta = pendingDeltas.shift()!;
          finalText += delta;
          yield { kind: "delta", text: delta };
        }

        const result = settled.result;
        if (result.status === "error") {
          throw new Error(result.error?.message || "Cursor agent run failed");
        }
        if (result.result && !finalText) {
          finalText = result.result;
        }

        yield {
          kind: "done",
          result: {
            text: finalText || result.result || "",
            model: result.model?.id || modelId,
            sessionId: agent.agentId,
          },
        };
        return;
      }
    }
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

export async function runAgentCompletion(
  config: AppConfig,
  apiKey: string,
  request: ChatCompletionRequest,
): Promise<AgentRunResult> {
  let result: AgentRunResult | null = null;
  for await (const event of runAgentStream(config, apiKey, request)) {
    if (event.kind === "done") result = event.result;
  }
  if (!result) throw new Error("Cursor agent produced no result");
  return result;
}

// Re-export for callers that only need the message type.
export type { ChatMessage };

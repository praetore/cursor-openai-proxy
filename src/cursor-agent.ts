import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppConfig } from "./config.js";
import { messagesToPrompt, type ChatMessage } from "./prompt.js";

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface TextDelta {
  text: string;
}

export interface AgentRunResult {
  text: string;
  model: string;
  sessionId?: string;
}

function resolveAgentCommand(agentBin: string): {
  command: string;
  argsPrefix: string[];
  shell: boolean;
} {
  if (process.platform === "win32") {
    // .cmd shims need a shell; keep the prompt as a single argv entry.
    const bin = agentBin.toLowerCase().endsWith(".cmd") ? agentBin : `${agentBin}.cmd`;
    return { command: bin, argsPrefix: [], shell: true };
  }
  return { command: agentBin, argsPrefix: [], shell: false };
}

function buildAgentArgs(config: AppConfig, model: string, prompt: string): string[] {
  const args = [
    "-p",
    "--mode",
    "ask",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--model",
    model,
  ];

  if (config.apiKey) {
    args.push("--api-key", config.apiKey);
  }

  args.push(prompt);
  return args;
}

function extractAssistantDelta(event: Record<string, unknown>): string | null {
  if (event.type !== "assistant") return null;

  // Character-level streaming deltas have timestamp_ms and no model_call_id.
  const hasTs = Object.prototype.hasOwnProperty.call(event, "timestamp_ms");
  const hasModelCall = Object.prototype.hasOwnProperty.call(event, "model_call_id");
  if (!hasTs || hasModelCall) return null;

  const message = event.message as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  if (!message?.content) return null;

  return message.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("");
}

export async function* runAgentStream(
  config: AppConfig,
  request: ChatCompletionRequest,
): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "done"; result: AgentRunResult }> {
  const model = request.model?.trim() || config.defaultModel;
  const prompt = messagesToPrompt(request.messages);
  const { command, argsPrefix, shell } = resolveAgentCommand(config.agentBin);
  const args = [...argsPrefix, ...buildAgentArgs(config, model, prompt)];

  const child = spawn(command, args, {
    env: {
      ...process.env,
      CURSOR_API_KEY: config.apiKey || process.env.CURSOR_API_KEY || "",
    },
    shell,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const rl = createInterface({ input: child.stdout! });
  let finalText = "";
  let sessionId: string | undefined;
  let sawResult = false;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
      }

      const delta = extractAssistantDelta(event);
      if (delta) {
        finalText += delta;
        yield { kind: "delta", text: delta };
        continue;
      }

      if (event.type === "result") {
        sawResult = true;
        if (typeof event.result === "string" && event.result.length > 0) {
          // Prefer streamed text when available; result can duplicate aggregates.
          if (!finalText) finalText = event.result;
        }
        if (event.is_error === true) {
          throw new Error(
            typeof event.result === "string" && event.result
              ? event.result
              : "Cursor agent returned an error result",
          );
        }
      }
    }
  } finally {
    rl.close();
  }

  const exitCode: number = await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const detail = stderr.trim() || `agent exited with code ${exitCode}`;
    throw new Error(detail);
  }

  if (!sawResult && !finalText) {
    throw new Error(stderr.trim() || "Cursor agent produced no result");
  }

  yield {
    kind: "done",
    result: {
      text: finalText,
      model,
      sessionId,
    },
  };
}

export async function runAgentCompletion(
  config: AppConfig,
  request: ChatCompletionRequest,
): Promise<AgentRunResult> {
  let result: AgentRunResult | null = null;
  for await (const event of runAgentStream(config, request)) {
    if (event.kind === "done") result = event.result;
  }
  if (!result) throw new Error("Cursor agent produced no result");
  return result;
}

export async function listModels(config: AppConfig): Promise<string[]> {
  const { command, argsPrefix, shell } = resolveAgentCommand(config.agentBin);
  const args = [...argsPrefix, "--list-models"];
  if (config.apiKey) {
    args.push("--api-key", config.apiKey);
  }

  const child = spawn(command, args, {
    env: {
      ...process.env,
      CURSOR_API_KEY: config.apiKey || process.env.CURSOR_API_KEY || "",
    },
    shell,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    stdout += c;
  });
  child.stderr?.on("data", (c: string) => {
    stderr += c;
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `agent --list-models failed (${exitCode})`);
  }

  const models = new Set<string>(["auto"]);
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available") || trimmed.startsWith("ID")) continue;
    // Typical: "composer-2.5  Composer 2.5  ..." or bare id
    const id = trimmed.split(/\s+/)[0];
    if (id && /^[a-zA-Z0-9._:-]+$/.test(id) && id.toLowerCase() !== "id") {
      models.add(id);
    }
  }

  return [...models];
}

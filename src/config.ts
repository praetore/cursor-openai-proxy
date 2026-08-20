import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  apiKey: string;
  host: string;
  port: number;
  agentBin: string;
  defaultModel: string;
}

const DEFAULTS: AppConfig = {
  apiKey: "",
  host: "127.0.0.1",
  port: 4646,
  agentBin: "agent",
  defaultModel: "auto",
};

function configDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "cursor-openai-proxy");
  }
  return join(homedir(), ".config", "cursor-openai-proxy");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const next: AppConfig = { ...current, ...partial };
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export function baseUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}`;
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  agentBin: string;
}

const DEFAULTS: AppConfig = {
  host: "127.0.0.1",
  port: 4646,
  agentBin: "agent",
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

export function requestLogPath(): string {
  return join(configDir(), "requests.log");
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

export function baseUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}`;
}

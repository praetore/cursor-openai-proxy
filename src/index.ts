#!/usr/bin/env node
import { loadConfig, saveConfig } from "./config.js";
import { setAutostartEnabled, syncAutostart } from "./autostart.js";
import { startServer } from "./server.js";
import { startTray } from "./tray.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  // Keep OS login item in sync with config (e.g. choice from Setup).
  try {
    await syncAutostart(config.startAtLogin);
  } catch (err) {
    console.error("Failed to sync start-at-login:", err);
  }

  const server = await startServer(config);

  const tray = startTray({
    getConfig: () => server.config,
    setStartAtLogin: async (enabled) => {
      await saveConfig({ startAtLogin: enabled });
      await setAutostartEnabled(enabled);
      await server.reloadConfig();
    },
    onQuit: async () => {
      await server.close();
      process.exit(0);
    },
  });

  const shutdown = async () => {
    try {
      await tray.kill(false);
    } catch {
      // ignore
    }
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  console.log(`Cursor OpenAI Proxy listening on http://${server.config.host}:${server.config.port}`);
  console.log(`OpenAI base URL: http://${server.config.host}:${server.config.port}/v1`);
  console.log("Auth: Authorization: Bearer <CURSOR_API_KEY>");
  console.log(`Status UI: http://${server.config.host}:${server.config.port}/ui/`);
  console.log("Request logging: stdout + %APPDATA%\\cursor-openai-proxy\\requests.log");
  console.log('Press IntelliJ "Generate Commit Message" — look for "*** COMMIT MESSAGE REQUEST ***"');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

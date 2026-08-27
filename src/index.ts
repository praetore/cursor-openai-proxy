#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { startTray } from "./tray.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const server = await startServer(config);

  const tray = startTray({
    getConfig: () => server.config,
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
  console.log(`Settings: http://${server.config.host}:${server.config.port}/ui/`);
  console.log("Request logging: stdout + %APPDATA%\\cursor-openai-proxy\\requests.log");
  console.log('Press IntelliJ "Generate Commit Message" — look for "*** COMMIT MESSAGE REQUEST ***"');
  if (!server.config.apiKey) {
    console.log("No API key set yet — open settings from the tray icon.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

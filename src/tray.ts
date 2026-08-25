import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { baseUrl, type AppConfig } from "./config.js";

const require = createRequire(import.meta.url);
const SysTray = require("systray2").default as {
  new (conf: {
    menu: {
      icon: string;
      title: string;
      tooltip: string;
      items: Array<{
        title: string;
        tooltip: string;
        checked?: boolean;
        enabled?: boolean;
      }>;
    };
    debug?: boolean;
    copyDir?: boolean | string;
  }): {
    onClick: (listener: (action: { item?: unknown; seq_id: number }) => void) => Promise<unknown>;
    kill: (exitNode?: boolean) => Promise<void>;
  };
  separator: {
    title: string;
    tooltip: string;
    checked: boolean;
    enabled: boolean;
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TrayControllers {
  getConfig: () => AppConfig;
  onQuit: () => Promise<void> | void;
}

function iconBase64(): string {
  const iconPath = join(__dirname, "..", "assets", "tray.ico");
  return readFileSync(iconPath).toString("base64");
}

async function copyToClipboard(text: string): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", "Set-Clipboard -Value $env:CLIP_TEXT"],
        {
          windowsHide: true,
          stdio: "ignore",
          env: { ...process.env, CLIP_TEXT: text },
        },
      );
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Set-Clipboard exited with ${code}`));
      });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with ${code}`));
    });
    child.stdin?.end(text);
  });
}

export function startTray(controllers: TrayControllers) {
  const settingsUrl = () => `${baseUrl(controllers.getConfig())}/ui/`;

  const tray = new SysTray({
    menu: {
      icon: iconBase64(),
      title: "Cursor OpenAI Proxy",
      tooltip: "Cursor OpenAI Proxy – click to open settings",
      items: [
        {
          title: "Open settings",
          tooltip: "Paste your Cursor API key",
          checked: false,
          enabled: true,
        },
        {
          title: "Copy base URL",
          tooltip: "Copy OpenAI base URL (use Bearer auth)",
          checked: false,
          enabled: true,
        },
        SysTray.separator,
        {
          title: "Quit",
          tooltip: "Stop the local API",
          checked: false,
          enabled: true,
        },
      ],
    },
    copyDir: true,
    debug: false,
  });

  void tray.onClick(async (action) => {
    // Left-click on icon (no item) or "Open settings"
    if (action.item == null || action.seq_id === 0) {
      await open(settingsUrl());
      return;
    }

    if (action.seq_id === 1) {
      const url = `${baseUrl(controllers.getConfig())}/v1`;
      try {
        await copyToClipboard(url);
      } catch {
        await open(settingsUrl());
      }
      return;
    }

    if (action.seq_id === 3) {
      await tray.kill(false);
      await controllers.onQuit();
    }
  });

  return tray;
}

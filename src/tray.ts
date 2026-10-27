import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { baseUrl, requestLogPath, type AppConfig } from "./config.js";

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
    sendAction: (action: {
      type: "update-item";
      item: {
        title: string;
        tooltip: string;
        checked?: boolean;
        enabled?: boolean;
      };
      seq_id?: number;
    }) => Promise<unknown>;
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

const ITEM_OPEN_STATUS = 0;
const ITEM_COPY_URL = 1;
const ITEM_OPEN_LOGS = 2;
// 3 = separator
const ITEM_START_AT_LOGIN = 4;
// 5 = separator
const ITEM_QUIT = 6;

export interface TrayControllers {
  getConfig: () => AppConfig;
  setStartAtLogin: (enabled: boolean) => Promise<void>;
  onQuit: () => Promise<void> | void;
}

function iconBase64(): string {
  const iconPath = join(__dirname, "..", "assets", "tray.ico");
  return readFileSync(iconPath).toString("base64");
}

function startAtLoginItem(checked: boolean) {
  return {
    title: "Run at startup",
    tooltip: "Launch automatically when Windows starts",
    checked,
    enabled: true,
  };
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

async function openRequestLog(): Promise<void> {
  const path = requestLogPath();
  await mkdir(dirname(path), { recursive: true });
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    await writeFile(path, "", "utf8");
  }
  await open(path);
}

export function startTray(controllers: TrayControllers) {
  const settingsUrl = () => `${baseUrl(controllers.getConfig())}/ui/`;
  const loginChecked = () => Boolean(controllers.getConfig().startAtLogin);

  const tray = new SysTray({
    menu: {
      icon: iconBase64(),
      title: "Cursor OpenAI Proxy",
      tooltip: "Cursor OpenAI Proxy – click for status",
      items: [
        {
          title: "Open status",
          tooltip: "Show base URL and auth info",
          checked: false,
          enabled: true,
        },
        {
          title: "Copy base URL",
          tooltip: "Copy OpenAI base URL (use Bearer auth)",
          checked: false,
          enabled: true,
        },
        {
          title: "Open logs",
          tooltip: "Open requests.log in the default editor",
          checked: false,
          enabled: true,
        },
        SysTray.separator,
        startAtLoginItem(loginChecked()),
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
    // Left-click on icon (no item) or "Open status"
    if (action.item == null || action.seq_id === ITEM_OPEN_STATUS) {
      await open(settingsUrl());
      return;
    }

    if (action.seq_id === ITEM_COPY_URL) {
      const url = `${baseUrl(controllers.getConfig())}/v1`;
      try {
        await copyToClipboard(url);
      } catch {
        await open(settingsUrl());
      }
      return;
    }

    if (action.seq_id === ITEM_OPEN_LOGS) {
      try {
        await openRequestLog();
      } catch {
        await open(settingsUrl());
      }
      return;
    }

    if (action.seq_id === ITEM_START_AT_LOGIN) {
      const next = !loginChecked();
      try {
        await controllers.setStartAtLogin(next);
        await tray.sendAction({
          type: "update-item",
          item: startAtLoginItem(next),
          seq_id: ITEM_START_AT_LOGIN,
        });
      } catch (err) {
        console.error("Failed to update start-at-login:", err);
      }
      return;
    }

    if (action.seq_id === ITEM_QUIT) {
      await tray.kill(false);
      await controllers.onQuit();
    }
  });

  return tray;
}

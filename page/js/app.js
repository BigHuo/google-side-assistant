/* 入口：装配各模块 */

import * as store from "./store.js";
import { initChat, send, abort, onBusy } from "./chat.js";
import { initComposer, setComposerBusy } from "./composer.js";
import { initCommands } from "./commands.js";
import { initSettings } from "./settings.js";
import { initSessions } from "./sessions.js";
import { initBrand } from "./orb.js";
import { initScreenshot } from "./screenshot.js";

async function boot() {
  await store.ensureSchema();

  initSettings();
  initSessions();
  initCommands({ send }); // 功能指令的直发落点走 chat 的 send
  initComposer({ onSend: send, onAbort: abort });
  initScreenshot();
  onBusy(setComposerBusy);
  initBrand();

  await initChat();
}

boot().catch((err) => console.error("[side-assistant] 启动失败：", err));
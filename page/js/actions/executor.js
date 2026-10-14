/* 执行层：按工具的 kind 分两条通道。
   - page：面板 → background → chrome.debugger / CDP 会话落到当前标签页
   - api：面板 → background → 外部数据 API（检索等），不碰用户页面
   真实执行都在 background.js，这里只负责转发与超时兜底。 */

import { kindOf, validateArgs } from "./dsl.js";

/** 当前执行层能力 */
export function capabilities() {
  return { cdp: true, stub: false, kinds: ["page", "api"] };
}

/**
 * 执行一条动作。
 * @param {string} name 工具名，见 dsl.js 的注册表
 * @param {object} [args] 工具参数
 * @param {{tabId?: number|null}} [ctx] 发起时刻锁定的标签；后台全程用它，
 *   用户生成中途切到别的标签也不会把操作落到别的页面上
 * @returns {Promise<{ok: boolean, error?: string, summary?: string, page?: object, text?: string}>}
 */
export async function runAction(name, args = {}, { tabId = null } = {}) {
  const v = validateArgs(name, args);
  if (!v.ok) return { ok: false, error: v.error };

  const type = kindOf(name) === "api" ? "API_ACTION" : "PAGE_ACTION";

  const res = await chrome.runtime
    .sendMessage({ type, name, args, tabId })
    .catch(() => null);

  return res || { ok: false, error: "后台没有响应，试试重新打开侧边栏" };
}

/**
 * 页面操控流光开关：让目标页四边亮/熄流动光带，标识「正在被助手操纵」。
 * fire-and-forget——纯视觉反馈，失败不该影响对话流程。
 */
export function pageGlow(on, tabId = null) {
  chrome.runtime.sendMessage({ type: "PAGE_GLOW", on: !!on, tabId }).catch(() => {});
}

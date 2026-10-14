/* 技能按钮：截图入口（单击截全屏 / 拖动框选，分流与确认都在页面 overlay 上完成）。
   这是用户主动技能，不进 dsl 的模型工具注册表；不受模型是否支持图片的限制。
   流程为：面板 → SCREENSHOT → background 注入 overlay → 用户框选并点 ✓ 确认（✗/Esc 取消）
   → SHOT_RECT → 截图 → SHOT_DONE(dataUrl) → 附件条或剪贴板。 */

import { $, toast } from "./util.js";
import * as store from "./store.js";
import { addImageFiles } from "./composer.js";

export function initScreenshot() {
  $("#btnSkills").addEventListener("click", start); // 九宫格直达，不再弹菜单
  $("#miSkills").addEventListener("click", start); // 窄宽度下从「更多」菜单进

  // 结果是异步回来的：background 截完用 SHOT_DONE 推结果
  // dev 预览没有 background，onMessage 挂不上就跳过，别把整个面板的启动带崩
  chrome.runtime.onMessage?.addListener?.((msg) => {
    if (msg?.type !== "SHOT_DONE") return;
    console.log("[side-assistant] 收到截图结果", msg.ok, msg.error || "");
    if (msg.ok) attach(msg.dataUrl, msg.tabId ?? null);
    else toast(msg.error || "截图失败");
  });
}

/** 可操作标签：存在且非内置页（面板页被当标签打开时，自己会命中 chrome-extension://，要跳过） */
const operable = (t) =>
  !!t && t.id != null && !/^(chrome|edge|about|devtools|chrome-extension|view-source|file):/i.test(t.url || "");

/** 面板宿主窗口里当前激活的标签：按宿主窗口 → 本窗口 → 聚焦窗口依次取，
    全部命中内置页（面板被当成标签页打开的典型症状）才放弃 */
async function hostActiveTabId() {
  const queries = [];
  try {
    const win = await chrome.windows.getCurrent();
    if (win?.id != null) queries.push({ active: true, windowId: win.id });
  } catch {
    /* 拿不到宿主窗口，走后面的兜底 */
  }
  queries.push({ active: true, currentWindow: true }, { active: true, lastFocusedWindow: true });
  for (const q of queries) {
    try {
      const [t] = await chrome.tabs.query(q);
      if (operable(t)) return t.id;
    } catch {
      /* 下一种口径 */
    }
  }
  return null;
}

async function start() {
  // 不校验模型是否支持图片：截图不一定要在助手内用（也可能是贴到别处），一律允许
  const tabId = await hostActiveTabId();
  console.log("[side-assistant] 截图目标 tabId =", tabId);
  const res = await chrome.runtime
    .sendMessage({ type: "SCREENSHOT", tabId })
    .catch(() => null);
  if (!res) return toast("后台服务未响应，稍后重试");
  if (!res.ok) return toast(res.error || "截图失败");
  // 成功进入截图模式后不再提示：操作指引在页面 overlay 上，结果经 SHOT_DONE 回来
}

/** 截图交付：默认进附件条；关掉开关、或当前模型看不了图（放附件条也没用）时走剪贴板。
    剪贴板写要求文档聚焦：单击/拖动都发生在目标页上（焦点在那），
    经 background 注入目标页写；tabId 缺失等异常时才由面板自己试一把。 */
async function attach(dataUrl, tabId = null) {
  const [s, m] = await Promise.all([store.getSettings(), store.activeModel()]);
  const attachWanted = s.shot_attach !== false && !!m?.vision; // 只有「开关开 + 模型能看图」才进附件条
  // 开关开着却没进附件条：是「被模型挡下」而非用户所选，提示里说清原因
  const why = !m ? "未配置模型" : "当前模型不支持图片理解";
  const blockedByModel = s.shot_attach !== false && !m?.vision;

  if (!attachWanted) {
    const ok = tabId == null ? await writeHere(dataUrl) : await writeViaBackground(dataUrl, tabId);
    if (ok) return toast(blockedByModel ? `${why}，截图已复制到剪贴板` : "截图已复制到剪贴板");
    if (blockedByModel) return toast(`${why}，截图未保存`); // 看不了图就不放进附件条
    toast("剪贴板不可用，截图已放入附件条");
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await addImageFiles([new File([blob], "screenshot.png", { type: blob.type || "image/png" })]);
  } catch {
    toast("截图已生成，但放进附件条失败");
  }
}

/** 面板就地写剪贴板（面板聚焦才成立；正常不会走到，仅 tabId 缺失时的兜底尝试） */
async function writeHere(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch {
    return false;
  }
}

/** 框选路径：经 background 注入目标页写（焦点在那） */
async function writeViaBackground(dataUrl, tabId) {
  try {
    const r = await chrome.runtime.sendMessage({ type: "SHOT_CLIPBOARD", dataUrl, tabId });
    return !!r?.ok;
  } catch {
    return false;
  }
}

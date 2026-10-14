/* 输入区：自适应高度、Enter 发送、权限 / 模型下拉、窄宽度下的「更多」菜单 */

import { $, $$, toast, ICON_SUCCESS } from "./util.js";
import * as store from "./store.js";
import { openSettings, modelIconSvg } from "./settings.js";
import { handleSlashInput, commandMenuKeydown } from "./commands.js";

/* 三个权限档位各配一个图标：盾牌＝需要审批，滑杆＝自主审批，闪电＝自动执行 */
const PERM_ICON_ASK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9 12.9 3.7v4.2c0 2.8-1.9 4.9-4.9 5.9-3-1-4.9-3.1-4.9-5.9V3.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const PERM_ICON_SMART =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 4.6h10.8M2.6 11.4h10.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="6" cy="4.6" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="10.4" cy="11.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const PERM_ICON_AUTO =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.1 1.8 4 9.1h3.4L6.7 14.2 11.9 7H8.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

/* 三个权限档位：盾牌＝需要审批、滑杆＝自主审批（到设置里勾选哪些操作可放行）、闪电＝自动执行；
   tone 决定浮层与胶囊的语义色 */
const PERMISSIONS = [
  { value: "ask", label: "需要审批", icon: PERM_ICON_ASK, tone: "ok" },
  { value: "smart", label: "自主审批", icon: PERM_ICON_SMART, tone: "brand" },
  { value: "auto", label: "自动执行", icon: PERM_ICON_AUTO, tone: "warn" },
];

const FS_SUPPORTED = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

const MAX_IMAGES = 4; // 一条消息最多附带的图片数
const IMG_MAX_EDGE = 1280; // 压缩后的最长边，再大对问答没有增益、白耗上下文与存储
const IMG_JPEG_Q = 0.85;

let onSend = null; // 由 app.js 注入
let onAbort = null;
let busy = false;
let popmenu = null; // 当前展开的浮层
let popAnchor = null; // 浮层由哪个按钮展开（同一按钮再点收起，切别的按钮直接换）
let images = []; // 待发送的图片（dataURL）
let quotes = []; // 待发送的划词引用 [{text, url, title}]
let stagedCmd = null; // 已就位的指令块（来自 / 菜单或「功能指令」下拉），随下一条消息一起发送

export function initComposer({ onSend: sendHandler, onAbort: abortHandler }) {
  onSend = sendHandler;
  onAbort = abortHandler;
  bindInput();
  bindMore();
  bindImage();
  bindPermission();
  bindModel();
  bindQuote();
  document.addEventListener("sa:models-changed", refreshModelLabel);
  document.addEventListener("sa:stage-command", (e) => {
    stagedCmd = e.detail; // 再选一条就是替换，同时只挂一个指令块
    renderCmdBar();
    refreshSend();
    $("#input").focus();
  });
  refreshModelLabel();
}

/* ---------- 输入框 ---------- */

function autoGrow() {
  if (FS_SUPPORTED) return; // 支持 field-sizing 时由 CSS 接管
  const el = $("#input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

function refreshSend() {
  const btn = $("#btnSend");
  btn.classList.toggle("stop", busy); // 生成中变成停止键
  if (busy) {
    btn.disabled = false;
    btn.title = "停止生成";
    btn.setAttribute("aria-label", "停止生成");
  } else {
    // 挂着指令块时没字也允许发送（指令本身就是一条消息）；
    // draft 类（搜索：等）等用户补参数，没字不让发
    const needText = stagedCmd?.draft;
    btn.disabled =
      ((!$("#input").value.trim() && !images.length && !quotes.length && !stagedCmd) ||
        (needText && !$("#input").value.trim()));
    btn.title = "发送";
    btn.setAttribute("aria-label", "发送");
  }
}

/* ---------- 指令块：/ 菜单选中的指令停在输入框里，区别于普通文本 ---------- */

function removeStagedCmd() {
  if (!stagedCmd) return;
  stagedCmd = null;
  renderCmdBar();
  refreshSend();
}

function renderCmdBar() {
  const bar = $("#cmdBar");
  bar.textContent = "";
  bar.hidden = !stagedCmd;
  if (!stagedCmd) return;

  // 只显示英文短名徽标（/news），中文指令名不进块，保持轻量
  const chip = document.createElement("span");
  chip.className = "cmd-chip";
  const tag = document.createElement("span");
  tag.className = "cmd-chip-tag";
  tag.textContent = "/" + (stagedCmd.slash || "");
  const x = document.createElement("button");
  x.type = "button";
  x.className = "cmd-chip-x";
  x.title = "移除指令";
  x.setAttribute("aria-label", "移除指令");
  x.textContent = "×";
  x.addEventListener("click", removeStagedCmd);
  chip.append(tag, x);
  bar.appendChild(chip);
}

function bindInput() {
  const input = $("#input");
  input.addEventListener("input", () => {
    autoGrow();
    refreshSend();
    handleSlashInput(input); // 行首 "/" 唤起功能指令菜单，边输入边过滤
  });
  input.addEventListener("keydown", (e) => {
    if (commandMenuKeydown(e)) return; // 指令菜单开着时先服务它（方向键 / Enter / Esc）
    // 输入框为空时退格：先删指令块（块在文本前，退格顺序与视觉顺序一致）
    if (e.key === "Backspace" && stagedCmd && !input.value) {
      e.preventDefault();
      removeStagedCmd();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) return; // 输入法组词中不拦截
    if (e.shiftKey) return; // Shift + Enter 换行
    e.preventDefault();
    doSend();
  });
  $("#btnSend").addEventListener("click", () => (busy ? onAbort?.() : doSend()));
  refreshSend();
}

async function doSend() {
  if (busy) return;
  const input = $("#input");
  const text = input.value.trim();
  if (!text && !images.length && !quotes.length && !stagedCmd) return;

  // 带图但当前模型不支持图片理解：先拦在清空输入之前，用户的话和图都原地保留
  if (images.length) {
    const m = await store.activeModel();
    if (!m?.vision) {
      toast("当前模型不支持图片理解，请先切换模型或移除图片");
      return;
    }
  }

  // 指令块随消息一起发送：气泡里一律显示成「/英文短名 + 用户正文」
  // （短名由 chat.js 单独上色，与正文区分）；指令原文永远走隐藏上下文，模型照样收得到：
  // - draft 类（搜索：、润色这段文字：等）：draft 原文即指令
  // - 其余：prompt 即指令（可能是 async 函数，如「今日要闻」实时读来源配置）
  const cmd = stagedCmd || null;
  stagedCmd = null;
  let display = text;
  let hidden = "";
  if (cmd) {
    display = text ? "/" + cmd.slash + " " + text : "/" + cmd.slash;
    if (cmd.draft) {
      hidden = cmd.draft;
    } else {
      try {
        hidden = typeof cmd.prompt === "function" ? await cmd.prompt() : cmd.prompt || cmd.name;
      } catch {
        hidden = cmd.name; // 拼指令失败也别吞消息，至少指令名还在
      }
    }
  }

  const pics = images.splice(0); // 取走全部待发图片
  const qs = quotes.splice(0); // 取走全部待发引用
  input.value = "";
  autoGrow();
  renderAttach();
  renderCmdBar();
  refreshSend();
  onSend?.(display, pics, qs, hidden, cmd?.slash ?? "");
}

/** 由 chat 的 busy 状态驱动：生成中禁用发送 */
export function setComposerBusy(v) {
  busy = v;
  refreshSend();
}

/* ---------- 插入图片（仅图片理解模型可用） ---------- */

/* 图片按 dataURL 随消息一起存与发：先读文件、再按最长边压到 JPEG，
   兼顾 token 开销与 storage 体积（PNG 透明底填白，避免变黑块） */
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片解码失败"));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error("图片读取失败"));
    fr.readAsDataURL(file);
  });
}

async function compressImage(file) {
  const img = await readImageFile(file);
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL("image/jpeg", IMG_JPEG_Q);
}

/** 待发区的移除按钮：图片与引用共用 */
function attachX(onRemove, label) {
  const x = document.createElement("button");
  x.type = "button";
  x.className = "attach-x";
  x.textContent = "×";
  x.title = "移除";
  x.setAttribute("aria-label", label);
  x.addEventListener("click", onRemove);
  return x;
}

function renderAttach() {
  const bar = $("#attachBar");
  bar.textContent = "";
  bar.hidden = !images.length && !quotes.length;
  images.forEach((url, i) => {
    const item = document.createElement("span");
    item.className = "attach-item";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "待发送图片";
    item.append(img, attachX(() => {
      images.splice(i, 1);
      renderAttach();
      refreshSend();
    }, "移除图片"));
    bar.appendChild(item);
  });
  quotes.forEach((q, i) => {
    const item = document.createElement("span");
    item.className = "attach-quote";
    item.title = q.text; // 截断了全文，悬浮看完整内容
    const txt = document.createElement("span");
    txt.className = "attach-quote-text";
    txt.textContent = q.text;
    item.append(txt, attachX(() => {
      quotes.splice(i, 1);
      renderAttach();
      refreshSend();
    }, "移除引用"));
    bar.appendChild(item);
  });
}

/* ---------- 划词「加入对话」：引用进待发区 ---------- */

/** 收到一条划词引用；文本重复的推送（面板多实例等边缘情况）不重复入列 */
export function addQuote(q) {
  const text = String(q?.text || "").trim();
  if (!text) return false;
  if (quotes.some((x) => x.text === text)) return true;
  quotes.push({ text, url: String(q.url || ""), title: String(q.title || "") });
  renderAttach();
  refreshSend();
  return true;
}

function bindQuote() {
  // background 直推（面板开着时点「加入对话」）
  // dev 预览没有 background，onMessage 挂不上就跳过，别把启动带崩
  chrome.runtime.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (msg?.type !== "SA_QUOTE_PUSH") return;
    addQuote(msg.quote);
    toast("已加入对话");
    sendResponse?.({ got: true });
    return true; // 应答要送回 SW（它据 got 决定是否暂存），别让别的监听器先关通道
  });

  // 面板是被「加入对话」带出来的场景：内容脚本点击时面板还没加载完，
  // background 把引用暂存在 session 里，起来后拉回来补上
  chrome.runtime
    .sendMessage({ type: "SA_QUOTE_PULL" })
    .then((r) => {
      if (r?.ok && r.quote && addQuote(r.quote)) toast("已加入对话");
    })
    .catch(() => {}); // dev 预览没有 background，静默跳过
}

/** 文件选择与粘贴共用的入口：校验上限、压缩后进待发队列（截图技能也复用） */
export async function addImageFiles(files) {
  let added = false;
  for (const f of files) {
    if (images.length >= MAX_IMAGES) {
      toast(`一条消息最多附 ${MAX_IMAGES} 张图`);
      break;
    }
    if (!f.type.startsWith("image/")) continue;
    try {
      images.push(await compressImage(f));
      added = true;
    } catch {
      toast("这张图处理不了：" + f.name);
    }
  }
  if (added) {
    renderAttach();
    refreshSend();
  }
}

function bindImage() {
  const btn = $("#btnImage");
  const file = $("#fileImage");
  const pick = () => {
    if (btn.disabled) return;
    file.click();
  };
  btn.addEventListener("click", pick);
  $("#miImage").addEventListener("click", pick); // 窄宽度下从「更多」菜单进
  file.addEventListener("change", async () => {
    const files = [...file.files];
    file.value = ""; // 允许连续选同一个文件
    await addImageFiles(files);
  });

  // 直接往输入框粘贴图片（截图后 Cmd/Ctrl+V 最顺手）
  $("#input").addEventListener("paste", async (e) => {
    const pics = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!pics.length) return; // 纯文字粘贴不受影响
    e.preventDefault(); // 拦掉默认行为，避免把截图的文件名占位文本带进输入框
    const m = await store.activeModel();
    if (!m?.vision) {
      toast("当前模型不支持图片理解，请先切换模型");
      return;
    }
    await addImageFiles(pics);
  });
}

/** 图片按钮的可用性跟随当前模型：只有标记了「支持图片理解」的模型才放开 */
function refreshImageButton(m) {
  const ok = !!m?.vision;
  const btn = $("#btnImage");
  const mi = $("#miImage");
  btn.disabled = !ok;
  mi.disabled = !ok;
  btn.title = ok ? "插入图片" : "当前模型不支持图片理解";
}

/* ---------- 权限下拉 ---------- */

function bindPermission() {
  const btn = $("#ddPermission");
  const apply = (item) => {
    btn.querySelector(".pill-label").textContent = item.label;
    btn.querySelector(".pill-ic").innerHTML = item.icon; // 常量 SVG，非用户输入
    // 胶囊整体跟着档位换色（图标 / 文字 / 箭头同色），与浮层里保持一致
    btn.classList.toggle("tone-ok", item.tone === "ok");
    btn.classList.toggle("tone-brand", item.tone === "brand");
    btn.classList.toggle("tone-warn", item.tone === "warn");
  };
  // 首屏按已存设置回填文案与图标（默认 ask，与 HTML 初值一致）
  store.getSettings().then((s) => apply(PERMISSIONS.find((p) => p.value === s.permission) || PERMISSIONS[0]));
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (popmenu) { const same = popAnchor === btn; closePopmenu(); if (same) return; }
    const s = await store.getSettings();
    openPopmenu(btn, PERMISSIONS, s.permission, async (item) => {
      await store.saveSettings({ permission: item.value });
      apply(item);
      toast(item.value === "smart" ? "执行权限：自主审批（在设置里选择可放行的操作）" : "执行权限：" + item.label);
    });
  });
}

/* ---------- 模型下拉 ---------- */

/* 展示用名称：优先用模型标识（如 GLM-5.2），别名只是登记时的备注 */
const modelLabel = (m) => m.model || m.name || "未配置模型";

export async function refreshModelLabel() {
  const m = await store.activeModel();
  $("#ddModel .pill-label").textContent = m ? modelLabel(m) : "未配置模型";
  // 胶囊里跟着显示当前模型所属厂商的图标；未配置模型时留空（.pill-ic:empty 会收起）
  const ic = $("#ddModel .pill-ic");
  if (m) ic.innerHTML = await modelIconSvg(m);
  else ic.textContent = "";
  refreshImageButton(m); // 切模型 / 改配置后，图片按钮的可用性跟着变
  return m;
}

function bindModel() {
  const btn = $("#ddModel");
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (popmenu) { const same = popAnchor === btn; closePopmenu(); if (same) return; }

    const all = await store.listModels();
    if (!all.length) {
      openSettings();
      toast("先登记一个模型");
      return;
    }
    // 只列「已启用」的模型：开关关掉的只是不在下拉里出现，不改变当前使用模型
    const list = all.filter((m) => m.enabled !== false);
    if (!list.length) {
      openSettings();
      toast("没有启用的模型，去模型管理里打开一个");
      return;
    }
    // 下拉每项带上该模型的厂商图标（拉取有缓存，同一厂商只取一次）
    const icons = await Promise.all(list.map((m) => modelIconSvg(m)));
    openPopmenu(
      btn,
      list.map((m, i) => ({ value: m.id, label: modelLabel(m), on: m.active, icon: icons[i] })),
      null,
      async (item) => {
        await store.activateModel(item.value);
        document.dispatchEvent(new CustomEvent("sa:models-changed"));
        toast(item.label, { icon: ICON_SUCCESS });
      },
    );
  });
}

/* ---------- 浮层 ---------- */

function closePopmenu() {
  if (!popmenu) return;
  popmenu.remove();
  popmenu = null;
  popAnchor = null;
  $$(".pill-select").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

export function openPopmenu(anchor, items, current, onPick) {
  closePopmenu();
  const app = $(".app");
  const el = document.createElement("div");
  el.className = "popmenu";
  el.setAttribute("role", "listbox");
  // 带图标的下拉（模型 / 权限）按内容收窄，避免图标与文案被拉得过宽
  if (items.some((it) => it.icon)) el.classList.add("ic-menu");

  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "option");
    if (it.tone) b.classList.add("tone-" + it.tone); // 语义色（权限档位等）
    if (it.icon) {
      // 带图标的选项（如权限档位）：图标 + 文案，左对齐
      const ic = document.createElement("span");
      ic.className = "opt-ic";
      ic.innerHTML = it.icon; // 常量 SVG，非用户输入
      const tx = document.createElement("span");
      tx.textContent = it.label;
      b.classList.add("with-ic");
      b.append(ic, tx);
    } else {
      b.textContent = it.label;
    }
    if (it.value === current || it.on) b.classList.add("on");
    b.addEventListener("click", () => {
      closePopmenu();
      onPick(it);
    });
    el.appendChild(b);
  }

  app.appendChild(el);

  // 贴在触发按钮上方，左右不越出面板
  const appRect = app.getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  el.style.bottom = appRect.bottom - r.top + 6 + "px";
  const left = r.left - appRect.left;
  el.style.left = Math.max(8, Math.min(left, appRect.width - el.offsetWidth - 8)) + "px";

  popmenu = el;
  popAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
}

document.addEventListener("click", closePopmenu);

/* ---------- 更多菜单与未接入功能 ---------- */

function bindMore() {
  const btn = $("#btnMore");
  const menu = $("#moreMenu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  });
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest("button")) {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });
}
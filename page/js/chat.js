/* 会话：空状态、消息渲染、发送流程。
   发送走 llm.js 的真实流式调用；模型要动页面时，这里负责跑 Agent 循环、
   渲染「步骤卡片」、并在「需要审批」模式下逐条征求用户同意。 */

import { $, toast, hideToast, ICON_FILE, formatBytes } from "./util.js";
import * as store from "./store.js";
import { streamChat, summarizeChat, makeTitle } from "./llm.js";
import { renderMarkdown } from "./markdown.js";
import { CHIPS } from "./skills.js";
import {
  COMMANDS,
  stageCommand,
  applyCommand,
  openCommandMenu,
  closeCommandMenu,
  commandMenuOpen,
} from "./commands.js";
import { TOOLS, READ_ONLY_VERBS, describe, kindOf } from "./actions/dsl.js";
import { runAction, pageGlow } from "./actions/executor.js";

let sessionId = null; // 当前会话 id；null = 草稿态（还没落库，第一条消息发出时才真正建）
let messages = [];
let busy = false;
let controller = null; // 当前生成请求，用于中断
let pendingConfirm = null; // 当前等待用户点「允许 / 拒绝」的步骤
const busyListeners = new Set();

const titleRequested = new Set(); // 已经为它发起过起标题请求（失败也不重试）
const titleSettled = new Set(); // 标题已定：AI 起好了，或用户手动改过

/* ---------- 标签与会话的绑定 ---------- */

/** 面板宿主窗口里当前激活的标签（没有 tabs API 或取不到时返回 null，功能整体退化为不绑定） */
export async function currentTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t && t.id != null ? t : null;
  } catch {
    return null;
  }
}

/** 切到指定标签页（跨窗口时顺带聚焦窗口）。标签已关闭返回 false */
export async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.id == null) return false;
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null && chrome.windows?.update) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return true;
  } catch {
    return false;
  }
}

/** 切标签 / 关标签的跟随逻辑 */
function watchTabs() {
  if (!chrome.tabs?.onActivated?.addListener) return;
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    try {
      const win = await chrome.windows.getCurrent(); // 只跟随本窗口，别家窗口切标签不关我们事
      if (!win || win.id !== windowId) return;
      if (busy) return; // 正在生成，切会话会打断流式渲染，先不动
      const s = await store.latestSessionByTab(tabId);
      if (s) {
        if (s.id !== sessionId) await switchSession(s.id);
      } else {
        // 全新页面（还没绑过任何会话）：进草稿态，等第一条消息再落库
        newSession();
      }
    } catch {
      /* 监听器里出错不该影响页面 */
    }
  });
  chrome.tabs.onRemoved?.addListener?.(async (tabId) => {
    try {
      await store.unbindTab(tabId);
    } catch {
      /* 同上 */
    }
  });
}

/** 发送前的会话归属检查（tabId 用点击那一刻捕获的，见 send 里的 sendTabId：
    用户点完发送立刻切标签，这条消息的归属也不该跟着变）：
    - 草稿态（还没落库）→ 此刻才真正建会话，归属该标签
    - 当前会话还没绑过标签（旧数据 / 标签关闭后解绑）→ 绑到该标签
    - 当前会话绑在别的标签（竞态兜底）→ 另起一个属于该标签的新会话，本条消息落新会话 */
async function followTabOnSend(tabId) {
  if (tabId == null) return;
  const begin = async () => {
    const s = await store.createSession(tabId);
    sessionId = s.id;
    messages = [];
    costCache.clear();
  };
  if (sessionId == null) {
    await begin();
    return;
  }
  const cur = await store.getSession(sessionId);
  if (!cur) {
    await begin(); // 指着的会话已不存在（别的面板删了）：重建一个接着用
    return;
  }
  if (cur.tab_id === tabId) return;
  if (cur.tab_id == null) {
    await store.bindSession(cur.id, tabId);
    return;
  }
  await begin();
}

/** 订阅「生成中」状态变化，app.js 用它开关发送按钮 */
export function onBusy(fn) {
  busyListeners.add(fn);
}

function setBusy(v) {
  busy = v;
  for (const fn of busyListeners) fn(v);
}

/* ---------- 启动 ---------- */

export async function initChat() {
  renderChips();

  // 面板打开时对齐当前标签：这个标签绑过会话就切到最近的那个；
  // 全新页面（没绑过任何会话）进草稿态，等第一条消息再真正建会话
  const tab = await currentTab();
  const follow = tab ? await store.latestSessionByTab(tab.id) : null;
  if (follow) {
    await store.setCurrentSession(follow.id);
    sessionId = follow.id;
    messages = await store.getMessages(sessionId);
  } else {
    sessionId = null;
    messages = [];
  }
  renderAll();
  bindCtxGauge();
  watchTabs();
}

/** 面板当前会话 id（草稿态为 null），会话列表用它判断高亮行 */
export const currentId = () => sessionId;

/** 新建会话：先进草稿态（不落库），第一条消息发出时才真正存储，避免空会话堆积 */
export function newSession() {
  if (busy) return;
  sessionId = null;
  messages = [];
  renderAll();
  notifySessions();
}

/** 会话列表变了（新建 / 切换 / 改名 / 删除 / 更新）时广播，供面板刷新 */
const notifySessions = () => document.dispatchEvent(new CustomEvent("sa:sessions-changed"));

export function isBusy() {
  return busy;
}

/** 切到另一个会话；生成中不允许切换。
    已经绑定别的标签的会话不允许在这边打开：它聊的是那个页面的内容，
    工具也会落在那个页面上，跨页面用只会串上下文，想用就切到那个页面去。 */
export async function switchSession(id) {
  if (busy || id === sessionId) return false;
  const target = await store.getSession(id);
  if (!target) return false;
  if (target.tab_id != null) {
    const tab = await currentTab();
    if (tab && tab.id !== target.tab_id) {
      toast("这个会话属于另一个页面，切到那个页面再打开它");
      return false;
    }
  }
  if (!(await store.setCurrentSession(id))) return false;
  sessionId = id;
  messages = await store.getMessages(id);
  renderAll();
  notifySessions();
  return true;
}

/** 删除会话；若删的是当前会话，接回同标签最近的那个，没有就进草稿态 */
export async function removeSession(id) {
  if (busy) return false;
  await store.deleteSession(id);
  if (id === sessionId) {
    const tab = await currentTab();
    const follow = tab ? await store.latestSessionByTab(tab.id) : null;
    if (follow) {
      await store.setCurrentSession(follow.id);
      sessionId = follow.id;
      messages = await store.getMessages(sessionId);
    } else {
      sessionId = null; // 这个页面没有别的会话了：回草稿态，下一条消息再建
      messages = [];
    }
    renderAll();
  }
  notifySessions();
  return true;
}

export async function renameSession(id, title) {
  await store.renameSession(id, title);
  titleSettled.add(id); // 用户手动改了名，别再被兜底标题覆盖
  notifySessions();
}

/* ---------- 渲染 ---------- */

function renderChips() {
  const box = $("#chips");
  box.textContent = "";
  for (const chip of CHIPS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = chip.label;
    if (typeof chip.prompt === "function") {
      // 动态指令（如今日要闻实时读来源配置）：直发，气泡只显示短语、完整指令走隐藏上下文
      b.addEventListener("click", () => applyCommand(chip));
    } else {
      // 快捷位就是一键直发，无需二次确认（draft 类如「文献调研探索」也一样：
      // 没给方向时模型会按提示词先问一句研究对象）
      b.addEventListener("click", () => send(chip.label));
    }
    box.appendChild(b);
  }
  appendCmdToggle(box);
}

/** 「功能指令」下拉入口：与快捷 chips 同行，收在队尾。
    选中后的落点与 chips 完全一致（有 draft 预填、否则直发）。 */
function appendCmdToggle(box) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip cmd-toggle";
  b.title = "功能指令：输入 / 也可随时唤起";
  b.setAttribute("aria-haspopup", "listbox");
  b.setAttribute("aria-expanded", "false");
  b.append("功能指令");
  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("viewBox", "0 0 16 16");
  caret.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 6.4 8 10.2l4-3.8");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  caret.appendChild(path);
  b.appendChild(caret);
  b.addEventListener("click", (e) => {
    e.stopPropagation(); // 别让 document 的收起监听把刚打开的菜单立刻关掉
    if (commandMenuOpen()) {
      closeCommandMenu();
      return;
    }
    const ok = openCommandMenu(b);
    if (ok) b.setAttribute("aria-expanded", "true");
    else toast("功能指令都已关闭，可在设置 → 功能指令中开启");
  });
  box.appendChild(b);
}

function renderAll() {
  hideStatus(); // 重新渲染说明没在生成，状态行不该留着
  const box = $("#msgs");
  box.textContent = "";
  costCache.clear(); // 会话级缓存：换会话后旧键不再需要，顺手控住内存
  for (const m of messages) renderMessage(box, m);

  const has = messages.length > 0;
  box.hidden = !has;
  $("#empty").hidden = has;
  if (has) scrollToEnd(true);
  refreshCtxGauge(); // 消息变了（切换 / 新建 / 删除会话），占用圆环跟着重算
}

/** 助手消息可能是「思考块 + 气泡 + 步骤卡片」交替的序列（blocks），按存的顺序还原；
   没有 blocks 的旧数据退化成单个气泡。
   每块都打上 data-id（消息 id），回答末尾再补一行「复制 / 撤回 / 删除」操作。 */
function renderMessage(box, m) {
  const blocks = m.role === "assistant" && m.status !== "error" ? m.blocks : null;
  if (!Array.isArray(blocks) || !blocks.length) {
    box.appendChild(msgEl(m));
    if (isAnswer(m)) box.appendChild(turnActions(m));
    return;
  }
  for (const b of blocks) {
    let el = null;
    if (b.type === "step") el = stepEl(b);
    else if (b.type === "think" && b.text) el = thinkEl(b); // 空思考块（模型没吐）不还原
    else el = bubbleEl(m, b.text, false);
    el.dataset.id = String(m.id); // 让删除操作能按消息 id 定位这一轮的所有元素
    box.appendChild(el);
  }
  if (isAnswer(m)) box.appendChild(turnActions(m));
}

/** 已完结的助手回答（非流式、非用户消息）才挂操作行 */
function isAnswer(m) {
  return m.role === "assistant" && m.status !== "streaming";
}

function msgEl(m) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role + (m.status === "error" ? " error" : "");
  wrap.dataset.id = String(m.id);

  // 划词引用卡：气泡上方逐条展示（截断两行，悬浮看全文）
  if (m.role === "user" && Array.isArray(m.quotes) && m.quotes.length) {
    for (const q of m.quotes) wrap.appendChild(quoteEl(q));
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (m.status === "streaming" ? " streaming" : "");
  // 助手回答按 Markdown 渲染（渲染器只产出白名单标签，不会放行原始 HTML）；
  // 用户消息与错误提示保持纯文本（带指令短名的，短名单独上色，正文仍是纯文本）
  if (m.role === "assistant" && m.status !== "error") {
    bubble.innerHTML = renderMarkdown(m.content);
  } else if (m.role === "user" && m.cmd) {
    const tag = document.createElement("span");
    tag.className = "msg-cmd";
    tag.textContent = "/" + m.cmd;
    bubble.appendChild(tag);
    const prefix = "/" + m.cmd;
    const rest = m.content.startsWith(prefix) ? m.content.slice(prefix.length) : m.content;
    if (rest) bubble.appendChild(document.createTextNode(rest));
  } else {
    bubble.textContent = m.content;
  }
  wrap.appendChild(bubble);

  // 用户消息附带的图片：气泡下方一排只读缩略图（不可点击，避免误触打开新标签页）
  if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
    const strip = document.createElement("div");
    strip.className = "msg-imgs";
    for (const url of m.images) {
      const im = document.createElement("img");
      im.src = url;
      im.alt = "用户发送的图片";
      im.loading = "lazy";
      strip.appendChild(im);
    }
    wrap.appendChild(strip);
  }

  // 用户消息附带的文件：只显示文件名与大小，正文只给模型读，不刷屏
  if (m.role === "user" && Array.isArray(m.files) && m.files.length) {
    const strip = document.createElement("div");
    strip.className = "msg-files";
    for (const f of m.files) {
      const chip = document.createElement("span");
      chip.className = "msg-file";
      chip.title = `${f.name} · ${formatBytes(f.size)}`;
      chip.innerHTML = ICON_FILE; // 常量 SVG，非用户输入
      const name = document.createElement("span");
      name.className = "msg-file-name";
      name.textContent = f.name;
      const size = document.createElement("span");
      size.className = "msg-file-size";
      size.textContent = formatBytes(f.size);
      chip.append(name, size);
      strip.appendChild(chip);
    }
    wrap.appendChild(strip);
  }

  return wrap;
}

/** 单独造一个指定文本的气泡：msgEl 的窄接口，供按块还原时逐段使用 */
function bubbleEl(m, text, streaming) {
  return msgEl({
    id: m.id,
    role: m.role,
    content: text || "",
    status: streaming ? "streaming" : "ok",
  });
}

/** 划词引用卡：与图片缩略图同款的「附件」展示，单行超出省略 */
function quoteEl(q) {
  const el = document.createElement("div");
  el.className = "msg-quote";
  el.title = q.text; // 截断了全文，悬浮看完整内容
  const txt = document.createElement("div");
  txt.className = "q-text";
  txt.textContent = q.text;
  el.appendChild(txt);
  return el;
}

/* ---------- 回答末尾的操作行（复制 / 删除） ---------- */

const TURN_ICONS = {
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.7"/><path d="M10.2 3.6H4.7A1.5 1.5 0 0 0 3.2 5.1v5.5"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 3.4 3.2 6.6l3.2 3.2"/><path d="M3.2 6.6h6.2a3.8 3.8 0 0 1 0 7.6H7.8"/></svg>',
  del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.6h10"/><path d="M6.4 4.6V3.4c0-.4.3-.8.8-.8h1.6c.5 0 .8.4.8.8v1.2"/><path d="M4.8 4.6l.5 7.6c.1.5.5.9 1 .9h3.4c.5 0 .9-.4 1-.9l.5-7.6"/></svg>',
};

/** 回答结束时间：2026-8-15 05:33:66（年月日不补零，时分秒补两位） */
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 回答末尾右下角的操作行：左侧标回答结束时间，右侧是「复制 / 撤回 / 删除」。
    用 data-id 标记所属消息，操作时按它整体定位该轮的所有元素。 */
function turnActions(m) {
  const row = document.createElement("div");
  row.className = "turn-acts";
  row.dataset.id = String(m.id);

  const time = document.createElement("span");
  time.className = "turn-time";
  time.textContent = fmtTime(m.finished_at || m.created_at);

  const btns = document.createElement("span");
  btns.className = "turn-btns";

  const mk = (kind, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "turn-btn " + kind;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = TURN_ICONS[kind];
    b.addEventListener("click", onClick);
    return b;
  };

  btns.append(
    mk("copy", "复制这条回答", () => copyAnswer(m)),
    mk("undo", "撤回本次提问并回填输入框", () => undoAsk(m)),
    mk("del", "删除这轮提问与回答", () => removeTurn(m.id)),
  );
  row.append(time, btns);
  return row;
}

/** 复制整条回答（原始 Markdown 文本），成功后给个轻提示 */
async function copyAnswer(m) {
  const text = String(m.content || "").trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制这条回答");
  } catch {
    toast("复制失败，请手动选择文本复制");
  }
}

/** 摘掉一整轮（用户提问 + 助手回答）的界面与内存数据，返回被摘掉的用户消息 */
function dropTurn(id) {
  const i = messages.findIndex((m) => String(m.id) === String(id));
  if (i < 0) return null;

  const user = messages[i - 1]?.role === "user" ? messages[i - 1] : null; // 这轮的用户提问
  const ids = new Set([String(id)]);
  if (user) ids.add(String(user.id));
  messages = messages.filter((m) => !ids.has(String(m.id)));

  const box = $("#msgs");
  for (const el of [...box.children]) if (ids.has(el.dataset.id)) el.remove();

  if (!messages.length) {
    // 整段对话被清空：回到空状态
    box.hidden = true;
    $("#empty").hidden = false;
  }
  return user;
}

/** 删除整轮问答：连同它前面的用户提问一起摘掉，界面与存储同步更新 */
async function removeTurn(id) {
  if (busy) return; // 生成中不动历史，避免和流式渲染抢 DOM
  if (!dropTurn(id)) return;
  await persist();
  refreshCtxGauge(); // 删掉一轮，占用回落
}

/** 撤回本轮提问：摘掉这一轮，并把原问题（含附件、指令块）还原到输入框 */
async function undoAsk(m) {
  if (busy) {
    toast("生成中，先停止再撤回");
    return;
  }
  const i = messages.findIndex((x) => String(x.id) === String(m.id));
  const user = i > 0 && messages[i - 1]?.role === "user" ? messages[i - 1] : null;
  if (!user) {
    toast("没有找到对应的提问");
    return;
  }

  dropTurn(m.id);
  await persist();
  refreshCtxGauge();
  refillAsk(user);
  toast("已撤回，提问回到输入框");
}

/** 把用户消息还原成可编辑状态：带指令的恢复指令块，正文与附件交给输入区回填 */
function refillAsk(user) {
  let text = String(user.content || "");
  // 纯图 / 纯文件 / 纯引用消息存的是占位文案，回填时不要把它当成用户原话
  if (
    (user.images?.length && text === "（图片）") ||
    (user.files?.length && text === "（文件）") ||
    (user.quotes?.length && text === "（见下方引用内容）")
  ) {
    text = "";
  }

  const cmd = user.cmd ? COMMANDS.find((c) => c.slash === user.cmd) : null;
  if (cmd) {
    const prefix = "/" + cmd.slash;
    text = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
    stageCommand(cmd); // 先恢复 /xxx 指令块，再回填正文
  }

  document.dispatchEvent(
    new CustomEvent("sa:restore-ask", {
      detail: {
        text,
        quotes: user.quotes || [],
        images: user.images || [],
        files: user.files || [],
        clearCmd: !cmd, // 原提问没有指令时，别把输入区里旧的指令块带进来
      },
    }),
  );
}

function scrollToEnd(force) {
  const stage = $("#stage");
  const nearBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 80;
  if (force || nearBottom) stage.scrollTop = stage.scrollHeight;
}

/* ---------- 生成状态 ---------- */

/* 生成期间在消息末尾显示「头像 + 当前在干什么」。
   以前等第一个字时界面上什么都没有，看着像卡住了，这里把状态讲清楚。 */
const STATUS = {
  request: "请求中…", // 请求已发出，还没收到第一个字
  answering: "回答中…", // 正在流式输出
  acting: "执行中…", // 正在操作页面，细节看步骤卡片
  confirm: "等待你确认…", // 「需要审批」模式下等用户点允许 / 拒绝
};

let statusNow = ""; // 当前状态文案，用来避免同一状态被反复重写

function showStatus(label) {
  const box = $("#genStatus");
  if (!box || statusNow === label) return;
  statusNow = label;
  $("#genStatusText").textContent = label;
  box.hidden = false;
  scrollToEnd();
}

function hideStatus() {
  statusNow = "";
  const box = $("#genStatus");
  if (box) box.hidden = true;
}

/* ---------- 步骤卡片（Agent 的一举一动） ---------- */

/** 步骤卡片的纯 DOM 构造：运行时和「重开面板后还原」都走这里，结构和样式保持一致 */
function stepEl(b) {
  const el = document.createElement("div");
  el.className = "step";
  el.dataset.state = b.state || "done";

  const dot = document.createElement("span");
  dot.className = "step-dot";
  const text = document.createElement("span");
  text.className = "step-text";
  text.textContent = b.note ? `${b.desc} · ${b.note}` : b.desc;
  el.append(dot, text);

  return el;
}

/** 落一条步骤：同时记进 blocks，重启后还能还原出来 */
function appendStep(desc, blocks, mid) {
  const block = { type: "step", desc, state: "running", note: "" };
  if (blocks) blocks.push(block);

  const el = stepEl(block);
  if (mid != null) el.dataset.id = String(mid); // 供整轮删除时定位
  const text = el.querySelector(".step-text");
  $("#msgs").appendChild(el);
  scrollToEnd(true);

  return {
    set(state, note) {
      block.state = state;
      block.note = note || "";
      el.dataset.state = state;
      text.textContent = note ? `${desc} · ${note}` : desc;
      scrollToEnd();
    },
    /** 等用户点「允许 / 拒绝」；abort() 会直接判为拒绝 */
    ask() {
      el.dataset.state = "pending";
      return new Promise((resolve) => {
        const finish = (v) => {
          if (pendingConfirm === finish) pendingConfirm = null;
          acts.remove();
          resolve(v);
        };
        const mk = (cls, label, val) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "step-btn " + cls;
          b.textContent = label;
          b.addEventListener("click", () => finish(val));
          return b;
        };
        const acts = document.createElement("span");
        acts.className = "step-acts";
        acts.append(mk("ok", "允许", true), mk("no", "拒绝", false));
        el.appendChild(acts);
        pendingConfirm = finish;
        scrollToEnd(true);
      });
    },
  };
}

/* ---------- 思考块（思维链） ---------- */

/* 思考内容与正文分开展示：限高内滚动（不把页面顶长）、等宽字体、更暗的配色，
   点标题随时展开 / 收起。生成中默认展开，结束后自动收起。 */

const thinkDurLabel = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};

/** 思考块的 DOM 构造：运行时与「重开面板后还原」共用 */
function thinkEl(block) {
  const el = document.createElement("div");
  el.className = "think";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "think-head";
  const arrow = document.createElement("span");
  arrow.className = "think-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML =
    '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const title = document.createElement("span");
  title.className = "think-title";
  title.textContent = block.label || "思考过程";
  head.append(arrow, title);

  const body = document.createElement("div");
  body.className = "think-body";
  const text = document.createElement("div");
  text.className = "think-text";
  // 思考内容也按 Markdown 渲染（渲染器只产白名单标签，原文里的 HTML 进不来）
  text.innerHTML = renderMarkdown(block.text || "");
  body.appendChild(text);

  head.addEventListener("click", () => el.classList.toggle("open"));
  el.append(head, body);
  return el;
}

/**
 * 运行期的思考块：首个分片到达才建 DOM（多数模型不吐思考内容，零开销）。
 * 跟随滚动只在用户没有手动往上翻时生效，翻回底部会自动恢复跟随。
 */
function makeThink(blocks, mid) {
  let el = null;
  let textEl = null;
  let bodyEl = null;
  let titleEl = null;
  let startedAt = 0;
  let finished = false;
  const block = { type: "think", text: "", label: "" };
  let follow = true;
  let paintRaf = 0;

  // 与正文气泡同一套节流：分片只累积，画面每帧最多重绘一次
  const paintNow = () => {
    paintRaf = 0;
    if (!textEl) return;
    textEl.innerHTML = renderMarkdown(block.text);
    if (follow) bodyEl.scrollTop = bodyEl.scrollHeight;
    // 卡片在限高之内不断长高（0 → 216px），外层也要跟着滚，
    // 否则卡片下沿会掉到输入区后面——上半截看着像「卡住不动了」
    scrollToEnd();
  };

  return {
    push(chunk) {
      if (!el) {
        blocks.push(block); // 首片到达才入块序：没吐思考内容的模型不落空块
        startedAt = Date.now();
        el = thinkEl(block);
        if (mid != null) el.dataset.id = String(mid); // 供整轮删除时定位
        el.classList.add("open", "live");
        textEl = el.querySelector(".think-text");
        bodyEl = el.querySelector(".think-body");
        titleEl = el.querySelector(".think-title");
        // 用户上滚就暂停跟随；贴回底部则恢复
        bodyEl.addEventListener("scroll", () => {
          follow = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 24;
        });
        $("#msgs").appendChild(el);
        scrollToEnd(true);
      }
      block.text += chunk;
      if (!paintRaf) paintRaf = requestAnimationFrame(paintNow);
    },
    finish() {
      if (!el || finished) return;
      finished = true;
      if (paintRaf) {
        cancelAnimationFrame(paintRaf); // 收起前补画最后一帧，确保思考全文已落进 DOM
        paintRaf = 0;
        textEl.innerHTML = renderMarkdown(block.text);
      }
      el.classList.remove("live");
      block.label = `思考过程 · ${thinkDurLabel(Date.now() - startedAt)}`;
      titleEl.textContent = block.label;
      el.classList.remove("open"); // 答案已出，思考默认收起，想看再点开
    },
  };
}

/* ---------- 发送 ---------- */

const nextMsgId = () => messages.reduce((mx, m) => Math.max(mx, m.id || 0), 0) + 1;
const nowISO = () => new Date().toISOString();

/* ---------- 上下文预算 ---------- */

/* 粗略估算 token：ASCII 约 4 字符 1 个，中文等非 ASCII 约 1 字符 1 个。
   不做精确分词，只为在长会话时兜住模型的上限，宁可低估也不高估。 */
function estTokens(s) {
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/**
 * 滑动窗口：从最新一条往回装，装到预算为止，更早的整段丢掉。
 * 至少保留最后一条（本轮用户提问），否则模型会答非所问。
 * @returns {{list: any[], dropped: number}}
 */
function trimByBudget(list, budget) {
  const kept = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const cost = msgCost(list[i]); // 图片按固定开销计费
    if (kept.length && used + cost > budget) return { list: kept, dropped: i + 1 };
    used += cost;
    kept.unshift(list[i]);
  }
  return { list: kept, dropped: 0 };
}

/* 本轮对话里工具回灌的正文同样要受预算约束。
   读长页面时模型会连着读很多次，历史总额度管不到它们，放任下去就会把上下文顶爆。 */
const MIN_TOOL_KEEP = 2; // 最近这几次工具结果保留全文，更早的压成摘要头
const SLIM_HEAD = 400; // 较早正文压缩后保留的开头长度，够模型记住这段讲了什么

const IMG_TOKEN_COST = 1100; // 每张图的粗略 token 开销（按最长边 1280 的估），预算裁剪用

/** 单条消息的粗略开销（含隐藏指令、tool_calls 的 JSON、附带图片、文件与划词引用） */
function rawCost(m) {
  return (
    estTokens(m.content || "") +
    estTokens(m.hidden || "") + // 隐藏指令同样发给模型，预算要一起算
    4 + // 每条消息的固定结构开销
    (m.images?.length || 0) * IMG_TOKEN_COST +
    (m.quotes || []).reduce((s, q) => s + estTokens(q.text || ""), 0) +
    (m.files || []).reduce((s, f) => s + estTokens(f.text || ""), 0) +
    (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0)
  );
}

/* 成本缓存：占用圆环与预算裁剪每轮都会重算全部历史，逐条重扫字符是纯浪费。
   按「会话 id + 消息 id」缓存，用内容长度签名校验：工具正文被压缩改写后长度变化，
   签名自动失效。工具回合的临时对象没有 id，直接现算、不进缓存。 */
const costCache = new Map(); // `${sessionId}:${id}` -> { sig, cost }

const costSig = (m) =>
  `${(m.content || "").length}|${(m.hidden || "").length}|${m.images?.length || 0}|${
    (m.quotes || []).reduce((s, q) => s + (q.text || "").length, 0)
  }|${(m.files || []).reduce((s, f) => s + (f.text || "").length, 0)}|${
    m.tool_calls ? JSON.stringify(m.tool_calls).length : 0
  }`;

function msgCost(m) {
  if (m.id == null) return rawCost(m);
  const key = `${sessionId}:${m.id}`;
  const sig = costSig(m);
  const hit = costCache.get(key);
  if (hit && hit.sig === sig) return hit.cost;
  const cost = rawCost(m);
  costCache.set(key, { sig, cost });
  return cost;
}

/** 把工具结果 JSON 里的长正文压成「开头一段 + 省略说明」，保留 ok / summary 这类关键信息 */
function slimToolContent(content) {
  try {
    const o = JSON.parse(content);
    const cut = (s) =>
      typeof s === "string" && s.length > SLIM_HEAD ? s.slice(0, SLIM_HEAD) + "…（较早读取的正文已压缩）" : s;
    if (o.page && o.page.text) o.page.text = cut(o.page.text);
    if (o.text) o.text = cut(o.text);
    return JSON.stringify(o);
  } catch {
    return content; // 不是 JSON 就别动
  }
}

/**
 * 把本轮对话压回预算内：从最旧的工具结果开始压缩正文。
 * 只改 content、不动消息结构，免得 tool_calls 与 tool 结果配对被打断。
 */
function fitConversation(list, budget) {
  let total = list.reduce((s, m) => s + msgCost(m), 0);
  if (total <= budget) return list;

  const tools = list.filter((m) => m.role === "tool" && !m._slimmed);
  const older = tools.slice(0, Math.max(0, tools.length - MIN_TOOL_KEEP));
  for (const m of older) {
    const before = msgCost(m);
    m.content = slimToolContent(m.content);
    m._slimmed = true;
    total -= before - msgCost(m);
    if (total <= budget) break;
  }
  return list;
}

/** 引用块拼进发给模型的正文：界面只展示截断卡片，模型要读的是原文 */
function quotePrefix(qs) {
  if (!Array.isArray(qs) || !qs.length) return "";
  return qs.map((q) => `【引用｜${q.title || q.url || "网页"}】\n${q.text}`).join("\n\n") + "\n\n";
}

/** 附件正文拼进发给模型的正文：界面只展示文件名与大小，模型读全文 */
function filePrefix(fs) {
  if (!Array.isArray(fs) || !fs.length) return "";
  return (
    fs
      .map((f) => {
        const text = String(f.text || "");
        const cut = text.length > FILE_TEXT_LIMIT;
        return (
          `【附件：${f.name}｜以下为完整正文】\n${text.slice(0, FILE_TEXT_LIMIT)}` +
          (cut ? "\n…（内容过长，已截断）" : "") +
          `\n【附件结束：${f.name}】`
        );
      })
      .join("\n\n") + "\n\n"
  );
}

/** 隐藏指令拼进发给模型的正文：界面气泡只显示 m.content，模型要读的是完整指令
    （功能指令的大段 prompt，如「今日要闻」，与划词引用同一处理方式） */
function hiddenPrefix(m) {
  return m.hidden ? m.hidden + "\n\n" : "";
}

/** 气泡里的「/英文短名」前缀只给用户看：发给模型时剥掉，模型读的是 hidden 里的指令原文 */
function stripCmdPrefix(m) {
  if (m.cmd) {
    const p = "/" + m.cmd;
    if (m.content === p) return "";
    return m.content.startsWith(p + " ") ? m.content.slice(p.length + 1) : m.content;
  }
  // 纯文件消息的「（文件）」只是界面占位，正文已经由 filePrefix 注入
  if (m.files?.length && m.content === "（文件）") return "";
  return m.content;
}

/** 交给模型的历史：跳过出错与空消息，role 只信 user / assistant（带图消息把 images 一并带给请求层） */
function historyItems() {
  return messages
    .filter((m) => m.content && m.status !== "error")
    .map((m) => {
      const it = {
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: hiddenPrefix(m) + quotePrefix(m.quotes) + filePrefix(m.files) + stripCmdPrefix(m),
      };
      if (m.images?.length) it.images = m.images;
      return it;
    });
}

const DEFAULT_BUDGET = 32000; // 与 store.js 的默认上下文预算保持一致
const DEFAULT_RATIO = 0.8;

/* ---------- 上下文占用仪表（发送键旁的圆环） ---------- */

/* 圆环周长（r = 15.5，与 CSS 里的 dasharray 保持一致）：JS 只改 dashoffset 画进度 */
const CG_LEN = 2 * Math.PI * 15.5;

/** 刷新发送键左侧的占用圆环：占用按「发给模型的历史」估算，与裁剪同一套口径 */
export async function refreshCtxGauge() {
  const btn = $("#ctxGauge");
  if (!btn) return;
  try {
    const settings = await store.getSettings();
    const budget = Number(settings.context_tokens) > 0 ? Number(settings.context_tokens) : DEFAULT_BUDGET;
    const ratio = Number(settings.compress_ratio) > 0 ? Number(settings.compress_ratio) : DEFAULT_RATIO;
    const used = historyItems().reduce((s, m) => s + msgCost(m), 0);
    const pct = Math.min(1, used / budget);

    btn.classList.toggle("warn", pct >= ratio && pct < 1); // 到压缩线：该准备压历史了
    btn.classList.toggle("full", pct >= 1); // 满预算：更早历史会被裁掉
    btn.querySelector(".cg-bar").style.strokeDashoffset = String(CG_LEN * (1 - pct));
    $("#ctxPct").textContent = Math.round(pct * 100) + "%";

    btn.dataset.tip = `上下文 ${Math.round(pct * 100)}% of ${budget / 1000}k`;
  } catch {
    /* 仪表是旁路能力，读不到设置就保持上次的显示 */
  }
}

function bindCtxGauge() {
  const gauge = $("#ctxGauge");
  // 鼠标悬停即显示占用明细，移开自动收起（不占用点击）
  gauge?.addEventListener("mouseenter", () => {
    const tip = gauge.dataset.tip;
    if (tip) toast(tip, { sticky: true });
  });
  gauge?.addEventListener("mouseleave", hideToast);
  // 设置页改了预算 / 阈值后，比例分母变了，圆环要重算
  document.addEventListener("sa:genparams-changed", refreshCtxGauge);
}

/** 摘要（或裁剪提示）放在最前面，其后是保留的原始消息 */
function buildMessages(kept, summary, droppedCount) {
  const head = [];
  if (summary) {
    head.push({ role: "system", content: `以下是更早对话的摘要，作为背景参考：\n${summary}` });
  } else if (droppedCount) {
    head.push({ role: "system", content: `（更早的 ${droppedCount} 条对话已超出上下文预算被省略。）` });
  }
  return [...head, ...kept];
}

/** 轻量页面信息：只给标题与网址，让模型先判断问题是否与页面相关，
    免得「与页面无关」的提问也去 read_page 拉一遍全文、白烧上下文 */
function pageHint(tab) {
  const url = String(tab?.url || "");
  if (!url) return null;
  const title = String(tab?.title || "").trim();
  const head = `当前标签页：${title || "（无标题）"}\n${url}`;
  // 内置页读不了：提前说清楚，模型就不会先撞一次 read_page 再补救
  if (!/^https?:/i.test(url)) {
    return head + "\n（这是浏览器内置页面，read_page / click 等无法直接操作；需要网页内容时先用 goto 打开目标网址，或用 search_web 搜索）";
  }
  return head;
}

/**
 * 组装本轮发给模型的历史：
 * 估算占用达到「预算 × 压缩阈值」时，用一次调用把最旧的一段压成摘要，
 * 摘要按会话缓存（记到某条消息 id 为止），之后每轮复用，只压缩新越界的部分。
 * 压缩失败就退化为硬裁剪，绝不阻塞对话。
 */
async function buildConversation(settings, signal, blocks, mid) {
  const budget = Number(settings.context_tokens) > 0 ? Number(settings.context_tokens) : DEFAULT_BUDGET;
  const ratio = Number(settings.compress_ratio) > 0 ? Number(settings.compress_ratio) : DEFAULT_RATIO;

  const items = historyItems();
  if (!items.length) return [];

  const { list: kept, dropped } = trimByBudget(items, budget * ratio);
  if (!dropped) return kept; // 没到阈值，原样发

  const older = items.slice(0, dropped);
  const cached = await store.getSummary(sessionId);

  // 已经压过的部分不重复压，只处理缓存边界之后的新内容
  const fresh = older.filter((it) => !cached || it.id > cached.upto);
  if (!fresh.length) return buildMessages(kept, cached.text, 0);

  const step = appendStep(`精炼上下文（压缩 ${fresh.length} 条历史）`, blocks, mid);
  step.set("running");
  try {
    const text = await summarizeChat(cached?.text || "", fresh, { signal });
    await store.saveSummary(sessionId, { upto: fresh[fresh.length - 1].id, text });
    step.set("done", "已生成摘要");
    return buildMessages(kept, text, 0);
  } catch (err) {
    if (err?.name === "AbortError") {
      step.set("denied", "已停止");
      throw err;
    }
    // 压缩只是优化项，失败就退回硬裁剪，把对话让出去
    step.set("fail", (err?.message || "压缩失败") + "，本次改用裁剪");
    return buildMessages(kept, null, dropped);
  }
}

/** 中断当前生成（生成中发送键会变成停止键） */
export function abort() {
  if (pendingConfirm) pendingConfirm(false); // 卡在审批上时，停止 = 拒绝并收尾
  controller?.abort();
}

const toApiCall = (c) => ({
  id: c.id,
  type: "function",
  function: { name: c.name, arguments: c.arguments || "{}" },
});

function safeParse(s) {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

const TOOL_TEXT_LIMIT = 14000; // 工具正文回灌上限：太长容易把下一轮顶出模型的上下文窗口
const FILE_TEXT_LIMIT = 20200; // 单个附件注入上限（比上传截断多留一点，保住截断提示）

/** 正文超过上限就只留前一段并标明截断（整串 JSON 直接 slice 会截成残缺 JSON，模型读不懂） */
function clipText(s, note) {
  if (typeof s !== "string" || s.length <= TOOL_TEXT_LIMIT) return s;
  note.truncated = `正文过长，此处只含前 ${TOOL_TEXT_LIMIT} 字`;
  return s.slice(0, TOOL_TEXT_LIMIT);
}

/** 检索类结果（results 数组）的尺寸守卫：先压摘要长度，还不够就截条目数。
    条目可能是论文（abstract）也可能是搜索结果（snippet），只压存在的字段，
    不要给 SERP 条目凭空补一个空 abstract。 */
function clipResults(items, note) {
  const list = items.map((p) => {
    if (!p || typeof p !== "object") return p;
    const q = { ...p };
    if ("abstract" in q) q.abstract = String(q.abstract || "").slice(0, 400);
    if ("snippet" in q) q.snippet = String(q.snippet || "").slice(0, 300);
    return q;
  });
  const s = JSON.stringify(list);
  if (s.length <= TOOL_TEXT_LIMIT) return list;
  const avg = s.length / list.length || 1;
  const keep = Math.min(list.length, Math.max(3, Math.floor((TOOL_TEXT_LIMIT * 0.9) / avg)));
  note.truncated = `命中 ${list.length} 条，正文过长只回传前 ${keep} 条，可用更窄的关键词分批检索`;
  return list.slice(0, keep);
}

/** 回给模型的结果：去掉内部字段，并给正文设个上限防止上下文失控。
    api 类工具（如 search_papers）的 query/note/results 也要透传，
    否则模型只看到 {"ok":true}，拿不到论文数据就会无意义地反复重试。 */
function toolResult(c, res) {
  const out = { ok: !!res.ok };
  if (res.summary) out.summary = res.summary;
  if (res.error) out.error = res.error;
  if (res.query != null) out.query = res.query;
  if (res.note) out.note = res.note;
  if (Array.isArray(res.results)) out.results = clipResults(res.results, out);
  if (res.page) out.page = res.page; // read_page 的正文在 page.text 里，同样要限
  if (out.page && out.page.text) out.page.text = clipText(out.page.text, out);
  if (res.text) out.text = clipText(res.text, out);
  return { role: "tool", tool_call_id: c.id, content: JSON.stringify(out) };
}

/** 发送一条消息。
 *  @param {string} text 气泡里展示、也发给模型的用户正文
 *  @param {string[]} [pics] 附图（data URL）
 *  @param {{text,url,title}[]} [qs] 划词引用
 *  @param {string} [hidden] 隐藏指令：不进气泡，只在组装模型历史时拼在正文前
 *    （功能指令的大段 prompt 走这里，用户只看到短语）
 *  @param {string} [cmd] 指令英文短名（如 survey）：气泡里以蓝色「/短名」前缀展示，
 *    组装模型历史时剥掉，模型读的是 hidden 里的指令原文
 *  @param {{name,size,type,text}[]} [attached] 文本附件，正文注入模型上下文 */
export async function send(text, pics = [], qs = [], hidden = "", cmd = "", attached = []) {
  const body = String(text || "").trim();
  const images = (pics || []).filter((p) => typeof p === "string" && p.startsWith("data:image/"));
  const quotes = (qs || [])
    .filter((q) => q && typeof q.text === "string" && q.text.trim())
    .map((q) => ({ text: q.text.trim(), url: String(q.url || ""), title: String(q.title || "") }));
  const files = (attached || [])
    .filter((f) => f && typeof f.text === "string" && f.text.trim() && f.name)
    .map((f) => ({
      name: String(f.name).slice(0, 160),
      size: Number(f.size) || 0,
      type: String(f.type || ""),
      text: String(f.text).slice(0, FILE_TEXT_LIMIT),
    }));
  if ((!body && !images.length && !quotes.length && !files.length) || busy) return;

  // 带图但当前模型不支持图片理解：直接拦下，别让消息发出去白跑一趟报错
  if (images.length) {
    const m = await store.activeModel();
    if (!m?.vision) {
      toast("当前模型不支持图片理解，请先切换模型或移除图片");
      return;
    }
  }

  // 纯附件无字时补个占位，历史组装按 content 过滤，空串会被丢掉
  const content = body || (files.length ? "（文件）" : images.length ? "（图片）" : "（见下方引用内容）");

  // 点击发送那一刻的页面：本轮会话归属与所有页面工具都锁定它。
  // 模型出工具调用往往要等几秒，期间用户切去别的标签，也不能把「总结当前页面」落到别的页面上。
  const sendTab = await currentTab();
  const sendTabId = sendTab?.id ?? null;

  // 先做会话归属检查：会话跟当前标签对不上时可能换/建会话，之后的 messages 才是最终落点
  await followTabOnSend(sendTabId);

  const settings = await store.getSettings();

  setBusy(true);
  $("#empty").hidden = true;
  $("#msgs").hidden = false;

  const user = { id: nextMsgId(), role: "user", content, status: "ok", created_at: nowISO() };
  if (hidden) user.hidden = String(hidden); // 隐藏指令随消息落库，重启后仍在模型上下文里
  if (cmd) user.cmd = String(cmd); // 指令短名：只用于气泡里的蓝色前缀，不进模型上下文
  if (images.length) user.images = images;
  if (files.length) user.files = files;
  if (quotes.length) user.quotes = quotes;
  messages.push(user);
  $("#msgs").appendChild(msgEl(user));
  scrollToEnd(true);

  // 首次提问：先用提问原句兜个标题，列表当场就有名字（不等回答写完）；
  // 同时让模型起个更好的，回来再顶上
  if (
    messages.filter((m) => m.role === "user").length === 1 &&
    !titleRequested.has(sessionId) &&
    !titleSettled.has(sessionId)
  ) {
    titleRequested.add(sessionId);
    const fallbackTitle = body || (quotes.length ? quotes[0].text : files.length ? files[0].name : content); // 纯附件时用文件名兜底
    store.touchSession(sessionId, { title: fallbackTitle.slice(0, 16) }).then(notifySessions);
    autoTitle(sessionId, fallbackTitle);
  }

  showStatus(STATUS.request); // 先亮状态，别让用户对着空屏等

  const reply = {
    id: nextMsgId(),
    role: "assistant",
    content: "",
    status: "streaming",
    created_at: nowISO(),
    blocks: [], // 气泡与步骤卡片的先后顺序，随消息一起落库
  };
  messages.push(reply);

  // 思考卡：每一轮独立一张（先思考后行动，轮与轮的先后顺序才看得出来）；
  // 无思考内容的模型整轮零开销（首片到达才建 DOM、才落块）
  let think = null;

  // 回答气泡按需创建：工具执行前先「封口」，之后的文字另起一个，步骤卡片就夹在中间
  let el = null;
  let bubble = null; // 当前正在写的那个气泡
  let bubbleText = ""; // 当前气泡自己的文本（answer 是全部气泡的合集）
  let bubbleBlock = null; // 当前气泡在 reply.blocks 里的记录

  // 流式重绘节流：分片只累加文本，真正重绘最多每帧一次。
  // 全量 Markdown 重渲染随回答长度线性增长，逐片重画会让整条回答退化成 O(n²)。
  let paintRaf = 0;
  const paintNow = () => {
    paintRaf = 0;
    if (!bubble) return;
    bubble.innerHTML = renderMarkdown(bubbleText);
    scrollToEnd();
  };
  const schedulePaint = () => {
    if (!paintRaf) paintRaf = requestAnimationFrame(paintNow);
  };

  const newBubble = () => {
    bubbleBlock = { type: "text", text: "" };
    reply.blocks.push(bubbleBlock);
    el = bubbleEl(reply, "", true);
    bubble = el.querySelector(".bubble");
    bubbleText = "";
    $("#msgs").appendChild(el);
    scrollToEnd(true);
  };
  const showText = (chunk) => {
    if (!bubble) newBubble();
    showStatus(STATUS.answering);
    bubbleText += chunk;
    answer += chunk;
    bubbleBlock.text = bubbleText;
    schedulePaint();
  };
  // 封口：先补画最后一帧，再摘掉 streaming 类并丢引用，否则该气泡的光标会一直闪下去
  const sealBubble = () => {
    if (paintRaf) {
      cancelAnimationFrame(paintRaf);
      paintRaf = 0;
    }
    if (bubble) {
      bubble.innerHTML = renderMarkdown(bubbleText);
      bubble.classList.remove("streaming");
    }
    bubble = null;
    bubbleBlock = null;
  };

  controller = new AbortController();

  const perm = settings.permission; // ask = 需要审批 | smart = 自主审批 | auto = 自动执行
  const skipManual = Array.isArray(settings.approval_skip) ? settings.approval_skip : [];
  // 是否要弹「允许 / 拒绝」：非只读动作在 auto 下全放行；smart 下放行用户勾选的清单；ask 下全都要问
  const needConfirm = (name) => {
    if (perm === "auto" || READ_ONLY_VERBS.includes(name)) return false;
    if (perm === "smart" && skipManual.includes(name)) return false;
    return true;
  };
  const budget = Number(settings.context_tokens) > 0 ? Number(settings.context_tokens) : DEFAULT_BUDGET;
  // 工具轮次上限：设置里可调（保存时已夹 1–30），这里再兜一次防脏数据
  const maxRounds = Math.min(Math.max(Math.round(Number(settings.max_rounds) || 10), 1), 30);

  let answer = "";
  let failure = null;
  let tail = ""; // 中断 / 异常收尾时要追加到当前气泡结尾的文案
  let ranTools = false; // 这轮对话里是否真的执行过工具
  let glowLit = false; // 页面流光是否已点亮（整轮只点一次，收尾统一熄）

  try {
    // 组装历史：超过压缩阈值就先跑一次压缩调用（步骤卡片会记在气泡前面）
    const conversation = await buildConversation(settings, controller.signal, reply.blocks, reply.id);
    const hint = pageHint(sendTab);
    if (hint) conversation.unshift({ role: "system", content: hint }); // 每轮现取，不落库

    let round = 0;
    for (; round < maxRounds; round++) {
      let roundText = "";
      let calls = [];
      think = makeThink(reply.blocks, reply.id); // 本轮的思考只进这张卡，下一轮另起一张

      fitConversation(conversation, budget); // 本轮工具结果也要吃预算，超了就把最早的长正文压掉
      showStatus(STATUS.request); // 每轮都是先等模型开口，收到字才会变「回答中」
      for await (const ev of streamChat(conversation, { signal: controller.signal, tools: TOOLS })) {
        if (ev.type === "reasoning") {
          think.push(ev.value);
        } else if (ev.type === "text") {
          roundText += ev.value;
          showText(ev.value);
        } else if (ev.type === "tool_calls") {
          calls = ev.calls;
        }
      }

      if (!calls.length) {
        // 工具已经跑完，这一轮本该给结论；可模型一个字都没回，多半是页面太长把上下文顶爆了。
        // 这里必须说清楚，否则界面上只停在中转语上，看着像「说了要总结却没总结」。
        if (ranTools && !roundText.trim()) {
          tail = "（页面已经读完，但模型没有继续输出结论。多半是页面内容太长、超出了模型的上下文上限，可以换个说法再问一次，或换用上下文更大的模型）";
        }
        break; // 纯文字回答，收工
      }
      ranTools = true;

      sealBubble(); // 先封口，工具跑完后的文字会另起一个气泡，排在步骤卡片后面
      think.finish(); // 本轮思考到此为止：收起这张卡，后面的步骤卡排在它之后，时序不乱
      conversation.push({ role: "assistant", content: roundText || "", tool_calls: calls.map(toApiCall) });

      for (const c of calls) {
        if (controller.signal.aborted) break;

        // 首个会动页面的工具执行前点亮四边流光（纯检索类 API 不碰页面，不点）
        if (!glowLit && kindOf(c.name) === "page") {
          glowLit = true;
          pageGlow(true, sendTabId);
        }

        const args = safeParse(c.arguments);
        const step = appendStep(describe(c.name, args), reply.blocks, reply.id);

        if (needConfirm(c.name)) {
          showStatus(STATUS.confirm);
          const allowed = await step.ask();
          showStatus(STATUS.acting); // 无论允许还是拒绝，这一步都不再等用户了
          if (!allowed) {
            step.set("denied", "已跳过");
            conversation.push(toolResult(c, { ok: false, error: "用户拒绝执行这一步" }));
            continue;
          }
        }
        if (controller.signal.aborted) {
          step.set("denied", "已停止");
          break;
        }

        showStatus(STATUS.acting);
        step.set("running");
        let res;
        try {
          res = await runAction(c.name, args, { tabId: sendTabId });
        } catch (err) {
          res = { ok: false, error: (err && err.message) || "执行失败" };
        }
        // 软失败（如内置页拦下后即将改走导航）是过程提示，用中性色，不当红色报错
        step.set(res.ok ? "done" : res.soft ? "note" : "fail", res.notice || res.summary || res.error || "");
        conversation.push(toolResult(c, res));
      }
    }

    // 轮次打满模型还想调工具：不能就这么静默停掉，要说明原因并强制收尾
    const exhausted = round >= maxRounds;
    if (exhausted) tail = "（已达到本轮工具调用次数上限，以下为基于已获取信息的收尾）";

    // 工具回合用尽还没落一个字：再给模型一次「只回答、不许调工具」的机会，
    // 否则用户只能看到一句含糊的报错。页面已经读到手，收个尾就有结论。
    // 轮次打满时即使已有过渡文字也走这里——不收尾就会像「说到一半突然没了」。
    if (ranTools && !controller.signal.aborted && (exhausted || !answer.trim())) {
      conversation.push({ role: "user", content: "请直接基于以上已获取的信息给出最终回答，不要再调用任何工具。" });
      fitConversation(conversation, budget);
      showStatus(STATUS.request);
      think = makeThink(reply.blocks, reply.id); // 收尾轮的思考也独立成卡，跟前面的轮次分开
      for await (const ev of streamChat(conversation, { signal: controller.signal })) {
        if (ev.type === "reasoning") think.push(ev.value);
        else if (ev.type === "text") showText(ev.value);
      }
    }

    // 一个字都没落：优先沿用已经说清原因的 tail 文案，否则至少给条可读提示，不静默结束
    if (!answer.trim()) {
      answer = tail || "（模型没有返回任何内容，可能是服务异常或上下文过长，稍后重试一下）";
    }
    reply.status = "ok";
    reply.content = answer;
  } catch (err) {
    if (err?.name === "AbortError") {
      reply.status = "ok";
      answer = answer ? answer + "\n\n（已停止）" : "已停止";
      reply.content = answer;
      tail = "（已停止）";
    } else {
      failure = err;
    }
  } finally {
    controller = null;
    pendingConfirm = null;
    if (paintRaf) {
      cancelAnimationFrame(paintRaf); // 收尾统一重绘，别让挂起的帧再覆盖一次
      paintRaf = 0;
    }
    if (glowLit) pageGlow(false, sendTabId); // 操控结束（含中断/出错）：熄掉页面四边流光
    think?.finish(); // 最后一轮思考收尾：标题换成耗时，默认收起（中途各轮已各自收口）
    if (!bubble) newBubble(); // 兜底：无论如何都要有个气泡落字
    bubble.classList.remove("streaming");
    if (failure) {
      reply.status = "error";
      reply.content = failure?.message || "生成失败";
      el.classList.add("error");
      bubble.textContent = reply.content; // 错误提示按纯文本显示
    } else {
      if (tail) bubbleText = bubbleText ? bubbleText + "\n\n" + tail : tail;
      if (!bubbleText) bubbleText = answer;
      if (bubbleBlock) bubbleBlock.text = bubbleText; // 落库的 blocks 要和屏幕上一致
      bubble.innerHTML = renderMarkdown(bubbleText);
    }
    reply.finished_at = nowISO(); // 回答结束时间，落库后供操作行左侧展示
    $("#msgs").appendChild(turnActions(reply)); // 回答收尾：末尾挂上时间 +「复制 / 删除」
    scrollToEnd();
    hideStatus();
    await persist();
    refreshCtxGauge(); // 这轮问答落库后，占用圆环重算
    setBusy(false);
  }
}

async function persist() {
  if (sessionId == null) return; // 草稿态没有落点（正常流程到不了这里，兜底防写脏键）
  try {
    await store.saveMessages(sessionId, messages);
    // 标题在首次提问时就定好了（兜底或 AI），这里只补条数
    await store.touchSession(sessionId, { message_count: messages.length });
    notifySessions(); // 条数变了，会话列表要跟着更新
  } catch (err) {
    console.warn("[side-assistant] 会话落库失败：", err);
  }
}

/** 让模型给会话起个短标题；失败就保留兜底标题，不打扰用户 */
async function autoTitle(id, firstAsk) {
  try {
    const t = await makeTitle(firstAsk);
    if (!t) return;
    titleSettled.add(id);
    await store.renameSession(id, t);
    notifySessions();
  } catch (err) {
    console.warn("[side-assistant] 自动起标题失败：", err);
  }
}
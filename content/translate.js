/* 划词操作（内容脚本）
   选中正文后在选区旁出现按钮组：「翻译」（点击调模型就地替换原文）与
   「加入对话」（把选中文本作为引用送进侧边栏待发区），各有独立开关，全关时不弹。
   翻译被换掉的原始节点留在内存里，点译文即可还原；刷新页面同样恢复。
   只处理正文：输入框、可编辑区域、我们自己的译文都不打扰。 */

const MAX_CHARS = 2000; // 超过这个长度不弹按钮，避免一次发太多
const HOST_ID = "sa-translate-host";
const SKIP = `input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-sa-tr], #${HOST_ID}`;

let trOn = true; // 「翻译」按钮开关，跟随 chrome.storage 变化
let addOn = true; // 「加入对话」按钮开关
const anyOn = () => trOn || addOn;
let host = null; // 按钮宿主（Shadow DOM，与页面样式隔离）
let ui = null; // shadow 内部引用
let range = null; // 弹按钮时锚定的选区
let text = ""; // 选中的文本（翻译或加入对话都用它）
let busy = false;
let errTimer = 0;
let seq = 0;
let port = null; // 当前翻译的长连接
let cancelStream = null; // 取消当前翻译
const originals = new Map(); // id -> 被替换掉的原始节点

const BASE_STYLE =
  `background:rgba(91,124,250,.16);box-shadow:inset 0 -1px 0 rgba(91,124,250,.55);` +
  `border-radius:2px;cursor:pointer;`;

/* ---------- 开关 ---------- */

function applySettings(s) {
  const o = s || {};
  trOn = o.translate_on !== false;
  addOn = o.select_send_on !== false;
  if (!anyOn()) hide();
}

chrome.storage.local
  .get("sa_settings")
  .then((o) => applySettings(o && o.sa_settings))
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sa_settings) applySettings(changes.sa_settings.newValue);
});

/* ---------- 按钮 ---------- */

const CSS = `
  /* 完全对齐面板的 .chip（见 page/css/chat.css 与 base.css 的颜色 token）：
     底色 --bg-raise #1c1c1f、边框 --line-strong #3a3a41、文字 --fg-soft #9a9aa5，
     圆角 --radius-sm 8px。这里是 Shadow DOM，拿不到面板的 CSS 变量，只能就地写死。
     唯独多一层投影：按钮浮在任意网页上，没有卡片垫底，需要跟页面内容拉开。 */
  .box { display: flex; align-items: flex-start; gap: 6px;
         font: 400 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .btn { flex: 0 0 auto; min-width: 24px; height: 24px; padding: 0 8px; margin: 0;
         box-sizing: border-box;
         display: flex; align-items: center; justify-content: center;
         border: 1px solid #3a3a41; border-radius: 8px; cursor: pointer;
         background: #1c1c1f; color: #9a9aa5;
         font: 500 12px/1 inherit; font-family: inherit; white-space: nowrap;
         box-shadow: 0 2px 8px rgba(0, 0, 0, .32);
         transition: background .16s, color .16s, border-color .16s; }
  /* 悬浮对齐面板 .chip:hover：底色浮起、文字提亮到 --fg、边框点亮品牌色 */
  .btn:hover { background: #2a2a2f; color: #ececf1; border-color: #5b7cfa; }
  .btn[disabled] { cursor: default; opacity: .7; }
  .msg { display: none; max-width: 200px; padding: 5px 8px; border-radius: 8px;
         background: #dc2626; color: #fff; word-break: break-word; }
  .msg.on { display: block; }
`;

function ensureUI() {
  if (host) return;
  host = document.createElement("div");
  host.id = HOST_ID;
  // all: initial 先清掉页面可能给的继承样式，后面的定位写在它之后才能生效。
  // 显隐走 display（all: initial 会把 [hidden] 的 UA 样式一起盖掉，不能用 hidden 属性）
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";
  host.style.display = "none";

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;

  const box = document.createElement("div");
  box.className = "box";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = "翻译";
  btn.title = "翻译选中的内容";

  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn";
  add.textContent = "加入对话";
  add.title = "把选中的内容作为引用加入侧边栏对话";

  const msg = document.createElement("div");
  msg.className = "msg";

  box.append(btn, add, msg);
  root.append(style, box);

  // 别让页面清掉选区（mousedown 默认会结束选区）
  for (const b of [btn, add]) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
  btn.addEventListener("click", () => {
    if (!btn.disabled) run();
  });
  add.addEventListener("click", sendToPanel);

  (document.body || document.documentElement).appendChild(host);
  ui = { box, btn, add, msg };
}

function resetUI() {
  if (!ui) return;
  ui.btn.textContent = "翻译";
  ui.btn.title = "翻译选中的内容";
  ui.msg.className = "msg";
  ui.msg.textContent = "";
}

/** 失败就地在原选区旁弹一句话，比在按钮里塞错误文案清楚 */
function fail(message, pos) {
  ensureUI();
  if (pos) {
    const gap = 6;
    const maxLeft = Math.max(gap, window.innerWidth - 216); // 错误框最大 200px 宽
    const maxTop = Math.max(gap, window.innerHeight - 40);
    host.style.left = `${Math.round(Math.min(Math.max(gap, pos.left), maxLeft))}px`;
    host.style.top = `${Math.round(Math.min(Math.max(gap, pos.top), maxTop))}px`;
  }
  host.style.display = "block";
  ui.btn.style.display = "none";
  ui.add.style.display = "none";
  ui.msg.textContent = message;
  ui.msg.className = "msg on";
  clearTimeout(errTimer);
  errTimer = setTimeout(hide, 3500);
}

function hide() {
  clearTimeout(errTimer);
  if (host) host.style.display = "none";
  range = null;
  text = "";
  resetUI();
}

/* ---------- 选区 ---------- */

const elOf = (node) => (node ? (node.nodeType === 1 ? node : node.parentElement) : null);

/** 选区端点最近的「块级」祖先。display 是 inline / contents 的算行内，其余（含
    inline-block）都算块级——它们被 extractContents 切开后同样会散架 */
function blockOf(node) {
  let el = elOf(node);
  while (el && el !== document.documentElement) {
    const d = getComputedStyle(el).display;
    if (d !== "inline" && d !== "contents") return el;
    el = el.parentElement;
  }
  return el;
}

const isTextNode = (n) => !!n && n.nodeType === 3;

/** 从某个边界出发，沿前/后方向找到真正被选中的那个节点。拖拽常会多滑一格：终点落在
    下一段第一个字符之前（offset 0）时该段其实一个字都没选中，不该当成「跨块」吞掉按钮。 */
function edgeNode(node, offset, dir) {
  const len = isTextNode(node) ? node.length : node.childNodes.length;
  if (dir > 0 ? offset < len : offset > 0) return node; // 容器内确有被选中的内容
  let cur = node;
  while (cur) {
    let sib = dir > 0 ? cur.nextSibling : cur.previousSibling;
    // 跳过源码排版留下的空白文本节点，否则会把「同一段」错判成跨块
    while (sib && isTextNode(sib) && !sib.textContent.trim()) {
      sib = dir > 0 ? sib.nextSibling : sib.previousSibling;
    }
    if (sib) return sib;
    cur = cur.parentNode;
    if (!cur || cur.nodeType === 9) break;
  }
  return node;
}

/** 子树里第一个（dir>0）/ 最后一个（dir<0）非空文本节点 */
function textNodeIn(node, dir) {
  if (!node) return null;
  if (isTextNode(node)) return node.length ? node : null;
  const kids = dir > 0 ? Array.from(node.childNodes) : Array.from(node.childNodes).reverse();
  for (const k of kids) {
    const t = textNodeIn(k, dir);
    if (t) return t;
  }
  return null;
}

/**
 * 端点「多滑一格」时把它收回真正被选中的文本边界。
 * 不收回就直接交给 extractContents，被跨到却没选中的块会被克隆一份，
 * 还原后页面里就多出空段落（之前列表项被复制就是这个原因）。
 * 收边界不改变选中文字，只让 range 落回同一段内，从而可以安全替换与还原。
 */
function tighten(r) {
  const rr = r.cloneRange();
  if (edgeNode(rr.startContainer, rr.startOffset, 1) !== rr.startContainer) {
    const t = textNodeIn(edgeNode(rr.startContainer, rr.startOffset, 1), 1);
    if (t) rr.setStart(t, 0);
  }
  if (edgeNode(rr.endContainer, rr.endOffset, -1) !== rr.endContainer) {
    const t = textNodeIn(edgeNode(rr.endContainer, rr.endOffset, -1), -1);
    if (t) rr.setEnd(t, t.length);
  }
  return rr.collapsed ? r : rr; // 收完变成空选区就退回原样（后面会按跨块拦掉）
}

function pick() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const t = String(sel)
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > MAX_CHARS) return null;
  const holder = elOf(r.commonAncestorContainer);
  if (!holder || !holder.closest || holder.closest(SKIP)) return null;
  // 跨段落的选区也放行：按块拆成多段分别翻译，不再需要 extractContents 那种
  // 会把块级元素克隆切开的做法（见 wrapParts）。
  return { range: tighten(r), text: t };
}

/**
 * 悬浮按钮的落点：贴着选区「最后一行」的右端，并与这一行居中对齐。
 * 必须用 getClientRects() 取每个视觉行——getBoundingClientRect() 是整段的外接
 * 矩形，多行选区时它的 right 是「最宽那一行」的右端，按钮就会飞到离文字很远的地方。
 * @param {Range} r 选区
 * @param {{w: number, h: number}} size 按钮实际尺寸
 */
function anchorPos(r, size) {
  const rects = [];
  for (const rc of r.getClientRects()) if (rc.width || rc.height) rects.push(rc);
  if (!rects.length) {
    const box = r.getBoundingClientRect();
    if (!box.width && !box.height) return null;
    rects.push(box);
  }

  const last = rects[rects.length - 1]; // 最后一个视觉行就是选区末端所在行
  const right = last.right; // 贴选中文本的末端，不外推到整行行尾
  const gap = 6;
  const maxLeft = Math.max(gap, window.innerWidth - size.w - gap);
  const maxTop = Math.max(gap, window.innerHeight - size.h - gap);
  const cx = (v) => Math.round(Math.min(Math.max(gap, v), maxLeft));
  const cy = (v) => Math.round(Math.min(Math.max(gap, v), maxTop));

  // 首选：贴在末行文字的右边，与末行同一水平线
  if (right + gap <= maxLeft) {
    return { left: cx(right + gap), top: cy(last.top + (last.height - size.h) / 2) };
  }
  // 末行已经顶到视口右边界：退到这行文字末端的下方
  const endLeft = Math.max(gap, Math.min(right - size.w, maxLeft));
  if (last.bottom + gap + size.h <= window.innerHeight) {
    return { left: cx(endLeft), top: cy(last.bottom + gap) };
  }
  // 下方也放不下（末行贴着视口底边）：翻到这行上方
  return { left: cx(endLeft), top: cy(last.top - gap - size.h) };
}

function place() {
  if (!anyOn() || busy) return;
  const cur = pick();
  if (!cur) return hide();

  ensureUI();
  resetUI();
  // 各开关决定各自按钮的显隐：两个都开就并排出现
  ui.btn.style.display = trOn ? "" : "none";
  ui.add.style.display = addOn ? "" : "none";
  // 先隐藏着量尺寸（display:none 量不到），定位好再显示，避免按钮闪一下
  host.style.visibility = "hidden";
  host.style.display = "block";
  const br = ui.box.getBoundingClientRect(); // 整组一起量，两个按钮时锚点跟着右移
  const pos = anchorPos(cur.range, { w: Math.round(br.width) || 24, h: Math.round(br.height) || 24 });
  if (!pos) return hide();

  host.style.left = `${pos.left}px`;
  host.style.top = `${pos.top}px`;
  host.style.visibility = "";
  range = cur.range;
  text = cur.text;
}

/** 「加入对话」：选中文本交给 background 转进侧边栏（面板没开会顺带打开），成功即收按钮 */
async function sendToPanel() {
  if (!text) return;
  const pos = anchorPos(range, { w: 30, h: 24 }); // 出错时就地报错的位置
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SA_ADD_SELECTION",
      text,
      url: location.href,
      title: document.title,
    });
    if (!res || res.ok === false) throw new Error((res && res.error) || "侧边栏没有响应，请重试");
    hide();
  } catch (err) {
    fail((err && err.message) || String(err), pos);
  }
}

/* ---------- 替换与还原 ---------- */

/** 翻到一半的样子：文字还留着，只是淡下去，表示正在处理 */
function styleBusy(span) {
  span.setAttribute("title", "翻译中…（点一下可还原）");
  span.style.background = "rgba(91,124,250,.10)";
  span.style.opacity = ".6";
  span.style.cursor = "pointer";
}

function styleDone(span) {
  span.setAttribute("title", "点击还原原文");
  span.style.background = "rgba(91,124,250,.16)";
  span.style.opacity = "1";
  span.style.cursor = "pointer";
}

/** 选区覆盖到的、真正有选中文字的文本节点，按文档顺序返回 [{node, from, to}]。
    空白节点（源码排版留下的换行缩进）跳过：既没什么可翻，也不该被包起来。 */
function collectParts(r) {
  const root = r.commonAncestorContainer;
  const nodes = [];
  if (isTextNode(root)) nodes.push(root); // 整段选在一个文本节点里，treeWalker 走不到它自己
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  }

  const parts = [];
  for (const n of nodes) {
    if (!r.intersectsNode(n)) continue;
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    // 端点落在这个节点上就按偏移切，否则说明整节都在选区里
    const from = r.startContainer === n ? r.startOffset : 0;
    const to = r.endContainer === n ? r.endOffset : n.nodeValue.length;
    if (to <= from) continue; // 拖拽多滑一格：这个节点一个字都没选中
    if (!n.nodeValue.slice(from, to).trim()) continue; // 选中的只是空白
    parts.push({ node: n, from, to });
  }
  return parts;
}

/**
 * 把选中的文字逐个包进 <span>：只碰文本节点，块级元素的骨架一点不动。
 * 刻意不用 extractContents —— 它遇到「只被选中一部分」的块级元素会克隆一份，
 * 还原后页面就多出空段落、列表项变两条，这正是跨段落选区以前被拦掉的原因。
 * 译文改的是原节点的 nodeValue，节点一直留在原地，点还原把原文写回、把 span 拆掉即可。
 */
function wrapParts(r, id) {
  const items = [];
  for (const { node, from, to } of collectParts(r)) {
    const piece = from > 0 ? node.splitText(from) : node; // piece 从 from 开始
    if (to - from < piece.nodeValue.length) piece.splitText(to - from); // 多出来的后半段切出去留原位
    const span = document.createElement("span");
    span.setAttribute("data-sa-tr", id);
    span.setAttribute("style", BASE_STYLE);
    piece.replaceWith(span);
    span.appendChild(piece);
    items.push({ span, node: piece, text: piece.nodeValue });
  }
  return items;
}

/**
 * 按「块」把文本节点切成段：一段 = 一处译文落点。
 * 跨段落时一段一段分别翻，两段译文就不会挤成一段，也不用去猜模型是从哪切的。
 * 同一段里跨了行内元素（粗体、链接）就归在同一段，译文落在段内第一个节点上。
 */
function toSegments(items) {
  const segs = [];
  for (const it of items) {
    const blk = blockOf(it.node);
    const last = segs[segs.length - 1];
    if (last && last.blk === blk) last.items.push(it);
    else segs.push({ blk, items: [it] });
  }
  return segs.map((s) => ({
    text: s.items
      .map((it) => it.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    /** 边翻边显示；只改 nodeValue，节点本身不动，随时能还原 */
    paint(partial) {
      s.items[0].node.nodeValue = partial;
      for (let i = 1; i < s.items.length; i++) s.items[i].node.nodeValue = "";
    },
  }));
}

/** 把选区换成「处理中」的占位，返回还原要用的记录 */
function swap(r) {
  const id = String(++seq);
  const items = wrapParts(r, id);
  if (!items.length) throw new Error("选区里没有可替换的文字");
  const rec = { items, segments: toSegments(items), spans: items.map((it) => it.span) };
  originals.set(id, rec);
  for (const s of rec.spans) styleBusy(s); // 原文还在，先淡下去表示正在处理

  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  return rec;
}

function restore(span) {
  const id = span.getAttribute("data-sa-tr");
  const rec = originals.get(id);
  if (!rec) return;
  if (cancelStream) cancelStream(); // 还在翻就先停掉，别再烧 token

  const touched = new Set();
  for (const it of rec.items) {
    it.node.nodeValue = it.text; // 译文改的就是这个节点的值，写回原文
    if (!it.span.isConnected) continue;
    const parent = it.span.parentNode;
    it.span.replaceWith(it.node); // 再把 span 拆掉
    if (parent) touched.add(parent);
  }
  // 包裹时为了单独包住被选中的一段，把文本节点切开了；这里合回去，
  // 免得「翻一次还原一次」就在页面里攒下一堆碎片文本节点。
  for (const p of touched) if (p.isConnected) p.normalize();

  originals.delete(id);
}

/* ---------- 长连接：边翻边显示 ---------- */

function closePort() {
  const p = port;
  port = null;
  if (p) {
    try {
      p.disconnect();
    } catch {
      /* 已经断开 */
    }
  }
}

/** 连接 background 流式翻译，partial 是累计译文 */
function startStream(src, onPartial) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      closePort();
      fn(arg);
    };

    const p = chrome.runtime.connect({ name: "translate" });
    port = p;
    cancelStream = () => finish(reject, Object.assign(new Error("已取消"), { cancelled: true }));

    p.onMessage.addListener((m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "delta") return onPartial(String(m.text || ""));
      if (m.type === "done") return finish(resolve);
      finish(reject, new Error(m.message || "翻译失败"));
    });

    p.onDisconnect.addListener(() => finish(reject, new Error("翻译连接已断开，请重试")));

    p.postMessage({ type: "start", text: src });
  });
}

async function run() {
  const target = range;
  if (!text || !target || busy) return;

  const pos = anchorPos(target, { w: 30, h: 24 }); // 出错时就地报错的位置
  busy = true;
  if (ui) {
    ui.btn.disabled = true;
    ui.btn.textContent = "⋯";
  }

  // 先把选区换成「处理中」的占位，点下去立刻有反馈，不等模型
  let rec = null;
  try {
    rec = swap(target);
  } catch {
    busy = false;
    if (ui) ui.btn.disabled = false;
    return fail("页面内容已变化，请重新选择", pos);
  }
  hide(); // 浮动按钮收起，位置提示交给占位文本

  try {
    // 选区内可能有好几段（跨段落选择），一段一次请求，各自译文落在各自那一段里
    for (const seg of rec.segments) {
      await startStream(seg.text, (partial) => seg.paint(partial));
    }
    for (const s of rec.spans) if (s.isConnected) styleDone(s);
  } catch (err) {
    restore(rec.spans[0]);
    if (!(err && err.cancelled)) fail((err && err.message) || String(err), pos);
  } finally {
    cancelStream = null;
    busy = false;
    if (ui) {
      ui.btn.disabled = false;
      ui.btn.textContent = "翻译";
    }
  }
}

/* ---------- 事件 ---------- */

let dragging = false; // 正在拖拽选词：拖的过程中不要弹按钮，松手/移开鼠标后再弹
let selTimer = 0;

document.addEventListener("mouseup", (e) => {
  if (!anyOn() || e.button !== 0) return;
  dragging = false;
  if (host && e.target === host) return; // 点在按钮自己身上
  setTimeout(place, 0); // 等浏览器把选区更新完
});

/* 键盘选词（Shift + 方向键）不会触发 mouseup，拖到窗口外松手也收不到 mouseup，
   这里靠 selectionchange 兜底，避免「明明选中了却不弹按钮」。 */
document.addEventListener("selectionchange", () => {
  if (!anyOn() || busy || dragging) return;
  clearTimeout(selTimer);
  selTimer = setTimeout(place, 150);
});

// 松手在窗口外时 mouseup 收不到：指针一旦在「没按键」的状态下移动，就认定拖拽结束
document.addEventListener(
  "mousemove",
  (e) => {
    if (!dragging || e.buttons !== 0) return;
    dragging = false;
    place();
  },
  { passive: true }
);

// 点别处先收按钮；按住按钮自己时保持不动
document.addEventListener(
  "mousedown",
  (e) => {
    if (host && (e.target === host || host.contains(e.target))) return;
    dragging = true;
    hide();
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") hide();
  },
  true
);

// 点译文还原原文：捕获阶段先拦下，页面自己的点击逻辑不再触发
document.addEventListener(
  "click",
  (e) => {
    const el = elOf(e.target);
    const span = el && el.closest ? el.closest("[data-sa-tr]") : null;
    if (!span) return;
    e.preventDefault();
    e.stopPropagation();
    restore(span);
  },
  true
);

window.addEventListener("scroll", hide, { passive: true, capture: true });
window.addEventListener("resize", hide, { passive: true });
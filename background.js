/* 点击工具栏图标 → 在当前标签页展开侧边栏；
   并承载执行引擎：sidepanel 发来 PAGE_ACTION，这里用 chrome.debugger / CDP 落到当前标签页。
   SW 中禁用 ES module，所以下面不复用 page/js 里的模块，页面侧脚本就地定义。

   侧边栏按标签页隔离：只在用户手动打开过的标签页上存在。切到别的标签页（尤其新开的）
   不会跟着显示，切回原标签页则恢复原状态。
   注意清单里不能写 side_panel.default_path —— 那会让 Chrome 建一个「全局面板」，
   一旦打开就粘在所有标签页上，下面这套逐标签开启的逻辑也就失效了。 */

const PANEL_PATH = "page/sidepanel.html";
const PANEL_TABS_KEY = "sa_panel_tabs";

/** 用户手动打开过侧边栏的标签页。SW 会被回收，另存一份到 session storage 续上 */
const panelTabs = new Set();

/** SW 启动即执行：恢复标签集合、关掉「点图标自动开」、把全局面板设为不可用 */
(async function initPanel() {
  if (!chrome.sidePanel?.setOptions) return; // Firefox 等无该 API：静默跳过
  try {
    const o = await chrome.storage.session.get(PANEL_TABS_KEY);
    for (const id of o[PANEL_TABS_KEY] || []) panelTabs.add(id);
  } catch {
    /* 读不到就从空开始 */
  }
  // 交给 Chrome 自动开的话它走的是全局面板口径，面板又会粘到所有标签页上，改为下面手动开
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  // 没被单独配置过的标签页（含新开的）一律没有面板
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
})();

const savePanelTabs = () =>
  chrome.storage.session.set({ [PANEL_TABS_KEY]: [...panelTabs] }).catch(() => {});

/** 在该标签页开启面板并展开。内置页（chrome:// 等）同样放行：面板是浏览器 UI、
    不依赖页面注入；就算页面工具读不了，还有 search_web 能先把标签带到可操作的页面 */
function openPanelOnTab(tabId) {
  if (tabId == null) return;
  panelTabs.add(tabId);
  savePanelTabs();
  // setOptions 不能 await：await 会断开用户手势链，紧随其后的 open() 会因「非用户手势」被拒
  chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
  chrome.sidePanel
    .open({ tabId })
    .catch((err) => console.error("[side-assistant] 展开侧边栏失败：", err));
}

/** 切标签时按「有没有在此标签开过」开关面板：开过的恢复，没开过的收起 */
function syncPanel(tabId) {
  if (tabId == null || !chrome.sidePanel?.setOptions) return;
  chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: panelTabs.has(tabId) }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => openPanelOnTab(tab?.id));

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!panelTabs.size) return; // 一个都没开过：别抢在首次点击之前做裁剪
  syncPanel(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && panelTabs.size) syncPanel(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (panelTabs.delete(tabId)) savePanelTabs();
  glowTabs.delete(tabId); // 流光随页面消失，标记也清掉
});

/* ============================================================
   划词「加入对话」
   内容脚本点「加入对话」把选中文本送进侧边栏：
   - 面板开着（能收到 SA_QUOTE_PUSH）就直接送，不用暂存；
   - 面板没开 / 还没加载完，先记到 session storage，
     由面板启动时用 SA_QUOTE_PULL 拉走，两个通道靠 got 应答去重。
   ============================================================ */

const PENDING_QUOTE_KEY = "sa_pending_quote";

async function addSelectionToPanel(msg, sender) {
  const text = String(msg.text || "").trim();
  if (!text) throw new Error("没有选中内容");
  const quote = { text, url: String(msg.url || ""), title: String(msg.title || "") };

  // 侧边栏没开（或被收起）时顺带展开；点击来自页面上的用户手势，open() 认
  const tab = sender && sender.tab;
  if (tab && tab.id != null && chrome.sidePanel?.open) openPanelOnTab(tab.id);

  const r = await chrome.runtime
    .sendMessage({ type: "SA_QUOTE_PUSH", quote })
    .catch(() => null); // 面板还没起来：没人收是常态，留给 pending 通道
  if (r && r.got) return { ok: true }; // 已送达，不再暂存

  await chrome.storage.session.set({ [PENDING_QUOTE_KEY]: quote });
  return { ok: true };
}

/* ============================================================
   CDP 会话
   ============================================================ */

const PROTOCOL = "1.3";
const attached = new Set(); // 内存标记；SW 重启会丢，靠 ensureAttached 自愈

chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) attached.delete(source.tabId);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 校验一个标签能否被工具操作（存在、非内置页面），返回它的 id */
function assertOperableTab(tab) {
  if (!tab || tab.id == null) throw new Error("没有找到正在浏览的标签页");
  const url = tab.url || "";
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source|file):/i.test(url)) {
    throw new Error("内置界面不支持");
  }
  return tab.id;
}

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return assertOperableTab(tab);
}

/** 用户点发送那一刻锁定的标签：之后切到别的标签不影响本轮工具，全部落回原页面。
    原页面被关掉就明说，不悄悄落到当前标签（那会把 A 的总结写到 B 头上）。 */
async function pinnedTabId(id) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    /* 标签已不存在 */
  }
  if (!tab || tab.id == null) throw new Error("发起操作的那个页面已经关闭了");
  return assertOperableTab(tab);
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (err) {
    const msg = String((err && err.message) || err);
    // SW 重启后内存标记丢失，但会话可能还连着：直接发条命令探活
    if (/already attached/i.test(msg)) {
      try {
        await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1", returnByValue: true });
        attached.add(tabId);
        return;
      } catch {
        throw new Error("该标签页正被开发者工具占用，请先关掉它的 F12 再试");
      }
    }
    throw new Error("无法连接页面：" + msg);
  }
  attached.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** 在页面里跑一段表达式（默认取回值） */
async function evaluate(tabId, expression) {
  const r = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  if (r && r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || "页面脚本执行失败");
  }
  return r ? r.result && r.result.value : undefined;
}

/* ============================================================
   页面侧脚本（在目标页面里执行，函数体自带，无外部依赖）
   ============================================================ */

/** 从设置里取读取分段长度（字符），夹在 2000–30000；读不到就用默认 12000 */
async function readChunkSize() {
  const got = await chrome.storage.local.get("sa_settings");
  const n = Number((got.sa_settings || {}).read_chunk);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 2000), 30000) : 12000;
}

/** 扫描可见的可交互元素并打上 data-sa-idx 编号，供后续按编号操作 */
function saSnapshot(win) {
  const SEL = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  const old = document.querySelectorAll("[data-sa-idx]");
  for (const el of old) el.removeAttribute("data-sa-idx");

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const elements = [];
  let i = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (elements.length >= 120) break;
    if (!visible(el)) continue;
    i += 1;
    el.setAttribute("data-sa-idx", String(i));
    const label = (el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("title") || "")
      .replace(/\s+/g, " ").trim().slice(0, 50);
    elements.push({
      i,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      label,
      href: (el.getAttribute("href") || "").slice(0, 120),
    });
  }

  /* 正文分段回传：短页面一次给全；长页面（论文等）每次往后推进一段，
     否则模型「滚动 + 再读」永远拿回开头同一段，把工具回合白白耗光。
     游标挂在 window 上，页面跳转后随新文档一起重置。
     注意：本函数经 fn.toString() 注入页面执行，不能引用外部变量，
     分段长度的合法区间只能内联钳制（后台传参前也会先夹一次）。 */
  const WIN = Math.min(Math.max(Math.round(Number(win) || 12000), 2000), 30000);
  const full = (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim();
  const st = (window.__saReadState = window.__saReadState || { from: 0 });
  let from = 0;
  if (full.length > WIN) {
    from = Math.min(Math.max(st.from, 0), full.length - 1);
    st.from = from + WIN;
  } else {
    st.from = 0;
  }
  const to = Math.min(full.length, from + WIN);
  /* 读到哪就滚到哪：长页面每读完一段，把视口按进度下移，
     用户才能肉眼跟着看，否则左边一直不动、只剩「读取」在刷，像在空转。
     滚动纯属视觉跟随——正文取自 innerText，与视口无关，不影响读取结果。 */
  if (full.length > WIN) {
    const maxTop = Math.max(
      0,
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) - window.innerHeight
    );
    window.scrollTo({ top: Math.round((to / full.length) * maxTop), behavior: "smooth" });
  }
  return {
    url: location.href,
    title: document.title,
    elements,
    text: full.slice(from, to),
    textTotal: full.length,
    textFrom: from,
    textTo: to,
  };
}

/** 元素视口中心坐标（顺带滚进视野） */
function saRect(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label };
}

/** 判断点击目标是不是「会开新标签页」的链接：解析到最近锚点，结合 <base target>
    算出生效 target。是则返回 { href, label }（供改成本页导航用），否则 null。 */
function saNewTabLink(sel) {
  const el = document.querySelector(sel);
  if (!el || !el.closest) return null;
  const a = el.closest("a[href]");
  if (!a) return null;
  const base = document.querySelector("base[target]");
  const target = (a.target || (base && base.target) || "").trim();
  if (!target || /^_(self|top|parent)$/i.test(target)) return null; // 本页内跳转，交给真实点击
  return {
    href: a.href,
    label: (a.innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40),
  };
}

/** 聚焦输入框并全选已有内容，便于整体替换 */
function saFocus(sel) {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  if (typeof el.select === "function") el.select();
  return true;
}

/** 读取元素（或整页）文字。指定选择器时按目标读；整页读取与 read_page 共用同一个
    游标，长页面连续调用会一段段往后走，而不是每次都从开头重复。 */
function saExtract(arg) {
  const sel = arg ? arg.sel : "";
  const el = sel ? document.querySelector(sel) : document.body;
  if (!el) return null;
  // 同 saSnapshot：注入页面执行，钳制必须内联
  const WIN = Math.min(Math.max(Math.round(Number(arg && arg.win) || 12000), 2000), 30000);
  const full = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const st = (window.__saReadState = window.__saReadState || { from: 0 });
  let from = 0;
  if (!sel) {
    if (full.length > WIN) {
      from = Math.min(Math.max(st.from, 0), full.length - 1);
      st.from = from + WIN;
    } else {
      st.from = 0;
    }
  }
  const to = Math.min(full.length, from + WIN);
  // 整页分段读取时同样让视口跟着进度走（与 read_page 一致）
  if (!sel && full.length > WIN) {
    const maxTop = Math.max(
      0,
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) - window.innerHeight
    );
    window.scrollTo({ top: Math.round((to / full.length) * maxTop), behavior: "smooth" });
  }
  return { text: full.slice(from, to), textTotal: full.length, textFrom: from, textTo: to };
}

function saScroll(dir) {
  if (dir === "top") window.scrollTo({ top: 0, behavior: "instant" });
  else if (dir === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
  else window.scrollBy({ top: dir === "up" ? -600 : 600, behavior: "instant" });
  return Math.round(window.scrollY);
}

const runPage = (tabId, fn, arg) =>
  evaluate(tabId, `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`);

/* ============================================================
   动作实现
   ============================================================ */

function selectorOf(args) {
  if (args && args.index != null && args.index !== "") return `[data-sa-idx="${String(args.index).replace(/["\\]/g, "")}"]`;
  if (args && args.selector) return String(args.selector);
  return null;
}

async function doReadPage(tabId) {
  const snap = await runPage(tabId, saSnapshot, await readChunkSize());
  if (!snap) return { ok: false, error: "页面无响应" };
  const more = snap.textTotal > snap.textTo;
  return {
    ok: true,
    summary:
      `已读取「${snap.title || snap.url}」（${snap.elements.length} 个可操作元素）` +
      (snap.textTotal
        ? `，正文共 ${snap.textTotal} 字，本次为第 ${snap.textFrom + 1}–${snap.textTo} 字` +
          (more ? "，再次读取可继续往后" : "（已到末尾）")
        : "，页面没有正文"),
    page: snap,
  };
}

async function doClick(tabId, args) {
  const sel = selectorOf(args);
  if (!sel) return { ok: false, error: "缺少 index（先用 read_page 拿编号）" };

  const rect = await runPage(tabId, saRect, sel);
  if (!rect) return { ok: false, error: "页面上找不到该元素，可能已变化，请重新读取页面" };

  // 新标签页链接（target=_blank 等）：真实点击会把文章开到新标签页，而助手的读写
  // 始终锁在当前标签上——改为把当前标签直接导航过去，一步到位实现「本页内打开」。
  const link = await runPage(tabId, saNewTabLink, sel);
  if (link && /^https?:/i.test(link.href)) return doGoto(tabId, { value: link.href }, true);

  const p = { x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...p });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p });

  return { ok: true, summary: rect.label ? `已点击「${rect.label}」` : "已点击目标元素" };
}

async function doType(tabId, args) {
  const sel = selectorOf(args);
  if (!sel) return { ok: false, error: "缺少 index（先用 read_page 拿编号）" };
  const value = String(args && args.value != null ? args.value : "");

  const found = await runPage(tabId, saFocus, sel);
  if (!found) return { ok: false, error: "页面上找不到该输入框，可能已变化，请重新读取页面" };

  if (value) {
    await cdp(tabId, "Input.insertText", { text: value });
  } else {
    // 清空：先全选（saFocus 已 select）再删
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  }
  return { ok: true, summary: value ? `已输入「${value.slice(0, 30)}」` : "已清空输入框" };
}

async function doScroll(tabId, args) {
  const raw = String((args && (args.value || args.direction)) || "down").toLowerCase();
  const dir = ["up", "down", "top", "bottom"].includes(raw) ? raw : "down";
  const y = await runPage(tabId, saScroll, dir);
  const word = { up: "向上", down: "向下", top: "到顶部", bottom: "到底部" }[dir];
  return { ok: true, summary: `已${word}滚动` };
}

async function doGoto(tabId, args, inPage = false) {
  let url = String((args && (args.value || args.url)) || "").trim();
  if (!url) return { ok: false, error: "缺少网址" };
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Page.navigate", { url });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      const st = await evaluate(tabId, "document.readyState");
      if (st === "complete") break;
    } catch {
      /* 导航中执行上下文会短暂失效，忽略继续等 */
    }
  }

  let title = "";
  try {
    title = (await evaluate(tabId, "document.title")) || "";
  } catch {
    /* 忽略 */
  }
  return { ok: true, summary: `${inPage ? "已在本页打开" : "已打开"}${title ? "「" + title + "」" : " " + url}` };
}

/* ---------- 联网搜索：内置页的救生索 ----------
   面板落在内置界面（chrome:// 等）上时，read_page / goto 全会被拦；
   搜索这条通道改用 chrome.tabs.update 导航——不走 CDP，内置页也允许——
   直接跳到必应结果页，加载完再交回常规工具读取。 */

const BING_SEARCH = "https://cn.bing.com/search?q=";

async function doSearch(wantTabId, args) {
  const q = String((args && (args.query || args.value)) || "").trim();
  if (!q) return { ok: false, error: "缺少搜索词 query" };
  // 解析目标标签：特意不走 assertOperableTab——内置页正是这条通道要救的场景
  let tabId = null;
  if (wantTabId != null) {
    try {
      tabId = (await chrome.tabs.get(wantTabId)).id;
    } catch {
      /* 标签已不存在 */
    }
    if (tabId == null) throw new Error("发起操作的那个页面已经关闭了");
  } else {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!t || t.id == null) throw new Error("没有找到正在浏览的标签页");
    tabId = t.id;
  }

  await chrome.tabs.update(tabId, { url: BING_SEARCH + encodeURIComponent(q) });

  // 等结果页加载完：tabs.get 不需要注入，导航途中也查得到
  // （必应可能 302 换子域，域名放宽到 *.bing.com）
  const deadline = Date.now() + 15000;
  let landed = false;
  while (Date.now() < deadline) {
    await sleep(400);
    let t = null;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      return { ok: false, error: "页面在搜索途中被关闭了" };
    }
    if (t.status === "complete" && /^https:\/\/([a-z-]+\.)?bing\.com\//i.test(t.url || "")) {
      landed = true;
      break;
    }
  }

  glowSet(tabId, true); // 到了可操作页面把流光点起（后续动作自愈续亮；设置关了则不亮）
  return {
    ok: true,
    summary: `已搜索「${q.slice(0, 30)}」${landed ? "" : "（页面仍在加载）"}，用 read_page 读取结果`,
  };
}

async function doWait(args) {
  const ms = Math.min(Math.max(Number((args && args.ms) || 1000), 100), 10000);
  await sleep(ms);
  return { ok: true, summary: `已等待 ${(ms / 1000).toFixed(1)} 秒` };
}

async function doExtract(tabId, args) {
  const sel = selectorOf(args);
  const r = await runPage(tabId, saExtract, { sel: sel || "", win: await readChunkSize() });
  if (!r) return { ok: false, error: "页面上找不到该元素" };
  const more = r.textTotal > r.textTo;
  return {
    ok: true,
    summary:
      `已读取 ${r.text.length} 字` +
      (more
        ? `（正文共 ${r.textTotal} 字，本次为第 ${r.textFrom + 1}–${r.textTo} 字，再次读取可继续往后）`
        : ""),
    text: r.text,
  };
}

/* ============================================================
   操控流光：助手动页面期间，页面四边亮起一圈彩色霓虹细线，
   用户一眼就知道「左边这个页面正在被助手操纵」。
   配方＝demo.html 里的方案 C「霓虹细线」：最克制的一种。
   四条边各只贴一条 8px 高的亮线（沿边流动的青→白→品红渐变 GLOW_RAMP），
   彩色主要来自线本身，线外只配两圈小半径 box-shadow 轻轻漾开：
   光晕刻意收紧、贴边几十像素就散尽，给页面中间留足干净版面，
   不让整屏都被灯光染色。
   整层再叠一点 blur(6px)：半径必须小——大半径会把线糊成一片淡影，
   「边缘一条彩线」的形体就没了。
   线就压在视口边缘上，不占版面，页面中间完全不受影响。
   实现是往目标页注入 fixed 覆盖物（pointer-events:none，不挡交互），
   关掉时移除。导航 / 关标签会连 DOM 一起清掉，靠 glowTabs 标记 + 每次动作前自愈重挂。
   设置页有总开关（sa_settings.glow_on，默认开）：关掉后动作照常执行，只是不注入光带。
   ============================================================ */

/* 霓虹谱：青 → 白 → 品红 → 青，首尾同为透明，便于 background-position 位移时无缝循环。 */
const GLOW_RAMP =
  "rgba(8,145,178,0) 0%,rgba(6,182,212,1) 14%,rgba(255,255,255,1) 28%," +
  "rgba(192,38,211,1) 54%,rgba(8,145,178,1) 80%,rgba(8,145,178,0) 100%";

const GLOW_CSS = `
#sa-glow{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:2147483647;
  filter:blur(6px)}
#sa-glow i{position:absolute;display:block;background-repeat:no-repeat}
/* 上下两条横向铺满；左右两条纵向铺满。多留 8% 是为了转角处也连成一片，不留缺口 */
#sa-glow i:nth-child(1),#sa-glow i:nth-child(2){left:-8%;right:-8%;height:8px}
#sa-glow i:nth-child(3),#sa-glow i:nth-child(4){top:-8%;bottom:-8%;width:8px}
#sa-glow i:nth-child(1){top:0;
  background-image:linear-gradient(90deg,${GLOW_RAMP});background-size:200% 100%;
  animation:saFlowX 5.6s linear infinite}
#sa-glow i:nth-child(2){bottom:0;
  background-image:linear-gradient(90deg,${GLOW_RAMP});background-size:200% 100%;
  animation:saFlowX 6.65s linear infinite reverse}
#sa-glow i:nth-child(3){left:0;
  background-image:linear-gradient(180deg,${GLOW_RAMP});background-size:100% 200%;
  animation:saFlowY 6.3s linear infinite}
#sa-glow i:nth-child(4){right:0;
  background-image:linear-gradient(180deg,${GLOW_RAMP});background-size:100% 200%;
  animation:saFlowY 7.35s linear infinite reverse}
/* 光晕：近处一圈青、远处一小抹品红，半径收紧，向内几十像素就散尽，不漫到版面中间 */
#sa-glow i{box-shadow:0 0 14px 3px rgba(6,182,212,1),0 0 32px 7px rgba(192,38,211,.6)}
@keyframes saFlowX{from{background-position:0% 50%}to{background-position:200% 50%}}
@keyframes saFlowY{from{background-position:50% 0%}to{background-position:50% 200%}}
@media (prefers-reduced-motion:reduce){
  #sa-glow i{animation:none}
}
`;

const GLOW_ADD = `(() => {
  if (document.getElementById("sa-glow")) return true;
  const st = document.createElement("style");
  st.id = "sa-glow-style";
  st.textContent = ${JSON.stringify(GLOW_CSS)};
  const box = document.createElement("div");
  box.id = "sa-glow";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = "<i></i><i></i><i></i><i></i>";
  const root = document.documentElement || document.body;
  if (!root) return false;
  root.appendChild(st);
  root.appendChild(box);
  return true;
})()`;

const GLOW_DEL = `(() => {
  for (const id of ["sa-glow", "sa-glow-style"]) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  return true;
})()`;

const glowTabs = new Set();

/** 流光总开关：设置页可关（sa_settings.glow_on，默认开）。读失败按开处理，别因它拦住动作 */
async function glowEnabled() {
  try {
    const o = await chrome.storage.local.get("sa_settings");
    return (o.sa_settings || {}).glow_on !== false;
  } catch {
    return true;
  }
}

/** 开/关某个标签页的流光。注入失败（chrome:// 等不可注入页）就静默放弃，绝不能影响动作本身 */
async function glowSet(tabId, on) {
  try {
    if (on && !(await glowEnabled())) return; // 设置里关了：不亮灯，动作照常
    await evaluate(tabId, on ? GLOW_ADD : GLOW_DEL);
    on ? glowTabs.add(tabId) : glowTabs.delete(tabId);
  } catch {
    if (!on) glowTabs.delete(tabId); // 关不掉说明页面没了，标记也别留着
  }
}

/* 设置里把流光关掉时，正在亮的页面立即熄灭；重新打开不用管，下轮动作自然点亮 */
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.sa_settings) return;
  if (ch.sa_settings.newValue?.glow_on !== false) return;
  for (const tabId of [...glowTabs]) glowSet(tabId, false);
});

async function runAction(name, args, wantTabId = null) {
  // wait 只是定时器不碰页面，在内置页/新标签页上也放行（检索限流退避等场景）
  if (name === "wait") return doWait(args);
  // 搜索允许落在内置页上：内部自己解析标签，用 tabs.update 把它带到必应结果页
  if (name === "search_web") return doSearch(wantTabId, args);
  // 面板带上了发起时刻的 tabId 就全程锁定它；没带（旧面板 / 翻译等旁路）才实时取当前标签
  const tabId = wantTabId != null ? await pinnedTabId(wantTabId) : await currentTabId();
  // 流光自愈：标记在亮但页面刚导航过（goto 会杀掉注入的 DOM），重新挂一遍
  if (glowTabs.has(tabId)) await glowSet(tabId, true);
  switch (name) {
    case "read_page": return doReadPage(tabId);
    case "click": return doClick(tabId, args);
    case "type": return doType(tabId, args);
    case "scroll": return doScroll(tabId, args);
    case "goto": return doGoto(tabId, args);
    case "extract": return doExtract(tabId, args);
    default: return { ok: false, error: "不支持的操作：" + name };
  }
}

/* ============================================================
   划词翻译
   内容脚本选中文本后调这里。翻译是短文本的一次性请求，走非流式，
   不依赖侧边栏是否打开；请求在扩展上下文发出，不受页面 CORS 限制。
   ============================================================ */

const TRANSLATE_SYSTEM =
  "你是翻译引擎。把用户给的内容翻译成目标语言，只输出译文本身，" +
  "不要解释、不要加引号、不要附上原文。保留原文里的专有名词和代码。";

/** 自动判断方向：中文占比高就译成英文，否则译成中文 */
function targetLangOf(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk / text.length > 0.15 ? "英语" : "简体中文";
}

/* 关掉思考链：翻译不需要推理。开着的话模型要先烧两三百个思考 token 才开口，
   实测一条短句 1.5 秒变 6 秒以上。不同网关字段名不一样，两个都带上；
   万一网关不认这两个字段就在下面退回不带的写法。 */
const NO_THINK = { enable_thinking: false, thinking: { type: "disabled" } };

async function translateConfig() {
  const got = await chrome.storage.local.get(["sa_settings", "sa_models"]);
  const settings = got.sa_settings || {};
  if (settings.translate_on === false) throw new Error("划词翻译已关闭");

  const model = (got.sa_models || []).find((m) => m.id === settings.active_model_id);
  if (!model) throw new Error("还没配置模型，先在侧边栏设置里登记一个");
  if (!model.api_key) throw new Error(`「${model.name}」没有填写密钥`);

  let endpoint = String(model.base_url || "").replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
  return {
    model,
    endpoint,
    from: settings.translate_from || "自动检测",
    to: settings.translate_to || "自动",
  };
}

function askModel(endpoint, model, body, signal) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + model.api_key },
    body: JSON.stringify(body),
    signal,
  }).catch((err) => {
    if (err && err.name === "AbortError") throw err;
    throw new Error("连不上模型服务，检查网络或 API 地址");
  });
}

/** 逐行读 SSE；末尾没有换行的残行也要吃掉，否则最后一段译文会丢。
    顺带收集末包 usage（DeepSeek/GLM 等网关流式也会带），供 token 统计。 */
async function readStream(res, onDelta) {
  let usage = null;
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("text/event-stream") || !res.body) {
    // 网关忽略 stream 直接回整包 JSON 的兜底
    const data = await res.json().catch(() => null);
    const one = data?.choices?.[0]?.message?.content || "";
    if (data?.usage) usage = data.usage;
    if (one) onDelta(String(one));
    return { text: String(one), usage };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";

  const handle = (raw) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let d;
    try {
      d = JSON.parse(payload);
    } catch {
      return;
    }
    if (d.usage) usage = d.usage;
    const piece = d?.choices?.[0]?.delta?.content || "";
    if (!piece) return; // 思考链的 reasoning_content 落在这里被忽略
    out += piece;
    onDelta(out);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // 末行可能是半截，留到下一轮
    for (const l of lines) handle(l);
  }
  handle(buf);
  return { text: out, usage };
}

/* 用量统计：SW 禁用 ES module，不能 import page/js/store.js，就地实现同一份
   数据结构（键 sa_usage，与 store.recordUsage 保持一致）。 */
async function recordUsageSW(modelId, kind, usage) {
  try {
    const p = Number(usage?.prompt_tokens) || 0;
    const c = Number(usage?.completion_tokens) || 0;
    if (!modelId || (!p && !c)) return;

    const KEY = "sa_usage";
    const got = await chrome.storage.local.get(KEY);
    const all = got[KEY] || {};
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const rec = all[modelId] || { prompt: 0, completion: 0, calls: 0, kinds: {}, days: {}, last_at: "" };
    rec.prompt += p;
    rec.completion += c;
    rec.calls += 1;
    rec.kinds[kind] = (rec.kinds[kind] || 0) + 1;

    const d = rec.days[day] || { prompt: 0, completion: 0, calls: 0, kinds: {} };
    d.prompt += p;
    d.completion += c;
    d.calls += 1;
    d.kinds[kind] = (d.kinds[kind] || 0) + 1;
    rec.days[day] = d;
    rec.last_at = now.toISOString();

    const cutoff = new Date(now.getTime() - 60 * 86400e3);
    const cut = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
    for (const k of Object.keys(rec.days)) if (k < cut) delete rec.days[k];

    all[modelId] = rec;
    await chrome.storage.local.set({ [KEY]: all });
  } catch (err) {
    console.warn("[side-assistant] 记录翻译用量失败：", err);
  }
}

/**
 * 流式翻译：边生成边回调，首字一到就能显示。
 * @param {string} text 选中文本
 * @param {(partial: string) => void} onDelta 收到增量时回调（给的是累计文本）
 * @param {AbortSignal} signal 用户取消时中断
 */
async function streamTranslate(text, onDelta, signal) {
  const content = String(text || "").trim();
  if (!content) throw new Error("没有选中任何文字");

  const { model, endpoint, from, to } = await translateConfig();
  // 方向提示：源语言固定才写进提示词；目标语言选「自动」时沿用旧的判断逻辑
  const lead = [
    from !== "自动检测" ? `源语言：${from}` : "",
    `目标语言：${to !== "自动" ? to : targetLangOf(content)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const body = {
    model: model.model,
    messages: [
      { role: "system", content: TRANSLATE_SYSTEM },
      { role: "user", content: `${lead}\n\n${content}` },
    ],
    stream: true,
    temperature: 0.2, // 翻译要的是稳定，不跟生成参数走
  };

  let res = await askModel(endpoint, model, { ...body, ...NO_THINK }, signal);
  if (res.status === 400) res = await askModel(endpoint, model, body, signal); // 网关不认这两个字段
  if (!res.ok) throw new Error(`模型服务异常（HTTP ${res.status}）`);

  const { text: out, usage } = await readStream(res, onDelta);
  if (usage) recordUsageSW(model.id, "translate", usage);
  if (!out.trim()) throw new Error("模型没有返回译文");
  return out;
}

/* ============================================================
   消息路由
   ============================================================ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "PING") {
    sendResponse({ ok: true, pong: Date.now() });
    return;
  }

  if (msg.type === "SA_ADD_SELECTION") {
    addSelectionToPanel(msg, _sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (msg.type === "SA_QUOTE_PULL") {
    // 面板启动来取「加入对话」的暂存引用；取走即清，不会重复入列
    chrome.storage.session
      .get(PENDING_QUOTE_KEY)
      .then((o) => {
        const quote = o[PENDING_QUOTE_KEY] || null;
        if (quote) chrome.storage.session.remove(PENDING_QUOTE_KEY).catch(() => {});
        sendResponse({ ok: true, quote });
      })
      .catch(() => sendResponse({ ok: false, quote: null }));
    return true;
  }

  if (msg.type === "PAGE_ACTION") {
    runAction(msg.name, msg.args, msg.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // 异步响应，保持通道打开
  }

  if (msg.type === "PAGE_GLOW") {
    // 页面操控流光开关：面板在整轮工具调用的首尾各发一次；失败静默（不影响对话）
    if (msg.tabId != null) glowSet(msg.tabId, !!msg.on).finally(() => sendResponse({ ok: true }));
    else sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "API_ACTION") {
    runApiAction(msg.name, msg.args)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (msg.type === "SCREENSHOT") {
    doScreenshot(msg.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: friendlyShotError(err) }));
    return true;
  }

  if (msg.type === "SHOT_CLIPBOARD") {
    // 框选截图写剪贴板：完成框选时焦点在目标页、面板没焦点，
    // 面板/offscreen 写都会被「Document is not focused」拒，注入到有焦点的目标页执行
    shotToClipboard(msg.dataUrl, msg.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "SHOT_RECT") {
    // 截图脚本回报：单击全屏（full）或框选（rect），先同步 ack，完成后用 SHOT_DONE 推给侧边栏。
    // 截图目标用 sender 所在窗口，不靠 lastFocusedWindow 猜（焦点可能在别的窗口）
    sendResponse({ ok: true });
    const shotTabId = _sender?.tab?.id ?? null; // 面板写剪贴板要回到这个页面上做（它有焦点）
    const shotWinId = _sender?.tab?.windowId ?? null;
    const pushDone = (p) =>
      p
        .then((dataUrl) => chrome.runtime.sendMessage({ type: "SHOT_DONE", ok: true, dataUrl, tabId: shotTabId }))
        .catch((err) => {
          console.warn("[side-assistant] 截图失败：", err);
          chrome.runtime
            .sendMessage({ type: "SHOT_DONE", ok: false, error: friendlyShotError(err) })
            .catch(() => {});
        });
    if (msg.rect) {
      console.log("[side-assistant] 框选完成，开始截图裁剪", msg.rect);
      pushDone(finishRegionShot(msg.rect, Number(msg.dpr) || 1, shotWinId));
    } else if (msg.full) {
      console.log("[side-assistant] 单击全屏截图");
      pushDone(sleep(80).then(() => chrome.tabs.captureVisibleTab(shotWinId, { format: "png" })));
    } else {
      chrome.runtime.sendMessage({ type: "SHOT_DONE", ok: false, error: "已取消截图" }).catch(() => {});
    }
    return false;
  }
});

/* ============================================================
   数据动作：API_ACTION
   ------------------------------------------------------------
   与页面动作分离：不碰用户标签页，只向外部数据源发检索请求。
   限流预算（对齐 academic-search 的规范）：429/503 遵守 Retry-After，
   无提示时有界退避；单请求最多重试 2 次，总等待预算 30 秒，
   预算耗尽放弃该来源并如实上报，绝不臆造结果。 */

const RATE_BUDGET_MS = 30000;

/** 带预算的 fetch：返回最终响应；预算内没等到恢复就把限流响应原样交回 */
async function fetchWithBudget(url, opts = {}) {
  const started = Date.now();
  let res = await fetch(url, opts);
  for (let attempt = 0; attempt < 2 && (res.status === 429 || res.status === 503); attempt++) {
    let wait = 2000 * Math.pow(2, attempt); // 2s → 4s 有界退避
    const ra = Number(res.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) wait = Math.min(Math.max(ra * 1000, wait), 15000);
    if (Date.now() - started + wait > RATE_BUDGET_MS) return res;
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, opts);
  }
  return res;
}

const xmlText = (s) =>
  String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** arXiv Atom XML → 统一记录（SW 里没有 DOMParser，结构稳定用正则提取） */
function parseArxiv(xml, limit) {
  const out = [];
  const entries = (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).slice(0, limit);
  for (const e of entries) {
    const pick = (tag) => {
      const m = e.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
      return m ? xmlText(m[1]).replace(/\s+/g, " ").trim() : "";
    };
    const authors = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => xmlText(m[1]));
    const arxivId = (pick("id").match(/abs\/([^\s/]+)$/)?.[1]) || "";
    out.push({
      source: "arxiv",
      title: pick("title"),
      authors,
      year: pick("published").slice(0, 4),
      venue: "arXiv",
      citations: null, // arXiv API 不提供引用数
      doi: pick("doi"),
      arxiv_id: arxivId,
      // 在线阅读入口给 arXiv 原生 HTML（新版论文都有），精读走 read_page 不进 PDF
      oa_url: arxivId ? "https://arxiv.org/html/" + arxivId : "",
      abstract: pick("summary").slice(0, 800),
    });
  }
  return out;
}

/** OpenAlex 的倒排索引摘要还原为正文 */
function invertedToAbstract(inv) {
  if (!inv) return "";
  const pos = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) pos[Number(i)] = word;
  return pos.filter(Boolean).join(" ").slice(0, 800);
}

async function searchArxiv(query, limit, yearFrom) {
  let q = query;
  if (yearFrom && !/^\w+:/.test(query)) q = "all:" + query; // 混合字段时让服务端自己解析
  const params = new URLSearchParams({
    search_query: q,
    max_results: String(limit),
    sortBy: "relevance",
  });
  if (yearFrom) {
    params.set(
      "search_query",
      `${q} AND submittedDate:[${yearFrom}01010000 TO 209912312359]`,
    );
  }
  const res = await fetchWithBudget("https://export.arxiv.org/api/query?" + params.toString());
  if (res.status === 429 || res.status === 503) throw new Error("arXiv 限流");
  if (!res.ok) throw new Error("arXiv HTTP " + res.status);
  return parseArxiv(await res.text(), limit);
}

async function searchOpenalex(query, limit, yearFrom) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    select: "doi,title,authorships,publication_year,primary_location,cited_by_count,open_access,abstract_inverted_index",
  });
  if (yearFrom) params.set("filter", "from_publication_date:" + yearFrom + "-01-01");
  const res = await fetchWithBudget("https://api.openalex.org/works?" + params.toString());
  if (res.status === 429 || res.status === 503) throw new Error("OpenAlex 限流");
  if (!res.ok) throw new Error("OpenAlex HTTP " + res.status);
  const data = await res.json();
  return (data.results || []).slice(0, limit).map((w) => ({
    source: "openalex",
    title: w.title || w.display_name || "",
    authors: (w.authorships || []).slice(0, 8).map((a) => a.author?.display_name).filter(Boolean),
    year: String(w.publication_year || ""),
    venue: w.primary_location?.source?.display_name || "",
    citations: w.cited_by_count ?? null, // OpenAlex 口径
    doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//, ""),
    arxiv_id: "",
    oa_url: w.open_access?.oa_url || w.primary_location?.pdf_url || "",
    abstract: invertedToAbstract(w.abstract_inverted_index),
  }));
}

async function searchS2(query, limit, yearFrom) {
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(limit, 20)),
    fields: "title,authors,year,venue,citationCount,externalIds,openAccessPdf,abstract",
  });
  if (yearFrom) params.set("year", yearFrom + "-");
  const res = await fetchWithBudget(
    "https://api.semanticscholar.org/graph/v1/paper/search?" + params.toString(),
  );
  if (res.status === 429 || res.status === 503) throw new Error("Semantic Scholar 限流");
  if (!res.ok) throw new Error("Semantic Scholar HTTP " + res.status);
  const data = await res.json();
  return (data.data || []).slice(0, limit).map((p) => ({
    source: "s2",
    title: p.title || "",
    authors: (p.authors || []).slice(0, 8).map((a) => a.name),
    year: String(p.year || ""),
    venue: p.venue || "",
    citations: p.citationCount ?? null, // S2 口径
    doi: p.externalIds?.DOI || "",
    arxiv_id: p.externalIds?.ArXiv || "",
    oa_url: p.openAccessPdf?.url || "",
    abstract: (p.abstract || "").slice(0, 800),
  }));
}

const PAPER_SOURCES = { arxiv: searchArxiv, openalex: searchOpenalex, s2: searchS2 };

/** search_papers：默认只查 arXiv（产品已限源），显式传其他源仍可用；单源失败/限流不拖垮整体，如实上报 */
async function searchPapers(a = {}) {
  const query = String(a.query || "").trim();
  if (!query) return { ok: false, error: "query 不能为空" };
  const wanted = Array.isArray(a.sources) && a.sources.length
    ? a.sources.filter((s) => PAPER_SOURCES[s])
    : ["arxiv"];
  if (!wanted.length) return { ok: false, error: "sources 里没有可用的来源（支持 arxiv/openalex/s2）" };
  const limit = Math.min(Math.max(Number(a.limit) || 5, 1), 8);
  const yearFrom = Number(a.year_from) > 1900 ? Math.floor(Number(a.year_from)) : null;

  const settled = await Promise.all(
    wanted.map(async (s) => {
      try {
        return { s, results: await PAPER_SOURCES[s](query, limit, yearFrom) };
      } catch (err) {
        return { s, error: (err && err.message) || String(err) };
      }
    }),
  );

  const results = [];
  const parts = []; // 各来源命中数，拼进 summary 给步骤卡片和模型看
  const limited = [];
  const failed = [];
  for (const r of settled) {
    if (r.error) {
      (r.error.includes("限流") ? limited : failed).push(r.s + "：" + r.error);
    } else {
      results.push(...r.results);
      parts.push(r.s + " " + r.results.length);
    }
  }
  if (!results.length) {
    return {
      ok: false,
      error: "三个来源都没拿到结果。" + [...limited, ...failed].join("；"),
    };
  }
  const note = [];
  if (limited.length) note.push("被限流（本次未计入）：" + limited.join("；"));
  if (failed.length) note.push("请求失败：" + failed.join("；"));
  return {
    ok: true,
    query,
    summary: `命中 ${results.length} 篇（${parts.join(" · ")}${limited.length ? "；部分来源限流" : ""}）`,
    results,
    ...((note.length && { note: note.join("；") }) || {}),
  };
}

async function runApiAction(name, args = {}) {
  if (name === "search_papers") return searchPapers(args);
  return { ok: false, error: "未知数据动作：" + name };
}

/* ============================================================
   截图技能：用户从面板发起，不进模型工具注册表、不碰 debugger。
   SCREENSHOT：注入框选 overlay 即回；全屏还是框选由用户在页面上决定。
   SHOT_RECT：脚本回报 rect（框选）/ full（单击全屏）/ 都没有（取消），
              截图裁剪后 SHOT_DONE 推回面板。
   SHOT_CLIPBOARD：面板要求把截图写进系统剪贴板，注入目标页执行。
   ============================================================ */

/** 往目标页注入写剪贴板：base64 手动解码成 Blob（不走 fetch，避开页面 CSP 的 connect-src 拦 data:） */
async function shotToClipboard(dataUrl, tabId) {
  if (tabId == null) return { ok: false, error: "缺少目标标签" };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (du) => {
      try {
        const bin = atob(du.split(",")[1]);
        const blob = new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: "image/png" });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
    args: [dataUrl],
  });
  return result;
}


/** 内置页判定：面板页被当标签打开等情况会命中 */
const INTERNAL_URL = /^(chrome|edge|about|devtools|chrome-extension|view-source|file):/i;

/** 解析截图目标标签：面板带 tabId 就直接用（面板已过滤内置页），没带才自己找。
    找到的全是内置页时给出针对性提示——最常见原因是助手被当成标签页打开了 */
async function resolveShotTab(id) {
  let tab = null;
  if (id != null) {
    try {
      tab = await chrome.tabs.get(id);
    } catch {
      /* 标签已关闭，走兜底 */
    }
  }
  if (!tab || tab.id == null) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || INTERNAL_URL.test(tab.url || "")) {
      // 面板当标签页打开时，聚焦窗口的活动标签就是面板自己：换个口径再找一次
      const tabs = await chrome.tabs.query({ active: true });
      tab = tabs.find((t) => !INTERNAL_URL.test(t.url || "")) || tab;
    }
  }
  assertOperableTab(tab); // 只做校验和报错；windowId 也要用，返回整个 tab
  return tab;
}

/** 注入截图 overlay；全屏/框选的分流在 overlay 上完成（单击全屏，拖动框选） */
async function doScreenshot(tabId = null) {
  const tab = await resolveShotTab(tabId); // 内置页在 assertOperableTab 里拦下并给出人话
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/shot-select.js"],
  });
  return { ok: true, started: true };
}

/** 框选回报：overlay 已移除，稍等一帧让遮罩真正从合成层消失再截，避免把框截进图里 */
async function finishRegionShot(rect, dpr, windowId) {
  await sleep(80);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  const sx = Math.max(0, Math.round(rect.x * dpr)); // capture 出图是物理像素，CSS 坐标乘 dpr
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bmp.width - sx, Math.round(rect.w * dpr));
  const sh = Math.min(bmp.height - sy, Math.round(rect.h * dpr));
  if (sw < 2 || sh < 2) throw new Error("选区无效");
  const cv = new OffscreenCanvas(sw, sh); // SW 里没有 DOM canvas，用 OffscreenCanvas
  const ctx = cv.getContext("2d");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  return blobToDataUrl(await cv.convertToBlob({ type: "image/png" }));
}

/** dataURL → Blob：SW 里 fetch(data:) 行为不稳，base64 手动解码最可靠 */
function dataUrlToBlob(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m || !m[2]) throw new Error("截图数据格式异常");
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || "image/png" });
}

/** SW 里没有 FileReader，base64 手搓 */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return "data:" + (blob.type || "image/png") + ";base64," + btoa(bin);
}

/** 把 captureVisibleTab 的原生报错翻译成人话，并把惹事的 URL 提出来（原生错误里就带） */
function friendlyShotError(err) {
  const s = String((err && err.message) || err || "");
  const m = s.match(/url\s+(\S+)/i);
  if (/cannot access|permission|not permitted/i.test(s)) {
    return "该页面不允许截图（" + (m ? m[1] : "内置页面或无权限") + "），请切到普通网页";
  }
  return s || "截图失败";
}

/* 划词翻译走长连接：边生成边把累计译文推回内容脚本，首字一到就能显示 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;

  const ac = new AbortController();
  let closed = false;
  const send = (m) => {
    if (closed) return;
    try {
      port.postMessage(m);
    } catch {
      closed = true;
    }
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    ac.abort(); // 用户点了还原或页面关了，别再烧 token
  });

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "start") return;
    streamTranslate(msg.text, (partial) => send({ type: "delta", text: partial }), ac.signal)
      .then(() => send({ type: "done" }))
      .catch((err) => {
        if (err && err.name === "AbortError") return; // 用户自己取消，不弹错误
        send({ type: "error", message: (err && err.message) || String(err) });
      });
  });
});
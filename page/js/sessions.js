/* 会话列表：切换 / 重命名 / 删除 / 新建。
   面板很窄，做成左侧滑出的抽屉；会话数据全部走 store，本模块只管交互。 */

import { $, toast } from "./util.js";
import * as store from "./store.js";
import { newSession, switchSession, removeSession, renameSession, isBusy, currentTab, currentId } from "./chat.js";

const RENAME_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.4 2.6l3 3-7.4 7.4-3.6.6.6-3.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.4h9.2M6.4 4.4V3.2h3.2v1.2M4.6 4.4l.6 8h5.6l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let editingId = null; // 正在内联改名的会话
let confirmId = null; // 等待二次确认删除的会话

export function initSessions() {
  // 顶栏「新建会话」与浮层里的「新建会话」是同一个动作
  const create = async () => {
    if (isBusy()) {
      toast("正在生成，先停止再新建会话");
      return;
    }
    newSession();
    closePanel();
  };
  $("#btnNew").addEventListener("click", create);
  $("#btnSessNew").addEventListener("click", create);
  $("#btnSessions").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });

  // 点抽屉与触发按钮之外的地方收起（暗幕在抽屉外，点它也走这里）
  document.addEventListener("click", (e) => {
    if (!$("#sessPanel").classList.contains("open")) return;
    if (e.target.closest("#sessPanel") || e.target.closest("#btnSessions")) return;
    closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  // 会话有变动时，若抽屉开着就刷新
  document.addEventListener("sa:sessions-changed", () => {
    if ($("#sessPanel").classList.contains("open")) loadSessions();
  });
}

function togglePanel() {
  if ($("#sessPanel").classList.contains("open")) closePanel();
  else openPanel();
}

async function openPanel() {
  $("#sessPanel").classList.add("open");
  $("#sessScrim").classList.add("open");
  $("#btnSessions").setAttribute("aria-expanded", "true");
  await loadSessions();
}

export function closePanel() {
  $("#sessPanel").classList.remove("open");
  $("#sessScrim").classList.remove("open");
  $("#btnSessions").setAttribute("aria-expanded", "false");
  editingId = null;
  confirmId = null;
}

/* ---------- 列表 ---------- */

/** 批量取绑定标签的现行信息（标题 / favicon）。
    取不到的说明标签已关或浏览器重启后 tabId 失效：顺手解绑（懒清理），会话本身保留。 */
async function tabInfoMap(list) {
  const map = new Map();
  if (!chrome.tabs?.get) return map;
  const ids = [...new Set(list.map((s) => s.tab_id).filter((t) => t != null))];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const t = await chrome.tabs.get(id);
        if (t && t.id != null) map.set(id, { title: t.title || t.url || "标签", favIconUrl: t.favIconUrl || "" });
        else await store.unbindTab(id);
      } catch {
        await store.unbindTab(id);
      }
    }),
  );
  return map;
}

async function loadSessions() {
  const box = $("#sessList");
  const cur = currentId(); // 面板内存态：草稿（null）时列表里不亮任何行
  const list = await store.listSessions();
  const tabs = await tabInfoMap(list);
  const here = (await currentTab())?.id ?? null; // 当前标签：绑在别的标签上的会话这边打不开

  box.textContent = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "model-empty";
    p.textContent = "暂无会话。";
    box.appendChild(p);
    return;
  }
  for (const s of list) {
    const foreign = here != null && s.tab_id != null && s.tab_id !== here;
    box.appendChild(row(s, s.id === cur, tabs.get(s.tab_id), foreign));
  }
}

function row(s, active, tab, foreign = false) {
  if (editingId === s.id) return editRow(s);

  const el = document.createElement("div");
  el.className = "sess-row" + (active ? " on" : "") + (foreign ? " foreign" : "");
  if (foreign) el.title = "这个会话属于另一个页面，切到那个页面再打开它";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "sess-main";
  const name = document.createElement("span");
  name.className = "sess-name";
  name.textContent = s.title || "新会话";
  const meta = document.createElement("span");
  meta.className = "sess-meta";
  meta.textContent = `${relTime(s.updated_at)} · ${s.message_count || 0} 条`;
  if (tab) {
    // 会话绑定的标签：favicon + 标题前几个字，一眼看出会话归属哪个页面
    const chip = document.createElement("span");
    chip.className = "sess-tab";
    chip.title = `绑定标签：${tab.title}`;
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.src = tab.favIconUrl;
      img.alt = "";
      img.loading = "lazy";
      chip.appendChild(img);
    }
    const t = document.createElement("span");
    t.textContent = clip(tab.title, 12);
    chip.appendChild(t);
    meta.appendChild(chip);
  }
  main.append(name, meta);
  main.addEventListener("click", async () => {
    if (active) return closePanel();
    if (isBusy()) {
      toast("正在生成，先停止再切换会话");
      return;
    }
    // 切换被拒（会话属于别的页面）时提示已由 switchSession 给出，抽屉留着让用户看清归属
    if (await switchSession(s.id)) closePanel();
  });
  el.appendChild(main);
  el.appendChild(actsFor(s));

  return el;
}

/** 重命名：就地变成输入框，Enter / 失焦保存，Esc 放弃 */
function editRow(s) {
  const el = document.createElement("div");
  el.className = "sess-row on";

  const input = document.createElement("input");
  input.className = "sess-input";
  input.type = "text";
  input.maxLength = 40;
  input.value = s.title || "";

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const t = input.value.trim();
    if (save && t && t !== s.title) {
      await renameSession(s.id, t);
      toast("已重命名");
    } else if (save && !t) {
      toast("标题不能为空");
    }
    editingId = null;
    loadSessions();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));

  el.appendChild(input);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return el;
}

/** 行尾按钮：默认是「改名 / 删除」，点了删除换成「删除 / 取消」二次确认 */
function actsFor(s) {
  const acts = document.createElement("div");
  acts.className = "sess-acts";

  if (confirmId === s.id) {
    acts.append(
      iconOrText("删除", "sess-act danger", TRASH_SVG, async () => {
        confirmId = null;
        await removeSession(s.id);
        toast("会话已删除");
        loadSessions();
      }),
      iconOrText("取消", "sess-act", null, () => {
        confirmId = null;
        loadSessions();
      }),
    );
    return acts;
  }

  acts.append(
    iconOrText("重命名", "sess-act", RENAME_SVG, () => {
      editingId = s.id;
      loadSessions();
    }),
    iconOrText("删除", "sess-act", TRASH_SVG, () => {
      confirmId = s.id;
      loadSessions();
    }),
  );
  return acts;
}

function iconOrText(title, cls, svg, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = title;
  b.setAttribute("aria-label", title);
  if (svg) b.innerHTML = svg;
  else b.textContent = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/* ---------- 时间 ---------- */

/** 截断到 n 个字符，超出加省略号（标题可能很长，标签 chip 里只放前几个字） */
function clip(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function relTime(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  const dt = new Date(t);
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
}
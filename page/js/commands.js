/* 功能指令层：声明式注册 + 双入口（空状态「功能指令」下拉 / 输入框 "/" 唤起）。
   一个指令 = { slash, name, desc, prompt | draft }：
   - slash："/" 过滤用的英文短名（输入 /xxx 时按它 + 名称 + 描述匹配）
   - prompt：选中后直接发送的指令文本；draft 存在时改为预填输入框等用户补参数
   新增指令只需在 COMMANDS 里加一项，两个入口（下拉、/ 菜单）自动跟随；
   快捷 chips 想同时进菜单，在 skills.js 给 chip 挂上 slash + desc 即可（CHIP_COMMANDS）。 */

import { $ } from "./util.js";
import * as store from "./store.js";
import { CHIP_COMMANDS } from "./skills.js";

export const COMMANDS = [
  {
    slash: "translate",
    name: "全文翻译",
    desc: "整页读完后译成简体中文，保留结构",
    prompt: "把当前页面全文翻译成简体中文：先 read_page 分段读完，再按原文结构输出完整译文。",
  },
  {
    slash: "digest",
    name: "要点提炼",
    desc: "提炼核心要点与一句话总结",
    prompt: "阅读当前页面，提炼 5~8 条核心要点，每条一句话，末尾用两句话总结。",
  },
  {
    slash: "deep",
    name: "深度解读",
    desc: "读完再讲论证结构与关键证据",
    prompt: "深度解读当前页面：先分段读完，再讲清它的论证结构、关键证据与值得注意的细节。",
  },
  {
    slash: "table",
    name: "提取表格",
    desc: "把页面里的表格整理成 Markdown",
    prompt: "读取当前页面，把其中的表格和数据整理成 Markdown 表格输出。",
  },
  {
    slash: "search",
    name: "联网搜索",
    desc: "跳转必应检索最新信息",
    draft: "搜索：",
  },
  {
    slash: "polish",
    name: "文案润色",
    desc: "改写指定文字，保留原意",
    draft: "润色这段文字：",
  },
  // 快捷 chips 同款指令（来源 skills.js 的 CHIP_COMMANDS）：chip 在原地，
  // 菜单里也能触发；设置开关只影响菜单展示，不动 chip。
  ...CHIP_COMMANDS,
];

/* ---------- 落点：选中一条指令后做什么 ---------- */

let cmdSend = null; // app.js 注入的发送函数（与快捷 chips 同一条路）

/** 菜单（/ 唤起与「功能指令」下拉）选中一条指令后的落点：不再直接发送——
    广播 sa:stage-command，由输入区（composer.js）把指令变成「指令块」停在输入框里，
    用户可继续补文本再一起发送。draft 类（搜索：等）同样进块，等用户补参数。
    顶部快捷 chips 不走这里，仍是 applyCommand 一键直发。 */
export function stageCommand(cmd) {
  document.dispatchEvent(new CustomEvent("sa:stage-command", { detail: cmd }));
}

/* 指令开关：设置页勾选控制指令是否出现在菜单里。
   状态缓存在内存（offSet），两个菜单入口（下拉、/）过滤都走它；
   设置页改动后派发 sa:commands-changed，这里重读刷新。 */
const offSet = new Set(); // 被关闭指令的 slash 名

async function refreshCommandState() {
  const s = await store.getSettings();
  offSet.clear();
  for (const k of s.commands_off || []) offSet.add(k);
}

function commandOn(slash) {
  return !offSet.has(slash);
}

/** 设置页开关回调：写存储并广播，菜单与徽标随之刷新 */
export async function setCommandOn(slash, on) {
  const s = await store.getSettings();
  const set = new Set(s.commands_off || []);
  on ? set.delete(slash) : set.add(slash);
  await store.saveSettings({ commands_off: [...set] });
  document.dispatchEvent(new CustomEvent("sa:commands-changed"));
}

export function initCommands({ send }) {
  cmdSend = send;
  refreshCommandState();
  document.addEventListener("sa:commands-changed", refreshCommandState);
}

/** 应用一条指令：直接发送——顶部快捷 chips 的动态指令（prompt 为函数）专用落点。
    prompt 也可以是静态文本，两者都会 await/取值后作为消息发出。
    带 visible 的指令（如「今日要闻」）不在对话框里亮出整段指令文本：
    气泡只显示 visible 短语，完整指令作为隐藏上下文随消息发给模型。
    功能指令菜单（/ 唤起与下拉）不走这里：选中走 stageCommand 进指令块。 */
export async function applyCommand(cmd) {
  const text =
    typeof cmd.prompt === "function" ? await cmd.prompt() : cmd.prompt || cmd.name;
  if (cmd.visible) cmdSend?.(cmd.visible, [], [], text);
  else cmdSend?.(text);
}

/* ---------- 指令菜单浮层（两个入口共用） ---------- */

let menu = null; // 当前浮层 DOM
let items = []; // 当前过滤结果
let activeIdx = 0; // 键盘高亮项
let onPickMenu = null; // 选中回调（Slash 态要先摘掉 / 记号，与下拉入口不同）

function filterCommands(q) {
  q = q.trim().toLowerCase();
  const pool = COMMANDS.filter((c) => commandOn(c.slash)); // 设置里关掉的指令不进菜单
  if (!q) return pool;
  return pool.filter((c) =>
    (c.slash + " " + c.name + " " + c.desc).toLowerCase().includes(q),
  );
}

/** 在 anchor 上方弹出指令菜单；query 用于 Slash 态的即时过滤。
    没有可展示项时返回 false（并顺手关掉旧浮层）。
    默认落点是 stageCommand：选中后指令块进输入框，不直接发送。 */
export function openCommandMenu(anchor, { query = "", onPick = stageCommand } = {}) {
  closeCommandMenu();
  items = filterCommands(query);
  if (!items.length || !anchor) return false;

  const app = $(".app");
  const el = document.createElement("div");
  el.className = "cmd-menu";
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", "功能指令");

  items.forEach((cmd, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmd-item";
    b.setAttribute("role", "option");
    const main = document.createElement("span");
    main.className = "cmd-main";
    const name = document.createElement("span");
    name.className = "cmd-name";
    name.textContent = cmd.name;
    const desc = document.createElement("span");
    desc.className = "cmd-desc";
    desc.textContent = cmd.desc;
    const slash = document.createElement("code");
    slash.className = "cmd-slash";
    slash.textContent = "/" + cmd.slash;
    main.append(name, desc);
    b.append(main, slash);
    b.addEventListener("click", () => pickAt(i));
    el.appendChild(b);
  });
  app.appendChild(el);

  // 与 composer 的 popmenu 同一套贴靠逻辑：锚点上方、左右不越出面板
  const appRect = app.getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  el.style.bottom = appRect.bottom - r.top + 6 + "px";
  const left = r.left - appRect.left;
  el.style.left = Math.max(8, Math.min(left, appRect.width - el.offsetWidth - 8)) + "px";

  menu = el;
  onPickMenu = onPick;
  activeIdx = 0;
  paintActive();
  return true;
}

export function closeCommandMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  items = [];
  onPickMenu = null;
  document.querySelectorAll(".cmd-toggle").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

export function commandMenuOpen() {
  return !!menu;
}

function paintActive() {
  [...menu.children].forEach((el, i) => el.classList.toggle("active", i === activeIdx));
  menu.children[activeIdx]?.scrollIntoView({ block: "nearest" });
}

function pickAt(i) {
  const cmd = items[i];
  const apply = onPickMenu; // 先留好回调再收浮层（close 会把状态清空）
  closeCommandMenu();
  apply?.(cmd);
}

/** 键盘操作（Slash 态由输入框 keydown 转发）：方向键移动、Enter 选中、Esc 关闭。
    返回 true 表示事件已消费，调用方不要再处理。 */
export function commandMenuKeydown(e) {
  if (!menu) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items.length;
    activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    paintActive();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    pickAt(activeIdx);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandMenu();
    return true;
  }
  return false;
}

/* ---------- 输入框 "/" 唤起 ---------- */

/** 由输入框 input 事件调用：光标前是行首的 "/xxx"（无空白）时弹菜单并即时过滤，
    离开该状态（删掉 /、敲了空格、挪走光标）自动收起。 */
export function handleSlashInput(input) {
  const upto = input.value.slice(0, input.selectionStart);
  const m = /^\/(\S*)$/.exec(upto);
  if (!m) {
    closeCommandMenu();
    return false;
  }
  return openCommandMenu($(".composer-box"), {
    query: m[1],
    onPick: (cmd) => {
      // 先把 "/xxx" 记号从输入框摘掉，再按统一落点执行（draft 预填 / 其余进指令块）
      const caret = input.selectionStart;
      const before = input.value.slice(0, caret).replace(/\/\S*$/, "");
      const after = input.value.slice(caret);
      input.value = before + after;
      input.selectionStart = input.selectionEnd = before.length;
      stageCommand(cmd);
    },
  });
}

// 点浮层外任意处收起（入口 chip 自己 stopPropagation，不会被这刀误伤）
document.addEventListener("click", closeCommandMenu);

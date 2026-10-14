/* 设置页：整页视图，铺满面板覆盖对话区。
   两级结构：一级是设置项列表，点条目进二级详情；返回键先回列表，再按才退出设置。
   这里只负责配置的读写，真正发起请求在 llm.js。 */

import { $, toast } from "./util.js";
import * as store from "./store.js";
import { verifyModel } from "./llm.js";
import { closePanel } from "./sessions.js";
import { COMMANDS, setCommandOn } from "./commands.js";
import { APPROVAL_VERBS } from "./actions/dsl.js";

const FIELDS = ["#mName", "#mProvider", "#mModel", "#mBaseURL", "#mKey"];

// 知名厂商预设：都是 OpenAI 兼容接口；选中时空字段自动带默认配置。
// icon 指向 page/provider-icons/ 里的官方矢量图；拉不到时退回首字色标。
const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", icon: "deepseek-color.svg", base: "https://api.deepseek.com/v1" },
  { id: "zhipu", name: "智谱 GLM", icon: "zhipu-color.svg", base: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "moonshot", name: "Kimi（月之暗面）", icon: "kimi-color.svg", base: "https://api.moonshot.cn/v1" },
  { id: "ollama", name: "Ollama（本地）", icon: "ollama.svg", base: "http://localhost:11434/v1" },
  { id: "openai", name: "OpenAI", icon: "openai.svg", base: "https://api.openai.com/v1" },
  { id: "custom", name: "自定义" },
];
let provCur = PROVIDERS[0];
let provFill = null; // 上一次预填写进去的值；字段值还等于它，说明用户没改过，换厂商时可以直接换掉

// 二级页标题：data-page 值 -> 展示名
const PAGE_TITLES = { models: "模型管理", cmds: "功能指令", news: "新闻来源", translate: "划词操作", shot: "截图", approve: "执行权限", glow: "页面操控", usage: "Token 消耗" };

let page = null; // 当前所在的二级页；null = 一级列表

let editingId = null; // 正在编辑的模型 id；null = 新增

/** 表单在「添加 / 编辑」两种模式间的文案与按钮随之切换 */
function syncFormMode() {
  const editing = editingId != null;
  $("#modelFormTitle").textContent = editing ? "编辑模型" : "添加模型";
  $("#btnModelSave").textContent = editing ? "保存修改" : "保存";
  $("#btnModelReset").textContent = editing ? "取消" : "清空";
}

export function initSettings() {
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSheetClose").addEventListener("click", backOrClose);
  $("#btnModelReset").addEventListener("click", () => {
    exitEdit();
    clearForm();
  });
  $("#modelForm").addEventListener("submit", onSubmit);
  $("#genForm").addEventListener("submit", onGenSubmit);
  $("#newsForm").addEventListener("submit", onNewsSubmit);
  $("#tOn").addEventListener("change", onTranslateToggle);
  $("#aOn").addEventListener("change", onSelectToggle);
  $("#tFrom").addEventListener("change", onDirChange);
  $("#tTo").addEventListener("change", onDirChange);
  $("#shotOn").addEventListener("change", onShotToggle);
  $("#glowOn").addEventListener("change", onGlowToggle);
  $("#apvList").addEventListener("change", onApproveToggle);
  $("#btnGenReset").addEventListener("click", async () => {
    await store.saveGenParams({ temperature: "", top_p: "", max_tokens: "", context_tokens: "", compress_pct: "", read_chunk: "", max_rounds: "" });
    await loadGenParams();
    document.dispatchEvent(new CustomEvent("sa:genparams-changed")); // 预算变了，占用圆环重算
    toast("已恢复默认生成参数");
  });
  document.querySelectorAll(".set-item").forEach((b) => {
    b.addEventListener("click", () => showPage(b.dataset.page));
  });
  provInit();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") backOrClose();
  });
  loadModels();
  loadCmds();
  loadNews();
  loadTranslate();
  loadShot();
  loadGlow();
  loadUsage();
  loadApprove();
  // 指令开关变动（本页勾选触发）后重读存储刷新列表与徽标
  document.addEventListener("sa:commands-changed", loadCmds);
}

export function openSettings() {
  exitEdit();
  clearForm();
  closePanel(); // 会话抽屉若开着，一并收起，免得返回后还挂在下面
  $("#sheet").hidden = false;
  showMenu();
  provSet(PROVIDERS[0], true); // 打开即带第一家厂商的默认配置，改下拉就能换
  loadModels();
  loadCmds();
  loadNews();
  loadGenParams();
  loadTranslate();
  loadShot();
  loadGlow();
  loadUsage();
  loadApprove();
}

export function closeSettings() {
  $("#sheet").hidden = true;
  closePopmenuSafely();
}

/* 一级 <-> 二级切换 */

function showMenu() {
  page = null;
  $("#setMenu").hidden = false;
  for (const el of document.querySelectorAll(".set-page")) el.hidden = true;
  $("#sheetTitle").textContent = "设置";
}

function showPage(key) {
  page = key;
  $("#setMenu").hidden = true;
  const id = "page" + key[0].toUpperCase() + key.slice(1); // models -> #pageModels
  for (const el of document.querySelectorAll(".set-page")) el.hidden = el.id !== id;
  $("#sheetTitle").textContent = PAGE_TITLES[key];
  document.querySelector(".sheet-body")?.scrollTo({ top: 0 });
}

/** 返回键 / Esc：供应商下拉开着先收它，二级页先回一级列表，列表上再按才退出设置 */
function backOrClose() {
  if (!$("#provMenu").hidden) return provClose();
  if (page) showMenu();
  else closeSettings();
}

/* ---------- 供应商下拉 ---------- */

const provOpen = () => {
  $("#provMenu").hidden = false;
  $("#provBtn").setAttribute("aria-expanded", "true");
};
const provClose = () => {
  $("#provMenu").hidden = true;
  $("#provBtn").setAttribute("aria-expanded", "false");
};

/* SVG 图标按需拉取，同一家的只拉一次 */
const iconCache = new Map(); // id -> Promise<string>（svg 文本，失败给空串）

// 自定义：铅笔图标，跟会话列表「重命名」同一风格（描边、跟随前景色）
const CUSTOM_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M10.4 2.6l3 3-7.4 7.4-3.6.6.6-3.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

// 模型行尾图标：编辑复用上面那支铅笔；删除与会话列表同款垃圾桶
const EDIT_SVG = CUSTOM_SVG;
const TRASH_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.4h9.2M6.4 4.4V3.2h3.2v1.2M4.6 4.4l.6 8h5.6l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 认不出厂商的模型（自定义 / 中转网关）用立方体占位
const CUBE_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.6l5.4 3v6.8L8 14.4l-5.4-3V4.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.8 4.7L8 7.6l5.2-2.9M8 7.6v6.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

/** 模型归属的厂商预设：先按 provider 名精确命中；认不出再按模型标识里的关键字推断
 *  ——覆盖中转网关：供应商名对不上，但模型名带着厂商特征（GLM / deepseek …） */
function detectProvider(m) {
  const byName = PROVIDERS.find((p) => p.id !== "custom" && p.name === m.provider);
  if (byName) return byName;
  const s = String(m.model || "");
  const hit = [
    [/glm|chatglm|bigmodel/i, "zhipu"],
    [/deepseek/i, "deepseek"],
    [/kimi|moonshot/i, "moonshot"],
    [/ollama|llama/i, "ollama"],
    [/gpt|openai/i, "openai"],
  ].find(([re]) => re.test(s));
  return hit ? PROVIDERS.find((p) => p.id === hit[1]) : null;
}

/** 模型归属的厂商图标 SVG 文本：能认出厂商就用它的矢量图，认不出（真自定义）退回立方体。
 *  设置页的模型行、输入区的模型胶囊与下拉共用这一份。 */
export async function modelIconSvg(m) {
  const p = detectProvider(m);
  if (!p) return CUBE_SVG;
  if (!iconCache.has(p.id)) {
    iconCache.set(p.id, fetch("provider-icons/" + p.icon).then((r) => (r.ok ? r.text() : "")));
  }
  return (await iconCache.get(p.id)) || CUBE_SVG;
}

/** 模型行左侧图标：能认出厂商就用它的矢量图，认不出退回立方体 */
function modelIconEl(m) {
  const s = document.createElement("span");
  s.className = "model-ic";
  s.setAttribute("aria-hidden", "true");
  modelIconSvg(m).then((svg) => {
    s.innerHTML = svg;
  });
  return s;
}

function provIconEl(p) {
  const s = document.createElement("span");
  s.className = "prov-ic";
  s.setAttribute("aria-hidden", "true");
  if (p.id === "custom") {
    s.classList.add("img");
    s.innerHTML = CUSTOM_SVG;
    return s;
  }
  if (!p.icon) {
    s.textContent = p.mark || "?"; // 没有矢量图的退回首字色标
    return s;
  }
  s.classList.add("img");
  if (!iconCache.has(p.id)) {
    iconCache.set(
      p.id,
      fetch("provider-icons/" + p.icon).then((r) => (r.ok ? r.text() : "")),
    );
  }
  iconCache.get(p.id).then((svg) => {
    if (svg) s.innerHTML = svg;
  });
  return s;
}

function provInit() {
  const menu = $("#provMenu");
  for (const p of PROVIDERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prov-opt";
    b.dataset.id = p.id;
    b.setAttribute("role", "option");
    const nm = document.createElement("span");
    nm.className = "prov-name";
    nm.textContent = p.name;
    b.append(provIconEl(p), nm);
    if (p.base) {
      const u = document.createElement("span");
      u.className = "prov-url";
      u.textContent = p.base.replace(/^https?:\/\//, "");
      b.appendChild(u);
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      provSet(p, true);
      provClose();
    });
    menu.appendChild(b);
  }
  $("#provBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("#provMenu").hidden) provOpen();
    else provClose();
  });
  document.addEventListener("click", (e) => {
    if (!$("#provMenu").hidden && !e.target.closest("#provDD")) provClose();
  });
  provSet(PROVIDERS[0], false);
}

/** fill = true 时把厂商默认配置写进空字段；
 *  已经是别家预填的值也一并换掉（用户没动手改过），用户手输的绝不动。
 *  模型名不预填：各家模型型号多且更新快，留给用户自己填 */
function provSet(p, fill) {
  provCur = p;
  $("#provLabel").textContent = p.name;
  const host = provIconEl(p); // 按钮上的图标跟着换
  host.id = "provIc";
  $("#provIc").replaceWith(host);
  $("#mProvider").hidden = p.id !== "custom"; // 只有自定义需要手填名称
  document.querySelectorAll(".prov-opt").forEach((b) => b.classList.toggle("on", b.dataset.id === p.id));
  if (!fill || !p.base) return;
  const swap = (sel, v) => {
    const cur = $(sel).value.trim();
    if (!cur || (provFill && cur === provFill[sel])) $(sel).value = v;
  };
  swap("#mName", p.name);
  swap("#mBaseURL", p.base);
  provFill = { "#mName": p.name, "#mBaseURL": p.base };
}

function provValue() {
  return provCur.id === "custom" ? $("#mProvider").value.trim() : provCur.name;
}

/* 设置页开着时可能还留着模型/审批/供应商下拉菜单，返回时顺手关掉 */
function closePopmenuSafely() {
  document.querySelector(".popmenu")?.remove();
  document.querySelectorAll(".pill-select").forEach((b) => b.setAttribute("aria-expanded", "false"));
  provClose();
}

function clearForm() {
  for (const sel of FIELDS) $(sel).value = "";
  $("#mVision").checked = false;
  $("#modelError").textContent = "";
  provClose();
  provFill = null;
  provSet(PROVIDERS[0], false); // 「清空」就真清空：回到 DeepSeek 但不带默认值
}

/* ---------- 登记 ---------- */

/** 退出编辑态：编辑 id 清空，文案回到「添加」 */
function exitEdit() {
  editingId = null;
  syncFormMode();
}

/** 点铅笔进入编辑：把该模型配置回填表单，表单切到「编辑模型」 */
async function startEdit(id) {
  const m = await store.getModel(id);
  if (!m) return;
  editingId = id;
  const preset = PROVIDERS.find((x) => x.id !== "custom" && x.name === m.provider);
  fillForm(m, preset);
  syncFormMode();
  $("#modelForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 回填：preset 命中厂商预设就用预设项，否则走「自定义」并把名称填进去 */
function fillForm(m, preset) {
  $("#mName").value = m.name || "";
  $("#mModel").value = m.model || "";
  $("#mBaseURL").value = m.base_url || "";
  $("#mKey").value = m.api_key || "";
  $("#mVision").checked = !!m.vision;
  $("#modelError").textContent = "";
  provFill = null; // 回填的是真实配置，别被「换厂商自动预填」逻辑当成旧预填值换掉
  if (preset) {
    provSet(preset, false);
  } else {
    provSet(PROVIDERS.find((x) => x.id === "custom"), false);
    $("#mProvider").value = m.provider || "";
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const err = $("#modelError");
  const btn = $("#btnModelSave");
  err.textContent = "";
  btn.disabled = true;
  btn.textContent = "验证中…";

  try {
    const base_url = store.normalizeURL($("#mBaseURL").value); // 地址不合法提前拦下
    const api_key = $("#mKey").value.trim();
    const model = $("#mModel").value.trim();
    // 保存前真实发一次请求：通得过才登记，保证列表里的模型都是能用的
    await verifyModel({ base_url, api_key, model });
    const body = {
      name: $("#mName").value,
      provider: provValue() || "自定义",
      model,
      base_url,
      api_key,
      vision: $("#mVision").checked,
    };
    const editing = editingId != null;
    if (editing) await store.updateModel(editingId, body);
    else await store.createModel(body);
    exitEdit();
    clearForm();
    toast(editing ? "模型已更新" : "模型已登记");
    notifyModelsChanged();
    loadModels();
    // 变更落在上方的列表里，滚回顶部让用户看得见
    document.querySelector(".sheet-body")?.scrollTo({ top: 0, behavior: "smooth" });
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    syncFormMode();
  }
}

function notifyModelsChanged() {
  document.dispatchEvent(new CustomEvent("sa:models-changed"));
}

/* ---------- 功能指令 ---------- */

/** 徽标：全开报「全部开启」，有关闭的报「已开 n/m」 */
function cmdsBadge(off) {
  const on = COMMANDS.filter((c) => !off.has(c.slash)).length;
  return on === COMMANDS.length ? "全部开启" : `已开 ${on}/${COMMANDS.length}`;
}

/** 直接读存储渲染（与 commands.js 的内存缓存互不依赖，避开事件时序） */
async function loadCmds() {
  const off = new Set((await store.getSettings()).commands_off || []);
  const box = $("#cmdList");
  box.textContent = "";

  for (const cmd of COMMANDS) {
    const row = document.createElement("label");
    row.className = "switch-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "cmdOn_" + cmd.slash;
    cb.checked = !off.has(cmd.slash);
    cb.setAttribute("aria-label", "在功能指令菜单中显示：" + cmd.name);
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        await setCommandOn(cmd.slash, cb.checked);
        toast(cb.checked ? "已开启指令：" + cmd.name : "已关闭指令：" + cmd.name);
      } catch {
        cb.checked = !cb.checked; // 写失败回弹
      } finally {
        cb.disabled = false;
      }
    });

    const text = document.createElement("span");
    text.className = "switch-text";
    const name = document.createElement("span");
    name.className = "switch-name";
    name.textContent = cmd.name + " ";
    const slash = document.createElement("code");
    slash.className = "cmd-slash";
    slash.textContent = "/" + cmd.slash;
    name.appendChild(slash);
    const desc = document.createElement("span");
    desc.className = "switch-desc";
    desc.textContent = cmd.desc;
    text.append(name, desc);

    row.append(cb, text);
    box.appendChild(row);
  }

  $("#badgeCmds").textContent = cmdsBadge(off);
  $("#cmdCount").textContent = `${COMMANDS.length} 条`;
}

/* ---------- 新闻来源 ---------- */

const NEWS_MAX = 3;

/** 网址规范化：无协议自动补 https://，解析不出主机名的报错文案 */
function normalizeNewsURL(raw) {
  let v = String(raw || "").trim();
  if (!v) throw new Error("请填写来源网址");
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error("网址格式不对，请检查");
  }
  if (!/^[\w-]+(\.[\w-]+)+$/.test(u.hostname)) throw new Error("网址看起来不对，请检查");
  return u.href;
}

/** 列表徽标：配了报 n/3，没配提示留空的兜底行为 */
function newsBadge(list) {
  return list.length ? `已配 ${list.length}/${NEWS_MAX}` : "不限来源";
}

/** 直接读存储渲染（与今日要闻指令触发时实时读配置同一份真相） */
async function loadNews() {
  const list = (await store.getSettings()).news_sources || [];
  const box = $("#newsList");
  box.textContent = "";

  for (const url of list) {
    const row = document.createElement("div");
    row.className = "news-src-row";
    const txt = document.createElement("span");
    txt.className = "news-src-url";
    txt.textContent = url;
    txt.title = url;
    const del = iconBtn("删除来源", "model-act danger", TRASH_SVG, async () => {
      const cur = (await store.getSettings()).news_sources || [];
      await store.saveSettings({ news_sources: cur.filter((x) => x !== url) });
      toast("已删除来源：" + url.replace(/^https?:\/\//, ""));
      loadNews();
    });
    row.append(txt, del);
    box.appendChild(row);
  }

  if (!list.length) {
    const p = document.createElement("p");
    p.className = "model-empty";
    p.textContent = "还没有配置来源，「今日要闻」会改为联网搜索。";
    box.appendChild(p);
  }

  $("#badgeNews").textContent = newsBadge(list);
  $("#newsCount").textContent = `${list.length}/${NEWS_MAX}`;
}

async function onNewsSubmit(e) {
  e.preventDefault();
  const err = $("#newsError");
  const btn = $("#btnNewsAdd");
  err.textContent = "";
  btn.disabled = true;
  try {
    const url = normalizeNewsURL($("#newsInput").value);
    const cur = (await store.getSettings()).news_sources || [];
    if (cur.length >= NEWS_MAX) throw new Error(`最多配置 ${NEWS_MAX} 个来源`);
    if (cur.some((x) => new URL(x).host === new URL(url).host)) {
      throw new Error("这个站点已经配过了");
    }
    await store.saveSettings({ news_sources: [...cur, url] });
    $("#newsInput").value = "";
    toast("已添加来源：" + url.replace(/^https?:\/\//, ""));
    loadNews();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 划词操作 ---------- */

/** 列表徽标：两个按钮的开关组合；方向定过就一并带上，如「翻译 · 对话 · 英语 → 日语」 */
function translateBadge(s) {
  const parts = [];
  if (s.translate_on !== false) parts.push("翻译");
  if (s.select_send_on !== false) parts.push("对话");
  if (!parts.length) return "已关闭";
  const anyFixed = s.translate_from !== "自动检测" || s.translate_to !== "自动";
  const dir = anyFixed ? ` · ${s.translate_from} → ${s.translate_to}` : "";
  return parts.join(" · ") + dir;
}

async function loadTranslate() {
  const s = await store.getSettings();
  $("#tOn").checked = s.translate_on !== false;
  $("#aOn").checked = s.select_send_on !== false;
  $("#tFrom").value = s.translate_from || "自动检测";
  $("#tTo").value = s.translate_to || "自动";
  $("#badgeTranslate").textContent = translateBadge(s);
}

async function refreshTranslateBadge(patch) {
  $("#badgeTranslate").textContent = translateBadge({ ...(await store.getSettings()), ...patch });
}

async function onTranslateToggle(e) {
  const on = e.target.checked;
  await store.saveSettings({ translate_on: on });
  await refreshTranslateBadge({ translate_on: on });
  // 内容脚本监听 storage 变化，改完立刻生效，不用刷新页面
  toast(on ? "划词翻译已开启" : "划词翻译已关闭");
}

async function onSelectToggle(e) {
  const on = e.target.checked;
  await store.saveSettings({ select_send_on: on });
  await refreshTranslateBadge({ select_send_on: on });
  toast(on ? "加入对话已开启" : "加入对话已关闭");
}

/** 源/目标语言下拉：改动即存 */
async function onDirChange(e) {
  const key = e.target.id === "tFrom" ? "translate_from" : "translate_to";
  await store.saveSettings({ [key]: e.target.value });
  $("#badgeTranslate").textContent = translateBadge(await store.getSettings());
  toast("翻译方向已保存");
}

/* ---------- 截图 ---------- */

/** 列表徽标：交付方式 */
function shotBadge(s) {
  return s.shot_attach !== false ? "进附件框" : "复制到剪贴板";
}

async function loadShot() {
  const s = await store.getSettings();
  $("#shotOn").checked = s.shot_attach !== false;
  $("#badgeShot").textContent = shotBadge(s);
}

async function onShotToggle(e) {
  const on = e.target.checked;
  await store.saveSettings({ shot_attach: on });
  $("#badgeShot").textContent = shotBadge({ shot_attach: on });
  toast(on ? "截图将自动加入附件框" : "截图将复制到剪贴板");
}

/* ---------- 页面操控 ---------- */

/** 列表徽标 */
function glowBadge(s) {
  return s.glow_on !== false ? "开启" : "关闭";
}

async function loadGlow() {
  const s = await store.getSettings();
  $("#glowOn").checked = s.glow_on !== false;
  $("#badgeGlow").textContent = glowBadge(s);
}

async function onGlowToggle(e) {
  const on = e.target.checked;
  await store.saveSettings({ glow_on: on });
  $("#badgeGlow").textContent = glowBadge({ glow_on: on });
  // background 监听 storage 变化：关掉的瞬间正在亮的页面会立即熄灭
  toast(on ? "操控流光已开启" : "操控流光已关闭");
}

/* ---------- 执行权限（自主审批的放行清单） ---------- */

/** 列表徽标：已放行几项 */
function approveBadge(skip) {
  return skip.length ? `已放行 ${skip.length} 项` : "全部需确认";
}

/** 放行清单来自 dsl.js 的工具注册表：新增需审批动作时这里自动跟上，不用改本页 */
async function loadApprove() {
  const s = await store.getSettings();
  const skip = Array.isArray(s.approval_skip) ? s.approval_skip : [];
  const box = $("#apvList");
  box.textContent = "";
  for (const v of APPROVAL_VERBS) {
    const row = document.createElement("label");
    row.className = "switch-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.verb = v.name;
    cb.checked = skip.includes(v.name);
    const text = document.createElement("span");
    text.className = "switch-text";
    const name = document.createElement("span");
    name.className = "switch-name";
    name.textContent = v.label;
    const desc = document.createElement("span");
    desc.className = "switch-desc";
    desc.textContent = v.desc;
    text.append(name, desc);
    row.append(cb, text);
    box.appendChild(row);
  }
  $("#badgeApprove").textContent = approveBadge(skip);
}

async function onApproveToggle() {
  const skip = [...document.querySelectorAll("#apvList input:checked")].map((cb) => cb.dataset.verb);
  await store.saveSettings({ approval_skip: skip });
  $("#badgeApprove").textContent = approveBadge(skip);
  toast(skip.length ? `已放行 ${skip.length} 项操作` : "已恢复：全部操作都需确认");
}

/* ---------- Token 消耗 ---------- */

const KIND_LABEL = { chat: "对话", summary: "压缩", title: "标题", translate: "翻译" };

/* 环形图配色：深色底上可区分，多于配色数时循环取用 */
const DONUT_COLORS = ["#5b7cfa", "#38bdf8", "#2dd4bf", "#a78bfa", "#f5a524", "#f472b6", "#fb7185", "#a3e635"];

const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** tokens 数字的短写：1.2K / 22.4K / 3.4M（整数去掉小数位） */
function fmtTok(n) {
  const short = (v) => String(v).replace(/\.0$/, "");
  if (n >= 1e6) return short((n / 1e6).toFixed(1)) + "M";
  if (n >= 1e3) return short((n / 1e3).toFixed(1)) + "K";
  return String(n);
}

function agoLabel(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`;
  return `${Math.floor(m / 1440)} 天前`;
}

/** 最近 7 天（含今天）的日期键，升序 */
function last7Keys() {
  const keys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }
  return keys;
}

/** 把某模型的按天明细汇总成最近 7 天的用量 */
function last7Sum(u) {
  const out = { prompt: 0, completion: 0, calls: 0, kinds: {} };
  const days = u?.days || {};
  for (const k of last7Keys()) {
    const r = days[k];
    if (!r) continue;
    out.prompt += r.prompt || 0;
    out.completion += r.completion || 0;
    out.calls += r.calls || 0;
    for (const [kind, n] of Object.entries(r.kinds || {})) out.kinds[kind] = (out.kinds[kind] || 0) + n;
  }
  return out;
}

/** 顶部占比环形图：各模型近 7 天 tokens 占比分段环 + 图例。
 *  图例与下方卡片的色点同色，一眼对上「谁用了多少」。 */
function usageDonut(rows, totals) {
  const el = document.createElement("div");
  el.className = "usage-donut";

  const R = 50; // 半径（viewBox 120）
  const C = 2 * Math.PI * R; // 周长
  const GAP = 2.5; // 相邻分段的缝
  const segs = rows.filter((r) => r.s.prompt + r.s.completion > 0);

  const svg = svgEl("svg", { viewBox: "0 0 120 120", class: "donut-svg", "aria-hidden": "true" });
  // 底环：无用量时也撑出图形轮廓
  svg.appendChild(svgEl("circle", { cx: 60, cy: 60, r: R, fill: "none", stroke: "var(--line-strong)", "stroke-width": 12 }));

  const ringTitle = (r, node) => {
    const t = document.createElementNS(SVG_NS, "title");
    t.textContent = `${r.m.name} · ${fmtTok(r.s.prompt + r.s.completion)} tokens`;
    node.appendChild(t);
  };
  if (segs.length === 1) {
    const c = svgEl("circle", {
      cx: 60, cy: 60, r: R, fill: "none", stroke: segs[0].color, "stroke-width": 12, class: "donut-seg",
    });
    ringTitle(segs[0], c);
    svg.appendChild(c);
  } else if (segs.length > 1) {
    const g = svgEl("g", { transform: "rotate(-90 60 60)" }); // 从正上方起画
    let acc = 0;
    for (const r of segs) {
      const frac = (r.s.prompt + r.s.completion) / totals;
      const len = Math.max(frac * C - GAP, 1.2);
      const c = svgEl("circle", {
        cx: 60, cy: 60, r: R, fill: "none", stroke: r.color, "stroke-width": 12, class: "donut-seg",
        "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": String(-acc * C),
      });
      ringTitle(r, c);
      g.appendChild(c);
      acc += frac;
    }
    svg.appendChild(g);
  }

  // 中心：近 7 天总量。「近 7 天」标题里已说明，这里只留数字
  const num = svgEl("text", { x: 60, y: 65, class: "donut-num" });
  num.textContent = totals ? fmtTok(totals) : "暂无";
  svg.appendChild(num);

  const legend = document.createElement("div");
  legend.className = "donut-legend";
  let accPct = 0; // 占比用累计值差取整，保证加起来正好 100%
  for (const r of segs) {
    const before = Math.round(accPct * 100);
    accPct += (r.s.prompt + r.s.completion) / totals;
    const pct = Math.round(accPct * 100) - before;

    const row = document.createElement("div");
    row.className = "dl-row";
    row.title = `${r.m.name} · 输入 ${fmtTok(r.s.prompt)} / 输出 ${fmtTok(r.s.completion)} · ${r.s.calls} 次`;
    const dot = document.createElement("i");
    dot.style.background = r.color;
    const nm = document.createElement("span");
    nm.className = "dl-name";
    nm.textContent = r.m.name;
    const val = document.createElement("span");
    val.className = "dl-val";
    const b = document.createElement("b");
    b.textContent = fmtTok(r.s.prompt + r.s.completion);
    val.append(b, document.createTextNode(` · ${pct}%`));
    row.append(dot, nm, val);
    legend.appendChild(row);
  }
  el.append(svg, legend);
  return el;
}

async function loadUsage() {
  const box = $("#usageList");
  const [all, models] = await Promise.all([store.getUsage(), store.listModels()]);
  box.textContent = "";

  // 只统计已登记模型，已删除模型不再展示；按近 7 天用量降序，其次按名字
  const rows = models
    .map((m) => {
      const u = all[m.id] || null;
      return { m, u, s: last7Sum(u) };
    })
    .sort(
      (a, b) =>
        b.s.prompt + b.s.completion - (a.s.prompt + a.s.completion) ||
        b.s.calls - a.s.calls ||
        a.m.name.localeCompare(b.m.name),
    );

  const totals = rows.reduce((n, r) => n + r.s.prompt + r.s.completion, 0);
  const calls = rows.reduce((n, r) => n + r.s.calls, 0);
  $("#badgeUsage").textContent = totals ? fmtTok(totals) : "暂无";
  // 总数已在环形图圆心，这里只补调用次数，不重复报 token
  $("#usageTotal").textContent = totals ? `${calls} 次调用` : "";

  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "model-empty";
    p.textContent = "还没有登记模型，先去「模型管理」添加一个。";
    box.appendChild(p);
    return;
  }

  // 有用量的模型按序取环形图配色，图例与卡片色点共用
  let ci = 0;
  for (const r of rows) {
    if (r.s.prompt + r.s.completion > 0) r.color = DONUT_COLORS[ci++ % DONUT_COLORS.length];
  }
  box.appendChild(usageDonut(rows, totals));

  if (!calls) {
    const p = document.createElement("p");
    p.className = "model-empty";
    p.textContent = "最近 7 天还没有调用记录，和模型对话或划词翻译后会在这里累计。";
    box.appendChild(p);
  }
  for (const r of rows) box.appendChild(usageCard(r));
}

/** 单个模型的用量卡片：近 7 天的数字 + 每天调用频率柱（色点与顶部环形图对应） */
function usageCard({ m, u, s, color }) {
  const el = document.createElement("div");
  el.className = "usage-card";

  const head = document.createElement("div");
  head.className = "usage-head";
  const dot = document.createElement("span"); // 与环形图同色的识别点
  dot.className = "usage-dot";
  dot.style.background = color || "transparent";
  const name = document.createElement("span");
  name.className = "usage-name";
  name.textContent = m.name;
  if (m.model && m.model !== m.name) {
    const sub = document.createElement("span");
    sub.className = "usage-sub";
    sub.textContent = " · " + m.model;
    name.appendChild(sub);
  }
  const ago = document.createElement("span");
  ago.className = "usage-ago";
  ago.textContent = u ? "最近使用 " + agoLabel(u.last_at) : "未使用";
  if (color) head.append(dot);
  head.append(name, ago);
  el.appendChild(head);

  if (!u) return el; // 登记过但一次都没调用

  const nums = document.createElement("div");
  nums.className = "usage-nums";
  const item = (label, val) => {
    const s = document.createElement("span");
    s.textContent = label + " ";
    const b = document.createElement("b");
    b.textContent = val;
    s.appendChild(b);
    return s;
  };
  // 输入 / 输出已能推出合计，不再单列；分类明细并进 tooltip，不占版面
  nums.append(
    item("输入", fmtTok(s.prompt)),
    item("输出", fmtTok(s.completion)),
    item("调用", `${s.calls} 次`),
  );
  el.appendChild(nums);

  const kinds = Object.entries(s.kinds)
    .filter(([, n]) => n)
    .map(([k, n]) => `${KIND_LABEL[k] || k} ${n}`)
    .join(" · ");
  el.title = `${m.name} · ${m.model}｜输入 ${fmtTok(s.prompt)} / 输出 ${fmtTok(s.completion)} · 调用 ${
    s.calls
  } 次${kinds ? " · " + kinds : ""}`;

  el.appendChild(weekBars(u.days || {}));
  return el;
}

/** 近 7 天调用频率柱：柱高按当天调用次数（最高一根满高），悬停看明细 */
function weekBars(days) {
  const wrap = document.createElement("div");
  wrap.className = "usage-bars";

  const keys = last7Keys();
  const list = keys.map((key, i) => ({
    key,
    day: Number(key.slice(8)),
    today: i === keys.length - 1,
    rec: days[key] || null,
  }));
  const max = Math.max(1, ...list.map((x) => (x.rec ? x.rec.calls : 0)));

  for (const x of list) {
    const col = document.createElement("div");
    col.className = "ub" + (x.today ? " today" : "");
    col.title = x.rec
      ? `${x.key.slice(5)} · ${x.rec.calls} 次 · 输入 ${fmtTok(x.rec.prompt)} / 输出 ${fmtTok(x.rec.completion)}`
      : `${x.key.slice(5)} · 无调用`;

    const track = document.createElement("div");
    track.className = "ub-track";
    const bar = document.createElement("i");
    bar.style.height = x.rec ? Math.max(8, Math.round((x.rec.calls / max) * 100)) + "%" : "0%";
    track.appendChild(bar);

    const lab = document.createElement("span");
    lab.className = "ub-day";
    lab.textContent = x.day;

    col.append(track, lab);
    wrap.appendChild(col);
  }
  return wrap;
}

/* ---------- 生成参数 ---------- */

async function loadGenParams() {
  const g = await store.genParams();
  $("#gTemp").value = g.temperature == null ? "" : g.temperature;
  $("#gTopP").value = g.top_p == null ? "" : g.top_p;
  $("#gMaxTokens").value = g.max_tokens == null ? "" : g.max_tokens;
  $("#gCtx").value = g.context_tokens == null ? "" : g.context_tokens;
  $("#gRatio").value = g.compress_ratio == null ? "" : Math.round(g.compress_ratio * 100);
  $("#gChunk").value = g.read_chunk == null ? "" : g.read_chunk;
  $("#gRounds").value = g.max_rounds == null ? "" : g.max_rounds;
  $("#genError").textContent = "";
  // 默认值都是具体数字（见 store.js DEFAULT_SETTINGS），「非空」不等于「自定义」，
  // 所以要逐项与默认比对；只有改过才亮出「自定义」标签
  const d = { temperature: 0.7, top_p: 1, max_tokens: null, context_tokens: 32000, compress_ratio: 0.8, read_chunk: 12000, max_rounds: 10 };
  const custom = Object.keys(d).some((k) => g[k] != d[k]);
  $("#genTag").textContent = custom ? "自定义" : "";
}

async function onGenSubmit(e) {
  e.preventDefault();
  const err = $("#genError");
  const btn = $("#btnGenSave");
  err.textContent = "";
  btn.disabled = true;

  try {
    await store.saveGenParams({
      temperature: $("#gTemp").value,
      top_p: $("#gTopP").value,
      max_tokens: $("#gMaxTokens").value,
      context_tokens: $("#gCtx").value,
      compress_pct: $("#gRatio").value,
      read_chunk: $("#gChunk").value,
      max_rounds: $("#gRounds").value,
    });
    await loadGenParams();
    document.dispatchEvent(new CustomEvent("sa:genparams-changed")); // 预算变了，占用圆环重算
    toast("生成参数已保存");
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 列表 ---------- */

async function loadModels() {
  const box = $("#modelList");
  const list = await store.listModels();
  box.textContent = "";

  $("#modelCount").textContent = list.length ? `${list.length} 个` : "";
  const act = list.find((m) => m.active);
  $("#badgeModels").textContent = act ? act.model || act.name : "未配置";

  if (!list.length) {
    const p = document.createElement("p");
    p.className = "model-empty";
    p.textContent = "还没有登记模型，用下面的「添加模型」填一个。";
    box.appendChild(p);
    return;
  }
  for (const m of list) box.appendChild(modelRow(m));
}

function modelRow(m) {
  const el = document.createElement("div");
  el.className = "model-row" + (m.active ? " on" : "");

  const name = document.createElement("div");
  name.className = "model-name";
  name.textContent = m.name;
  name.title = `${m.provider} / ${m.model} · ${m.base_url} · ${
    m.has_key ? m.api_key_mask : "无密钥"
  }`;
  if (m.vision) {
    const tag = document.createElement("span");
    tag.className = "model-tag";
    tag.textContent = "图片理解";
    name.appendChild(tag);
  }

  const prov = document.createElement("span");
  prov.className = "model-prov";
  prov.textContent = m.provider;
  prov.title = m.provider;

  const editBtn = iconBtn("编辑", "model-act", EDIT_SVG, () => startEdit(m.id));

  const delBtn = iconBtn("删除", "model-act danger", TRASH_SVG, async () => {
    await store.deleteModel(m.id);
    if (editingId === m.id) exitEdit();
    toast("已删除：" + m.name);
    notifyModelsChanged();
    loadModels();
  });

  // 开关只决定「是否出现在模型下拉里」，与当前使用模型无关：各自独立，可同时开多个
  const sw = document.createElement("label");
  sw.className = "model-switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = m.enabled !== false;
  cb.setAttribute("aria-label", "在模型下拉中显示");
  sw.title = cb.checked ? "已显示在模型下拉中，点击隐藏" : "已在模型下拉中隐藏，点击显示";
  cb.addEventListener("change", async () => {
    cb.disabled = true;
    try {
      await store.setModelEnabled(m.id, cb.checked);
      toast(cb.checked ? "已在下拉中显示：" + m.name : "已从下拉中隐藏：" + m.name);
    } finally {
      loadModels();
    }
  });
  const track = document.createElement("span");
  track.className = "ms-track";
  sw.append(cb, track);

  el.append(modelIconEl(m), name, prov, editBtn, delBtn, sw);
  return el;
}

/** 行尾图标按钮：只有 svg + title，点击不会冒泡触发别的行为 */
function iconBtn(title, cls, svg, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}
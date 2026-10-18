/* 数据层：chrome.storage.local。
   键名统一 sa_ 前缀，与工作区其它扩展互不干扰。
   会话消息按会话分键存放，避免单条大记录被反复整体重写。 */

const KEY_META = "sa_meta";
const KEY_MODELS = "sa_models";
const KEY_SETTINGS = "sa_settings";
const KEY_SESSIONS = "sa_sessions";
const KEY_CURRENT = "sa_current_session";
const msgsKey = (id) => `sa_msgs_${id}`;
const sumKey = (id) => `sa_summary_${id}`; // 会话的上下文压缩摘要缓存

const SCHEMA_VERSION = 1;
const MAX_MESSAGES = 200; // 单会话消息上限，超出时从头截断

const DEFAULT_SETTINGS = {
  active_model_id: null,
  permission: "ask", // ask = 需要审批 | smart = 自主审批 | auto = 自动执行
  // 自主审批模式下可直接放行（跳过确认）的动作名；空 = 全部仍需确认。
  // 只对「会改动页面」的动作有意义（见 dsl.js 的 APPROVAL_VERBS）。
  approval_skip: [],
  send_key: "enter", // enter | ctrl-enter
  skills: [],
  // 功能指令开关：记录被关闭指令的 slash 名（空 = 全部可用）。
  // 只存「关」不存「开」：新增指令默认即启用，老数据零迁移。
  commands_off: [],
  // 今日要闻的检索来源（最多 3 个，存规范化后的完整网址）。
  // 空 = 不限来源，指令改走联网搜索；「新闻来源」设置页维护。
  news_sources: [],
  // 截图交付：true = 截完自动放进附件条；false = 复制到系统剪贴板
  shot_attach: true,
  // 操控流光：助手动页面期间目标页四边亮起流动光带；关掉后照常操作、只是不亮
  glow_on: true,
  // 划词翻译：选中正文后弹出「译」按钮，点击就地替换为译文
  translate_on: true,
  // 划词加入对话：选区旁弹出「加入对话」按钮，文本作为引用进面板待发区
  select_send_on: true,
  // 翻译方向：值直接用语言中文名（提示词里原样可用）；auto 项保持旧的自动判断行为
  translate_from: "自动检测",
  translate_to: "自动",
  // 常规生成参数：请求时直接带给模型
  temperature: 0.7, // 0–2，越大越发散
  top_p: 1, // 0–1，与温度二选一调即可
  max_tokens: null, // 最大输出 tokens；null = 不发送，交给服务端决定
  // 上下文预算：发给模型的历史最多占多少个 token，超出就从最旧的一头裁掉。
  // 长页面（论文、文档）一次读取就要上万 token，8000 远远不够，故默认放到 32000。
  context_tokens: 32000,
  // 压缩阈值：占预算的比例，达到就用一次调用把最旧的历史压成摘要
  compress_ratio: 0.8,
  // 读取分段长度（字符）：read_page / extract 长正文每次回传一段的上限。
  // 越大单次信息越全但更占上下文，越小轮次越多；保存时夹在 2000–30000。
  read_chunk: 12000,
  // 工具调用轮次上限：一次对话里模型最多自主调用几轮工具，防止打转；
  // 保存时夹在 1–30。
  max_rounds: 10,
};

const LEGACY_BUDGET = 8000; // 旧默认预算，仅用于升级迁移识别

async function read(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] ?? fallback;
}

const write = (patch) => chrome.storage.local.set(patch);

const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;

/* 会话的读-改-写要跨面板串行：同一窗口切标签、或两个窗口各开一个面板时，
   并发读 sa_sessions 再整体写回会互相覆盖（丢会话/丢绑定）。扩展页面同源，
   Web Locks 正好跨文档生效；不可用时退化为直接执行（单面板场景本就无并发）。 */
const locked = (fn) =>
  navigator.locks?.request ? navigator.locks.request("sa_sessions_lock", fn) : fn();

/* ---------- 初始化 ---------- */

export async function ensureSchema() {
  const meta = await read(KEY_META, null);
  if (!meta || meta.schema_version !== SCHEMA_VERSION) {
    await write({ [KEY_META]: { schema_version: SCHEMA_VERSION } });
  }
}

/* ---------- 通用设置 ---------- */

export async function getSettings() {
  const stored = await read(KEY_SETTINGS, {});
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // 旧版本默认值 8000 读长页面必爆：只要还是这个值（说明没被明确改过），一次性升到新默认
  if (stored.context_tokens === LEGACY_BUDGET) {
    s.context_tokens = DEFAULT_SETTINGS.context_tokens;
    await write({ [KEY_SETTINGS]: { ...stored, context_tokens: s.context_tokens } });
  }
  return s;
}

export async function saveSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await write({ [KEY_SETTINGS]: next });
  return next;
}

/* ---------- 常规生成参数 ---------- */

/** 空串当「不填」处理：Number("") 是 0，直接转会把温度错设成 0 */
function toNum(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 只接受范围内的值，越界就夹回边界；留空则回落默认值 */
export async function saveGenParams({ temperature, top_p, max_tokens, context_tokens, compress_pct, read_chunk, max_rounds }) {
  const t = toNum(temperature);
  const p = toNum(top_p);
  const m = toNum(max_tokens);
  const c = toNum(context_tokens);
  const r = toNum(compress_pct);
  const k = toNum(read_chunk);
  const g = toNum(max_rounds);
  return saveSettings({
    temperature: t == null ? DEFAULT_SETTINGS.temperature : clamp(t, 0, 2),
    top_p: p == null ? DEFAULT_SETTINGS.top_p : clamp(p, 0, 1),
    max_tokens: m == null || m <= 0 ? null : Math.round(m),
    context_tokens: c == null || c < 500 ? DEFAULT_SETTINGS.context_tokens : Math.round(c),
    compress_ratio: r == null ? DEFAULT_SETTINGS.compress_ratio : clamp(r, 50, 95) / 100,
    read_chunk: k == null ? DEFAULT_SETTINGS.read_chunk : clamp(Math.round(k), 2000, 30000),
    max_rounds: g == null ? DEFAULT_SETTINGS.max_rounds : clamp(Math.round(g), 1, 30),
  });
}

/** 供请求体与历史裁剪使用（read_chunk / max_rounds 只给设置页回填表单与发送流程用，不进请求体） */
export async function genParams() {
  const s = await getSettings();
  return {
    temperature: s.temperature,
    top_p: s.top_p,
    max_tokens: s.max_tokens,
    context_tokens: s.context_tokens,
    compress_ratio: s.compress_ratio,
    read_chunk: s.read_chunk,
    max_rounds: s.max_rounds,
  };
}

/* ---------- 上下文压缩摘要 ---------- */

/** 取会话的摘要缓存 { upto, text }；没有返回 null */
export async function getSummary(sessionId) {
  return read(sumKey(sessionId), null);
}

/** upto = 已被摘要覆盖的最后一条消息 id，下次只压缩它之后的内容 */
export async function saveSummary(sessionId, data) {
  await write({ [sumKey(sessionId)]: data });
  return data;
}

/* ---------- 模型用量统计 ---------- */

/* 结构（键 sa_usage，按模型 id 分桶）：
   { [modelId]: {
       prompt, completion, calls,        // 累计（从写入起）
       kinds: { chat, summary, title, translate },  // 按用途的累计调用次数
       days: { "2026-10-10": { prompt, completion, calls, kinds } },  // 按天，给近 7 天视图
       last_at: ISO,
   } }
   写入方有两处（面板侧 llm.js 与 SW 里翻译），结构须保持一致。 */
const KEY_USAGE = "sa_usage";
const USAGE_KEEP_DAYS = 60; // days 明细保留天数，防无限膨胀

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function getUsage() {
  return read(KEY_USAGE, {});
}

/**
 * 记一次调用的用量。usage 取模型服务返回的标准字段
 * （prompt_tokens / completion_tokens）；没拿到就不记，避免脏数据。
 * 统计是旁路能力：任何异常都吞掉打日志，绝不影响主流程。
 */
export async function recordUsage(modelId, kind, usage, at = new Date()) {
  try {
    const p = Number(usage?.prompt_tokens) || 0;
    const c = Number(usage?.completion_tokens) || 0;
    if (!modelId || (!p && !c)) return;

    const all = await read(KEY_USAGE, {});
    const rec = all[modelId] || { prompt: 0, completion: 0, calls: 0, kinds: {}, days: {}, last_at: "" };
    rec.prompt += p;
    rec.completion += c;
    rec.calls += 1;
    rec.kinds[kind] = (rec.kinds[kind] || 0) + 1;

    const day = dayKey(at);
    const d = rec.days[day] || { prompt: 0, completion: 0, calls: 0, kinds: {} };
    d.prompt += p;
    d.completion += c;
    d.calls += 1;
    d.kinds[kind] = (d.kinds[kind] || 0) + 1;
    rec.days[day] = d;
    rec.last_at = at.toISOString();

    // 裁掉过期的按天明细
    const cutoff = dayKey(new Date(at.getTime() - USAGE_KEEP_DAYS * 86400e3));
    for (const k of Object.keys(rec.days)) if (k < cutoff) delete rec.days[k];

    all[modelId] = rec;
    await write({ [KEY_USAGE]: all });
  } catch (err) {
    console.warn("[side-assistant] 记录用量失败：", err);
  }
}

/* ---------- 模型登记（列表里密钥打码） ---------- */

function maskKey(k) {
  const s = String(k || "");
  if (!s) return "";
  if (s.length <= 8) return "*".repeat(s.length);
  return s.slice(0, 4) + "****" + s.slice(-4);
}

function toView(m) {
  return {
    id: m.id,
    name: m.name || "",
    provider: m.provider || "",
    model: m.model || "",
    base_url: m.base_url || "",
    api_key_mask: maskKey(m.api_key),
    has_key: !!m.api_key,
    vision: !!m.vision,
    enabled: m.enabled !== false,
    active: !!m.active,
    created_at: m.created_at,
  };
}

export async function rawModels() {
  return read(KEY_MODELS, []);
}

export async function listModels() {
  const list = await rawModels();
  return list.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(toView);
}

/** 归一化 API 地址：补默认协议、校验合法性。保存前先过一遍，把非法地址拦在最前 */
export function normalizeURL(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("API 地址不能为空");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    new URL(s);
  } catch {
    throw new Error("API 地址不合法");
  }
  return s;
}

/** 表单 -> 存储字段：去空白、归一化地址，校验必填与同名（编辑时用 exceptId 排除自己） */
function cleanModel(body, list, exceptId = null) {
  const m = {
    name: (body.name || "").trim(),
    provider: (body.provider || "").trim(),
    model: (body.model || "").trim(),
    base_url: normalizeURL(body.base_url),
    api_key: (body.api_key || "").trim(),
    vision: !!body.vision,
  };
  if (!m.name || !m.provider || !m.model) throw new Error("名称、供应商、模型均不能为空");
  if (list.some((x) => x.name === m.name && x.id !== exceptId)) throw new Error("同名模型已登记");
  return m;
}

export async function createModel(body) {
  const list = await rawModels();
  const m = {
    ...cleanModel(body, list),
    id: nextId(list),
    enabled: true,
    active: false,
    created_at: new Date().toISOString(),
  };
  list.push(m);
  await write({ [KEY_MODELS]: list });
  return toView(m);
}

/** 取单个模型原始记录（含明文密钥，供编辑回填）；不存在返回 null */
export async function getModel(id) {
  const list = await rawModels();
  const m = list.find((x) => x.id === id);
  return m ? { ...m } : null;
}

/** 用编辑后的配置覆盖已有模型（id / 创建时间 / 启用状态保持不变） */
export async function updateModel(id, body) {
  const list = await rawModels();
  const m = list.find((x) => x.id === id);
  if (!m) throw new Error("记录不存在");
  Object.assign(m, cleanModel(body, list, id));
  await write({ [KEY_MODELS]: list });
  return toView(m);
}

export async function deleteModel(id) {
  const list = await rawModels();
  const rest = list.filter((x) => x.id !== id);
  if (rest.length === list.length) throw new Error("记录不存在");
  await write({ [KEY_MODELS]: rest });

  const s = await getSettings();
  if (s.active_model_id === id) await saveSettings({ active_model_id: null });
}

export async function activateModel(id) {
  const list = await rawModels();
  const m = list.find((x) => x.id === id);
  if (!m) throw new Error("记录不存在");
  for (const x of list) x.active = x.id === id;
  await write({ [KEY_MODELS]: list });
  await saveSettings({ active_model_id: id });
  return toView(m);
}

/** 开关某模型是否出现在模型下拉里。只影响可见性，不碰当前使用模型 */
export async function setModelEnabled(id, enabled) {
  const list = await rawModels();
  const m = list.find((x) => x.id === id);
  if (!m) throw new Error("记录不存在");
  m.enabled = !!enabled;
  await write({ [KEY_MODELS]: list });
  return toView(m);
}

/** 取当前使用的模型原始记录（含密钥），未配置返回 null */
export async function activeModel() {
  const s = await getSettings();
  if (s.active_model_id == null) return null;
  const list = await rawModels();
  return list.find((x) => x.id === s.active_model_id) || null;
}

/* ---------- 会话 ---------- */

/** 无锁版新建（供已持锁的调用方复用——Web Locks 不可重入，嵌套再拿同名锁会死锁） */
async function createSessionRaw(tabId) {
  const list = await read(KEY_SESSIONS, []);
  const now = new Date().toISOString();
  const s = {
    id: nextId(list),
    title: "新会话",
    created_at: now,
    updated_at: now,
    message_count: 0,
    tab_id: tabId ?? null,
  };
  list.push(s);
  await write({ [KEY_SESSIONS]: list, [KEY_CURRENT]: s.id, [msgsKey(s.id)]: [] });
  return s;
}

/** 新建会话；可同时声明归属标签（tab_id，一个会话最多绑一个标签，一个标签可有多个会话） */
export function createSession(tabId = null) {
  return locked(() => createSessionRaw(tabId));
}

/** 取单个会话（不存在返回 null） */
export async function getSession(id) {
  const list = await read(KEY_SESSIONS, []);
  return list.find((s) => s.id === id) || null;
}

/** 绑定 / 解绑标签：tabId 传 null 即解绑 */
export function bindSession(id, tabId) {
  return locked(async () => {
    const list = await read(KEY_SESSIONS, []);
    const s = list.find((x) => x.id === id);
    if (!s || s.tab_id === tabId) return s || null;
    s.tab_id = tabId ?? null;
    await write({ [KEY_SESSIONS]: list });
    return s;
  });
}

/** 某标签最近使用的一个绑定会话（切换标签时面板跟随用）；没有则 null */
export async function latestSessionByTab(tabId) {
  if (tabId == null) return null;
  const list = await read(KEY_SESSIONS, []);
  const mine = list.filter((s) => s.tab_id === tabId);
  if (!mine.length) return null;
  return mine.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
}

/** 标签关闭后解绑它的所有会话（会话保留，只是不再跟标签走） */
export function unbindTab(tabId) {
  return locked(async () => {
    const list = await read(KEY_SESSIONS, []);
    let hit = false;
    for (const s of list) {
      if (s.tab_id === tabId) {
        s.tab_id = null;
        hit = true;
      }
    }
    if (hit) await write({ [KEY_SESSIONS]: list });
    return hit;
  });
}

export function touchSession(id, patch) {
  return locked(async () => {
    const list = await read(KEY_SESSIONS, []);
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch, { updated_at: new Date().toISOString() });
    await write({ [KEY_SESSIONS]: list });
    return s;
  });
}

/** 会话列表，最近更新的排在前面 */
export async function listSessions() {
  const list = await read(KEY_SESSIONS, []);
  return list.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

/** 切到指定会话；不存在则返回 false，由调用方决定怎么兜底 */
export function setCurrentSession(id) {
  return locked(async () => {
    const list = await read(KEY_SESSIONS, []);
    if (!list.some((s) => s.id === id)) return false;
    await write({ [KEY_CURRENT]: id });
    return true;
  });
}

export async function renameSession(id, title) {
  const t = String(title || "").trim();
  if (!t) throw new Error("标题不能为空");
  return touchSession(id, { title: t.slice(0, 40) });
}

/**
 * 删除会话（连消息一起清）。
 * 删掉的若是当前会话，指针挪到剩下的最近一个；一个不剩就清空指针返回 null，
 * 由调用方决定下一步（面板侧进草稿态，不在这里硬造空会话）。
 * @returns {Promise<number|null>} 删除后全局指针指向的会话 id，可能为 null
 */
export function deleteSession(id) {
  return locked(async () => {
    const list = await read(KEY_SESSIONS, []);
    const rest = list.filter((s) => s.id !== id);
    if (rest.length === list.length) throw new Error("会话不存在");

    await write({ [KEY_SESSIONS]: rest });
    await chrome.storage.local.remove([msgsKey(id), sumKey(id)]);

    const cur = await read(KEY_CURRENT, null);
    if (cur !== id) return cur;

    if (rest.length) {
      const next = rest.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
      await write({ [KEY_CURRENT]: next.id });
      return next.id;
    }
    await chrome.storage.local.remove(KEY_CURRENT);
    return null;
  });
}

/**
 * 批量删除所有「没有绑定标签」的会话（连消息与摘要一起清）。
 * 会话列表加载时会把标签已关闭的会话懒解绑，所以这里也会顺带清掉它们的残留。
 * @returns {Promise<number[]>} 被删除的会话 id
 */
export function deleteUnboundSessions() {
  return locked(async () => {
    const list = await read(KEY_SESSIONS, []);
    const gone = list.filter((s) => s.tab_id == null);
    if (!gone.length) return [];

    const rest = list.filter((s) => s.tab_id != null);
    await write({ [KEY_SESSIONS]: rest });
    await chrome.storage.local.remove(gone.flatMap((s) => [msgsKey(s.id), sumKey(s.id)]));

    // 当前指针若指向被删会话，挪到剩下的最近一个；一个不剩就清空
    const cur = await read(KEY_CURRENT, null);
    if (cur != null && gone.some((s) => s.id === cur)) {
      if (rest.length) {
        const next = rest.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
        await write({ [KEY_CURRENT]: next.id });
      } else {
        await chrome.storage.local.remove(KEY_CURRENT);
      }
    }
    return gone.map((s) => s.id);
  });
}

export async function getMessages(sessionId) {
  return read(msgsKey(sessionId), []);
}

export async function saveMessages(sessionId, messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await write({ [msgsKey(sessionId)]: trimmed });
  return trimmed;
}
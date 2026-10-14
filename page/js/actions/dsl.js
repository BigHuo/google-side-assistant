/* Action DSL：Agent 与执行层之间的指令契约。
   这里同时对外暴露两份东西：
   - TOOLS：交给模型的 function calling 声明
   - describe()：给「步骤卡片」和审批提示用的人话描述
   工具以注册表形式聚合：每个工具声明 kind（page=页面动作 / api=数据动作）与
   readOnly（只读动作在「需要审批」模式下不打断用户）。新增工具只需在
   REGISTRY 里加一项，下游（executor / 审批 / 步骤卡片）自动跟随。 */

/* ---------- 页面动词的公共参数 ---------- */

const TARGET_PROPS = {
  index: {
    type: "integer",
    description: "目标元素编号，取自 read_page 返回的 elements[].i。优先使用它。",
  },
  selector: {
    type: "string",
    description: "CSS 选择器，仅在记不住编号时兜底使用。",
  },
};

const targetText = (args) => {
  if (!args) return "";
  if (args.index != null && args.index !== "") return `#${args.index}`;
  if (args.selector) return String(args.selector).slice(0, 40);
  return "";
};

/* ---------- 工具注册表 ---------- */

const REGISTRY = [
  {
    name: "read_page",
    kind: "page",
    readOnly: true,
    declaration: {
      description:
        "读取当前标签页：返回网址、标题、可见的可交互元素（带编号）以及正文。任何页面操作之前都必须先调用它拿编号。页面发生变化后编号会失效，需要重新调用。长页面的正文会分段返回（结果里标出「正文共 N 字，本次第 a–b 字」），再次调用会接着往后读，不需要先滚动。",
      parameters: { type: "object", properties: {}, required: [] },
    },
    validate: () => true,
    describe: () => "读取当前页面",
  },
  {
    name: "click",
    kind: "page",
    label: "点击元素",
    desc: "点击页面上的按钮、链接等元素（含会开新标签页的链接）",
    declaration: {
      description:
        "点击页面元素。用 read_page 给出的编号指定目标。若点的是原本会开新标签页的链接（target=_blank），会自动改为在当前标签页内打开，之后直接 read_page 即可读到它。",
      parameters: { type: "object", properties: { ...TARGET_PROPS }, required: [] },
    },
    validate: (a) =>
      (a.index != null && a.index !== "") || !!a.selector ? true : "click 需要 index 或 selector",
    describe: (a) => {
      const t = targetText(a);
      return t ? `点击元素 ${t}` : "点击页面元素";
    },
  },
  {
    name: "type",
    kind: "page",
    label: "输入文本",
    desc: "在输入框中填入文本或清空原有内容",
    declaration: {
      description: "在输入框中输入文本，会先聚焦并全选原有内容再输入（传入空字符串即清空）。",
      parameters: {
        type: "object",
        properties: { ...TARGET_PROPS, value: { type: "string", description: "要输入的文本" } },
        required: ["value"],
      },
    },
    validate: (a) => {
      if (!((a.index != null && a.index !== "") || a.selector)) return "type 需要 index 或 selector";
      if (typeof a.value !== "string") return "type 需要字符串 value";
      return true;
    },
    describe: (a) => {
      const v = String(a.value ?? "");
      const t = targetText(a);
      return `输入${v ? `「${v.slice(0, 20)}」` : "（清空）"}${t ? " 到 " + t : ""}`;
    },
  },
  {
    name: "scroll",
    kind: "page",
    readOnly: true,
    declaration: {
      description: "滚动当前页面。",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", enum: ["up", "down", "top", "bottom"], description: "滚动方向，默认 down" },
        },
        required: [],
      },
    },
    validate: () => true,
    describe: (a) => {
      const word = { up: "向上", down: "向下", top: "到顶部", bottom: "到底部" }[a.value] || "向下";
      return `页面${word}滚动`;
    },
  },
  {
    name: "goto",
    kind: "page",
    label: "打开网址",
    desc: "把当前标签页导航到指定网址",
    declaration: {
      description: "在当前标签页打开一个网址。",
      parameters: {
        type: "object",
        properties: { value: { type: "string", description: "完整网址或域名" } },
        required: ["value"],
      },
    },
    validate: (a) => (String(a.value || "").trim() ? true : "goto 需要网址 value"),
    describe: (a) => `打开 ${String(a.value || "").slice(0, 60)}`,
  },
  {
    name: "search_web",
    kind: "page",
    label: "联网搜索",
    desc: "把当前标签页带到必应搜索结果页",
    declaration: {
      description:
        "联网搜索：把当前标签页导航到必应（cn.bing.com）的搜索结果页并等它加载完成，之后用 read_page / extract 读取结果。需要最新网络信息（新闻、价格、版本号等）时用；当前页面读不了或不可操作（内置页、读取报错）时，也用它先把标签带到可操作的页面。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索词" } },
        required: ["query"],
      },
    },
    validate: (a) => (String(a.query || "").trim() ? true : "search_web 需要搜索词 query"),
    describe: (a) => `搜索：${String(a.query || "").slice(0, 30)}`,
  },
  {
    name: "wait",
    kind: "page",
    readOnly: true,
    declaration: {
      description: "等待一段时间，用于等页面加载或异步内容出现。",
      parameters: {
        type: "object",
        properties: { ms: { type: "integer", description: "毫秒数，100~10000，默认 1000" } },
        required: [],
      },
    },
    validate: () => true,
    describe: (a) => `等待 ${((Number(a.ms) || 1000) / 1000).toFixed(1)} 秒`,
  },
  {
    name: "extract",
    kind: "page",
    readOnly: true,
    declaration: {
      description:
        "读取某个元素（或整页）的可见文字，用于提取信息。整页读取会分段返回，再次调用接着往后读（不需要先滚动）；指定 index/selector 时按目标元素整体读取。",
      parameters: { type: "object", properties: { ...TARGET_PROPS }, required: [] },
    },
    validate: () => true,
    describe: (a) => {
      const t = targetText(a);
      return t ? `读取元素 ${t} 的文字` : "读取页面文字";
    },
  },
  {
    name: "search_papers",
    kind: "api",
    readOnly: true,
    declaration: {
      description:
        "检索学术论文（用于文献调研，来源限定 arXiv 预印本库，CS/物理/数学为主）。可多次调用换词重查；同一查询的结果里 arXiv ID 相同的是同一篇。返回字段：title、authors、year、venue（固定 arXiv）、citations（arXiv 不提供，恒为 null）、doi、arxiv_id、oa_url（arXiv HTML 在线阅读链接）、abstract。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "检索词，英文为主。arxiv 支持字段前缀（ti:/au:/abs:/cat:，如 ti:attention AND cat:cs.LG）",
          },
          sources: {
            type: "array",
            items: { type: "string", enum: ["arxiv", "openalex", "s2"] },
            description: "检索来源。默认且建议只用 [\"arxiv\"]（本产品文献调研已限源 arXiv）",
          },
          limit: { type: "integer", description: "每个来源返回条数，1~8，默认 5" },
          year_from: { type: "integer", description: "发表年份下限（含），如 2023" },
        },
        required: ["query"],
      },
    },
    validate: (a) => (String(a.query || "").trim() ? true : "search_papers 需要检索词 query"),
    describe: (a) => {
      const q = String(a.query || "").slice(0, 30);
      const src = Array.isArray(a.sources) && a.sources.length ? a.sources.join("/") : "arxiv";
      return `检索文献（${src}）：${q}`;
    },
  },
];

const byName = new Map(REGISTRY.map((t) => [t.name, t]));

/* ---------- 对外契约（与旧接口保持兼容） ---------- */

export const VALID_VERBS = REGISTRY.map((t) => t.name);

/** 只读动作：即使处于「需要审批」模式也不打断用户 */
export const READ_ONLY_VERBS = REGISTRY.filter((t) => t.readOnly).map((t) => t.name);

/** 需要审批的动作（非只读）：设置页据此列出「自主审批」模式下可放行的操作 */
export const APPROVAL_VERBS = REGISTRY.filter((t) => !t.readOnly).map((t) => ({
  name: t.name,
  label: t.label,
  desc: t.desc,
}));

/** 交给模型的工具声明（OpenAI 兼容 function calling） */
export const TOOLS = REGISTRY.map((t) => ({
  type: "function",
  function: { name: t.name, ...t.declaration },
}));

/** 工具的执行通道：page → PAGE_ACTION（页面动作），api → API_ACTION（数据检索） */
export const kindOf = (name) => byName.get(name)?.kind || "page";

/**
 * 校验工具参数是否合法（与执行端约定一致）。
 * @param {string} name 工具名
 * @param {object} args 工具参数
 * @returns {{ok: boolean, error?: string}}
 */
export function validateArgs(name, args) {
  const t = byName.get(name);
  if (!t) return { ok: false, error: `不支持的 verb：${name}` };
  const r = t.validate(args || {});
  return r === true ? { ok: true } : { ok: false, error: r };
}

/**
 * 生成人话描述，用于步骤卡片与审批提示。
 * @param {string} name 工具名
 * @param {object} args 工具参数
 * @returns {string}
 */
export function describe(name, args = {}) {
  const t = byName.get(name);
  return t ? t.describe(args) : name;
}

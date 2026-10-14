/* 内置 Skill 层：声明式定义 + system prompt 注入 + 快捷 chips 生成。
   一个 skill = { id, label, prompt, draft? }：
   - prompt 蒸馏自 skills/ 目录下的成熟 skill 包（academic-search 的检索规范
     与去重核验、deep-research 的 3W 综合框架、nature-paper-xray / paper-card
     的精读框架），常驻注入 system（当前仅两个，体积可控）。
   - draft 只影响功能指令菜单（/ 与下拉）里的形态：进指令块等用户补参；
     顶部快捷 chip 不受影响，点击一律一键直发。
   后续新增 skill：在 SKILLS 里加一项即可，chips 与注入自动跟随。 */

import * as store from "./store.js";

const SURVEY_PROMPT = `# 文献调研模式
用户要求调研文献 / 调研某个方向时（消息含「文献调研」或等价说法），按以下流程执行：

1. **分解选题**：来源固定只用 arXiv（sources 一律传 ["arxiv"]，不查其他库）；把方向拆成 2~4 组互补的英文查询词（可用 ti:/au:/abs:/cat: 字段前缀提准）；开放式选题先 limit=3 轻量探路，定了调再补核心文献。用户没给方向时，先用一句话问清研究对象，不要长篇追问。
2. **检索**：调用 search_papers（可多次，换词重查，sources 始终 ["arxiv"]）；被限流就稍后重试或如实说明，绝不臆造论文。年份范围用户没说就不设限。arXiv 覆盖不到的领域如实讲明，不要硬凑。
3. **去重核验**：arXiv ID 相同的归为一篇；标题高度相似的只算候选，标注待核对；arXiv 不提供引用数，缺的字段写「未提供」，严禁编造 venue、引用数或结论。
4. **输出**（Markdown，用表格承载清单）：
   - **WHY**：这个方向为什么值得做，痛点如何演进（2~4 句）
   - **HOW**：2~3 条主流技术路线，各配 1~2 篇代表作与优劣对比
   - **WHAT**：已解决 / 未解决 / 存在争议的分界
   - **论文清单**：编号 | 标题 | 年份 | 标识符(arXiv ID) | 在线阅读(arXiv HTML)；按「奠基 / 核心 / 近期」分组
   - 结尾给出「推荐精读：编号 ×2~3」并说明理由——**只推荐，不主动精读**，由用户选择
   - **检索透明度**：实际使用的查询词、返回条数、被限流情况
禁止：不读全文就断言论文细节；把单一来源的结果说成领域全貌；虚构任何一篇论文。`;

const READING_PROMPT = `# 论文精读模式
用户要求精读（消息含「论文精读」「精读这篇」或指定调研清单中某篇）时：

1. **先判定页面是不是一篇论文**：read_page 看第一段——有论文特征（标题 + 作者 + 摘要/编号 + Introduction 等章节结构）才算；来源不限（arXiv / 期刊 / 会议官网 / 作者主页均可）。不是单篇论文（搜索或列表页、首页、PDF 查看器等拿不到正文的情况）就如实说明当前页是什么，请用户导航或给出链接，不要硬读。
2. **从头读起**：确认是论文后连续 read_page 读到末尾再综合，不要只读首段就下结论。若返回显示不是从第 1 字起（本页此前被读过、读取游标已后移），先 goto 当前网址重新加载以重置游标，再从第 1 段读起。用户指定的是调研清单编号且当前页不是它时，先 goto 该篇「在线阅读」链接再按本条执行；目标没有可读全文（老论文常见）就如实说明，改读摘要页并注明只读了摘要，不要基于摘要脑补全文。
3. **输出精读卡**（Markdown）：
   - **定位**：一句话讲这篇做了什么、属于哪条路线（若来自此前调研，注明它在清单中的编号与角色）
   - **作者的赌注**：真实起点（他们接手时领域卡在哪）、要解决的核心问题、押注的关键假设
   - **承重设计**：方法里真正起作用的部分 vs 装饰性组件，说清区分依据（消融 / 结构分析）
   - **证据链**：每个关键结论 → 对应的实验与数据，强度如何；关键公式给出一个可手算的微型例子
   - **边界**：作者哪里自信、哪里没报告；证据实际够到哪里为止
   - **可借鉴**：方法、实验设计、写作上可迁移到其他工作的点
4. 引用论文里的表述时标明出处小节；论文没讲的写「未报告」，不脑补。`;

const SKILLS = [
  { id: "literature-survey", label: "文献调研探索", prompt: SURVEY_PROMPT, draft: "文献调研：", slash: "survey", desc: "arXiv 检索并产出调研报告" },
  { id: "paper-reading", label: "论文精读", prompt: READING_PROMPT, slash: "paper", desc: "对当前页论文输出精读卡" },
];

/** 拼进 system prompt 的 skill 指令（内置 skill 常驻注入） */
export const skillPrompt = () => SKILLS.map((s) => s.prompt).join("\n\n");

/* 今日要闻：探寻今天的重要新闻。来源范围来自设置页「新闻来源」（最多 3 个网址），
   每次触发时实时读取配置拼进指令——配置改动即刻生效，不需要重启或迁移。
   prompt 允许是 async 函数，applyCommand 会 await 后再发送。
   带 visible 的指令不把大段指令文本亮在对话框里：气泡只显示 visible 短语，
   完整指令作为隐藏上下文随消息发给模型（见 chat.js 的 hidden 处理）。 */
async function newsPrompt() {
  const s = await store.getSettings();
  const srcs = (s.news_sources || []).filter(Boolean);
  const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const scope = srcs.length
    ? `只从下面用户配置的来源网站探寻（逐个打开，不要去别处检索）：\n${srcs
        .map((u, i) => `${i + 1}. ${u}`)
        .join("\n")}`
    : "用户未配置新闻来源：先用 search_web 搜索「今日要闻」，再用 read_page 读取结果页。";
  return `# 今日要闻（${today}）
探寻今天的重要新闻。
检索范围：${scope}
流程：
1. 逐个来源 goto 打开，read_page 读新闻列表（标题、链接、时间）；列表在首屏读不全就继续往后读分段；
2. 只保留今天发布或标注为「刚刚 / N 小时前」的条目；来源页看不到日期的如实标注「日期未知」，不猜；
3. 每个来源挑最重要的 3~5 条；全场最重要的 1~3 条可以 goto 进文章读开头一两段，取一句话摘要。
输出（Markdown）：
- 按来源分节的今日要闻清单：标题（附链接）+ 一句话说明；
- 结尾「今日焦点」：跨来源挑 3 条最重要的，各配一句为什么重要。
禁止：编造新闻或链接；同一事件被多家来源转载的合并成一条并注明；把非今日的旧闻混进清单（日期未知的单独标注）。`;
}

/**
 * 快捷 chips：一律一键直发，无需二次确认（prompt 为动态函数的走 applyCommand）。
 * 与 SKILLS 解耦的通用助手项也在这里排队。
 * 挂了 slash + desc 的 chip 会同时注册为功能指令（见 CHIP_COMMANDS），
 * 出现在「功能指令」下拉与「/」菜单里；chip 本身仍是固定快捷位，不受设置开关影响。
 */
export const CHIPS = [
  { label: "总结当前页面", slash: "summary", desc: "通读全页后给出内容总结" },
  ...SKILLS.map(({ label, slash, desc, draft }) =>
    draft ? { label, slash, desc, draft } : { label, slash, desc },
  ),
  { label: "今日要闻", slash: "news", desc: "探寻今天的重要新闻（来源可在设置里限定）", visible: "今日要闻", prompt: newsPrompt },
];

/** 从 chips 派生的功能指令：无 draft 的用 prompt（静态文本或动态函数），
    都没有时用 label 原文直发（与点 chip 同一条路）；有 draft 的预填输入框等补参。
    visible 一并透传：有它的指令气泡只显示短语、完整指令走隐藏上下文。
    单一来源，chip 与菜单永不脱节。 */
export const CHIP_COMMANDS = CHIPS.filter((c) => c.slash).map(
  ({ slash, label: name, desc, draft, prompt, visible }) =>
    draft
      ? { slash, name, desc, draft }
      : visible
        ? { slash, name, desc, visible, prompt: prompt ?? name }
        : { slash, name, desc, prompt: prompt ?? name },
);

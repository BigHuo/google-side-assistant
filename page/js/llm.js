/* AI 调用层：OpenAI 兼容协议，流式（SSE）+ function calling。
   沿用 google-tag-plugins 的请求约定：endpoint 归一化、Bearer 头、错误文案统一。 */

import * as store from "./store.js";
import { skillPrompt } from "./skills.js";

const SYSTEM =
  "你是浏览器侧边栏里的 AI 助手「灵阅AI助手」，用简体中文回答，简洁直接，不说客套话。" +
  "你可以调用工具真实操作用户当前所在的网页：先调用 read_page 读取页面（会给出可操作元素的编号），再用 click / type 等按编号操作。" +
  "页面一旦发生变化，之前拿到的编号就会失效，必须重新 read_page。" +
  "需要最新网络信息（新闻、行情、版本号等），或当前页面读不了（内置页、读取报错）时，先用 search_web 搜索，再用 read_page 读取结果。" +
  "一切以工具返回为准，不要凭想象描述页面内容；工具报错就如实说明，不要假装已经完成。" +
  "涉及提交、支付、发送、删除等不可逆操作前，先用一两句话向用户确认。" +
  "任务完成或无需操作时，直接用文字回答。\n\n" +
  skillPrompt();

/** 面向用户的错误，message 直接展示在气泡里 */
export class LLMError extends Error {}

const VERIFY_TIMEOUT = 15000;

/**
 * 保存前用一次最小请求验证配置（API 地址 / 密钥 / 模型名）是否真的可用。
 * 真实走一遍 chat/completions，能通才算配置正确；失败抛 LLMError，
 * 上层把 message 直接展示给用户，验证不过就不写进模型列表。
 * @param {{base_url: string, api_key: string, model: string}} cfg 归一化后的配置
 */
export async function verifyModel({ base_url, api_key, model }) {
  if (!model) throw new LLMError("请填写模型名");
  if (!api_key) throw new LLMError("请填写密钥");

  let endpoint = String(base_url || "").replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + api_key,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new LLMError(
      err?.name === "AbortError" ? "验证超时，检查 API 地址" : "连不上模型服务，检查网络或 API 地址",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new LLMError(`配置验证失败（HTTP ${res.status}）${await detailOf(res)}`);
  const out = await res.json().catch(() => null);
  if (out?.error) throw new LLMError("配置验证失败：" + out.error.message);
}

/**
 * 流式对话（可带工具）。
 * @param {{role: string, content: string, tool_calls?: any[]}[]} messages 不含 system，由本函数补
 * @param {{signal?: AbortSignal, tools?: any[]}} [opts]
 * @returns {AsyncGenerator<{type: "text", value: string} | {type: "tool_calls", calls: any[]}>}
 */
export async function* streamChat(messages, { signal, tools } = {}) {
  const model = await store.activeModel();
  if (!model) throw new LLMError("还没配置模型，点右上角齿轮登记一个");
  if (!model.api_key) throw new LLMError(`「${model.name}」没有填写密钥`);

  let endpoint = model.base_url.replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";

  // 常规生成参数：温度 / top_p 总是带上；最大输出留空则不发送，交给服务端决定
  const gen = await store.genParams();

  // 带图消息按模型能力转换：支持图片理解的走 OpenAI 多模态 content 数组；
  // 不支持的压成文字占位（历史里带图的消息在切换模型后仍能继续对话，不至于报错）
  const toContent = (m) => {
    if (!m.images?.length) return m.content;
    if (model.vision) {
      return [
        { type: "text", text: m.content || "（请看图）" },
        ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
      ];
    }
    return (m.content ? m.content + "\n" : "") + "（此处原本附有图片，当前模型不支持查看）";
  };

  const body = {
    model: model.model,
    messages: [
      { role: "system", content: SYSTEM },
      ...messages.map((m) => (m.images?.length ? { ...m, content: toContent(m) } : m)),
    ],
    stream: true,
    // 流式响应默认不带 usage，显式让末包带上（供 token 统计）；
    // 个别网关不认这个字段，下面 400 时去掉重发一次
    stream_options: { include_usage: true },
    temperature: gen.temperature,
    top_p: gen.top_p,
  };
  if (gen.max_tokens) body.max_tokens = gen.max_tokens;
  if (tools && tools.length) body.tools = tools;

  const send = () =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + model.api_key,
      },
      body: JSON.stringify(body),
      signal,
    });

  let res;
  try {
    res = await send();
    if (res.status === 400) {
      delete body.stream_options; // 网关不认这个字段：去掉原样重发
      res = await send();
    }
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new LLMError("连不上模型服务，检查网络或 API 地址");
  }

  if (!res.ok) throw new LLMError(`模型服务异常（HTTP ${res.status}）${await detailOf(res)}`);

  // 服务端若忽略了 stream，会直接回一个完整 JSON，这里兜底成一次性输出
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.includes("text/event-stream") && res.body) {
    let usage = null;
    for await (const ev of parseSSE(res.body)) {
      if (ev.type === "usage") usage = ev.value;
      else yield ev;
    }
    if (usage) void store.recordUsage(model.id, "chat", usage);
    return;
  }

  const out = await res.json().catch(() => null);
  if (out?.error) throw new LLMError("模型服务报错：" + out.error.message);
  if (out?.usage) void store.recordUsage(model.id, "chat", out.usage);
  const msg = out?.choices?.[0]?.message;
  const r1 = msg?.reasoning_content ?? msg?.reasoning; // 非流式的思考内容
  if (r1) yield { type: "reasoning", value: String(r1) };
  if (msg?.content) yield { type: "text", value: msg.content };
  if (msg?.tool_calls?.length) yield { type: "tool_calls", calls: normalizeCalls(msg.tool_calls) };
  if (!msg?.content && !msg?.tool_calls?.length) throw new LLMError(`模型没有返回内容（HTTP ${res.status}）`);
}

const COMPRESS_SYS =
  "你在压缩一段对话历史，输出供后续对话继续使用的摘要。" +
  "保留：用户的目标与偏好、已确认的事实与数据、做出的决定、已完成与未完成的事项、重要的工具操作结果。" +
  "丢弃：寒暄、重复表述、过程性废话。用简体中文分条列出，不添加原文没有的信息，也不要输出任何前言后语。";

const COMPRESS_TIMEOUT = 20000;

const TITLE_SYS =
  "你在给一段对话起标题，用户会给你这段对话的第一句话。" +
  "概括它要做什么，输出一行短标题：不超过 12 个字，用简体中文。" +
  "只输出标题本身，不要标点、引号、书名号，不要「关于」「总结」这类前缀，不要任何解释。";
const TITLE_TIMEOUT = 10000;

/**
 * 上下文压缩：把较早的一段对话精炼成摘要（一次非流式调用）。
 * @param {string} prevSummary 已有摘要，会并入新对话一起重写；无则传空串
 * @param {{role: string, content: string}[]} messages 需要压缩的旧消息
 * @returns {Promise<string>} 摘要正文
 */
export async function summarizeChat(prevSummary, messages, { signal } = {}) {
  const model = await store.activeModel();
  if (!model) throw new LLMError("还没配置模型，点右上角齿轮登记一个");
  if (!model.api_key) throw new LLMError(`「${model.name}」没有填写密钥`);

  let endpoint = model.base_url.replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";

  const transcript = messages
    .map((m) => `${m.role === "assistant" ? "助手" : "用户"}：${m.content}${m.images?.length ? "（附图）" : ""}`)
    .join("\n");
  const ask =
    (prevSummary ? `已有摘要：\n${prevSummary}\n\n需要并入的新对话：\n` : "需要压缩的对话：\n") + transcript;

  // 压缩是辅助步骤：自带超时，且跟随主请求的中断
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COMPRESS_TIMEOUT);
  const relay = () => ctrl.abort();
  signal?.addEventListener("abort", relay, { once: true });

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + model.api_key,
      },
      body: JSON.stringify({
        model: model.model,
        messages: [
          { role: "system", content: COMPRESS_SYS },
          { role: "user", content: ask },
        ],
        temperature: 0.3,
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    // 用户点了停止：原样抛出，交给上层按「已停止」处理
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    throw new LLMError(err?.name === "AbortError" ? "压缩超时" : "连不上模型服务");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }

  if (!res.ok) throw new LLMError(`压缩失败（HTTP ${res.status}）${await detailOf(res)}`);

  const out = await res.json().catch(() => null);
  if (out?.usage) void store.recordUsage(model.id, "summary", out.usage);
  if (out?.error) throw new LLMError("压缩失败：" + out.error.message);
  const text = out?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new LLMError("压缩没有返回内容");
  return text.trim();
}

/** 标题生成：一次极短的非流式调用，只要一行短标题，失败交给调用方兜底 */
export async function makeTitle(userText) {
  const model = await store.activeModel();
  if (!model) throw new LLMError("还没配置模型，点右上角齿轮登记一个");
  if (!model.api_key) throw new LLMError(`「${model.name}」没有填写密钥`);

  let endpoint = model.base_url.replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";

  // 起标题是辅助步骤：自带超时，别拖住会话列表
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + model.api_key,
      },
      body: JSON.stringify({
        model: model.model,
        messages: [
          { role: "system", content: TITLE_SYS },
          { role: "user", content: String(userText || "").slice(0, 500) },
        ],
        temperature: 0.3,
        max_tokens: 24,
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new LLMError(err?.name === "AbortError" ? "起标题超时" : "连不上模型服务");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new LLMError(`起标题失败（HTTP ${res.status}）${await detailOf(res)}`);

  const out = await res.json().catch(() => null);
  if (out?.usage) void store.recordUsage(model.id, "title", out.usage);
  if (out?.error) throw new LLMError("起标题失败：" + out.error.message);
  return cleanTitle(out?.choices?.[0]?.message?.content);
}

/** 模型偶尔会带上引号、书名号或句末标点，清一遍再落库 */
function cleanTitle(raw) {
  return String(raw || "")
    .replace(/[\s"'“”‘’《》〈〉【】\[\]()（）]/g, "")
    .replace(/[。．，,、！!?？:：;；~～\-—]/g, "")
    .slice(0, 16);
}

/** 从错误响应里尽量抠出可读信息 */
async function detailOf(res) {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const msg = JSON.parse(text)?.error?.message;
    if (msg) return "：" + msg;
  } catch {
    /* 不是 JSON，退回截断原文 */
  }
  return "：" + text.slice(0, 150);
}

const emptyCall = () => ({ id: "", name: "", arguments: "" });

/** 补齐成 {id, name, arguments} 结构 */
function normalizeCalls(list) {
  return list.map((c) => ({
    id: c.id || "",
    name: c.function?.name || "",
    arguments: c.function?.arguments || "",
  }));
}

/**
 * 逐行解析 SSE：正文取 choices[0].delta.content；
 * tool_calls 按 index 累积（同一轮里 arguments 会分多片到达）。
 */
async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const acc = new Map(); // index -> {id, name, arguments}
  let usage = null; // 末包 usage（stream_options 打开后网关在最后一个 chunk 带上，choices 为空）

  outer: while (true) {
    const { done, value } = await reader.read();
    // 流结束时补一个换行：有的网关最后一条事件不带换行符，按半截行丢掉的话整条内容都收不到
    buf += done ? "\n" : decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // 末行可能是半截，留到下一轮

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break outer;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // 心跳等非 JSON 行，跳过
      }
      const delta = json?.choices?.[0]?.delta;
      if (json.usage) usage = json.usage;
      if (!delta) continue;

      // 思考内容：DeepSeek/GLM 用 reasoning_content，OpenRouter 等用 reasoning；
      // 在正文之前到达，先吐给上层渲染思考块
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) yield { type: "reasoning", value: String(r) };
      if (delta.content) yield { type: "text", value: delta.content };

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const cur = acc.get(i) || emptyCall();
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          acc.set(i, cur);
        }
      }
    }

    if (done) break;
  }

  const calls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name);
  if (calls.length) yield { type: "tool_calls", calls };
  if (usage) yield { type: "usage", value: usage };
}

export { SYSTEM };
/* 轻量 Markdown 渲染器。
   安全策略：文本一律先做 HTML 转义，再套白名单标签，因此模型输出里的任何
   原始 HTML（含 <script>、onerror 等）都进不来，只会当作普通文字显示。
   支持：标题、围栏代码、引用、有序/无序列表（含缩进嵌套）、表格（含对齐）、
   分隔线，以及行内的代码、加粗、斜体、删除线、链接与裸链接。 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const LIST_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

/** 只放行安全协议；不放行的原样退回文字，避免 javascript: 之类混进 href */
function safeUrl(raw) {
  const u = String(raw || "").trim();
  return /^(https?:|mailto:)/i.test(u) ? u : "";
}

const linkTag = (href, text) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;

/** 行内渲染：输入原文，输出白名单标签 */
function inline(raw) {
  let s = escapeHtml(raw);

  // 行内代码先抽走，免得里面的 * _ 被后面的规则改写
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);

  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const href = safeUrl(url);
    return href ? linkTag(href, text) : m;
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  // 裸链接（排除链接自身生成的 href="..."，其前面是引号）
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>&]+)/g, (m, pre, url) => pre + linkTag(url, url));

  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
}

const splitRow = (s) => s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** 分隔行：至少含一个竖线，且只由 - | : 和空白组成 */
function isTableSep(s) {
  const t = s.trim();
  return t.includes("|") && /^\|?[\s:|-]+\|[\s:|-]*$/.test(t) && /-/.test(t);
}

const alignOf = (c) => {
  const t = c.trim();
  const l = t.startsWith(":");
  const r = t.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "";
};

const cellAttr = (a) => (a ? ` class="ta-${a}"` : "");

function tableHtml(head, aligns, body) {
  const th = head.map((c, k) => `<th${cellAttr(aligns[k])}>${inline(c)}</th>`).join("");
  const trs = body
    .map((r) => "<tr>" + head.map((_, k) => `<td${cellAttr(aligns[k])}>${inline(r[k] ?? "")}</td>`).join("") + "</tr>")
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** 该行是否是某个块的起点（表格要看下一行，故需要整份 lines） */
function isBlockStart(lines, i) {
  const line = lines[i];
  const t = line.trim();
  if (!t) return true;
  if (/^(```|~~~)/.test(t)) return true;
  if (/^([-*_])\s*(?:\1\s*){2,}$/.test(t)) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^>/.test(t)) return true;
  if (LIST_RE.test(line)) return true;
  if (t.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) return true;
  return false;
}

/** 收集一段列表；缩进更深的项挂到上一项内部，形成子列表 */
function buildList(lines, start, baseIndent) {
  const ordered = /^\s*\d+[.)]\s/.test(lines[start]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m) {
      const indent = lines[i].length - lines[i].trimStart().length;
      if (items.length && lines[i].trim() && indent > baseIndent) {
        items[items.length - 1].text += " " + lines[i].trim(); // 续行并进上一项
        i++;
        continue;
      }
      break;
    }

    const indent = m[1].replace(/\t/g, "  ").length;
    if (indent < baseIndent) break;

    if (indent > baseIndent) {
      if (!items.length) break;
      const sub = buildList(lines, i, indent);
      if (sub.next === i) break; // 兜底，避免不前进
      items[items.length - 1].children.push(sub.html);
      i = sub.next;
      continue;
    }

    if (!!m[3] !== ordered && items.length) break; // 换了列表类型，交给外层另起一段
    items.push({ text: m[4], children: [] });
    i++;
  }

  const tag = ordered ? "ol" : "ul";
  const html = `<${tag}>` + items.map((it) => `<li>${inline(it.text)}${it.children.join("")}</li>`).join("") + `</${tag}>`;
  return { html, next: i };
}

/**
 * 把 Markdown 文本渲染成安全的 HTML 字符串。
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // 围栏代码块（流式过程中可能还没闭合，此处会一直吃到结尾，正好收尾）
    const fence = trimmed.match(/^(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const closeRe = new RegExp("^\\s*" + marker + "\\s*$");
      const body = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // 分隔线
    if (/^([-*_])\s*(?:\1\s*){2,}$/.test(trimmed)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 引用
    if (/^>/.test(trimmed)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 表格
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(trimmed);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        body.push(splitRow(lines[i]));
        i++;
      }
      out.push(tableHtml(head, aligns, body));
      continue;
    }

    // 列表
    if (LIST_RE.test(line)) {
      const r = buildList(lines, i, line.length - line.trimStart().length);
      out.push(r.html);
      i = r.next;
      continue;
    }

    // 段落：一直吃到空行或下一个块的起点；单个换行按 <br> 处理，贴合聊天场景
    const buf = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }

  return out.join("");
}
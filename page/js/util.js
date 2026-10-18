/* 通用工具：选择器与轻提示 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 文件大小的人类可读写法：附件卡片、消息气泡共用 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) {
    const kb = v / 1024;
    return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + " KB";
  }
  return (v / 1024 / 1024).toFixed(1) + " MB";
}

let timer = null;

/** 成功图标（绿色圆环 + 对勾）：常量 SVG，供 toast 等轻提示复用 */
export const ICON_SUCCESS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.3 7.1 10.2 11 6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** 回形针：文件按钮、附件卡、消息里的文件卡共用 */
export const ICON_FILE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.8 7.2 7.5 11.5a2.6 2.6 0 0 1-3.7-3.7l4.9-4.9a1.7 1.7 0 1 1 2.4 2.4L6.3 10a.8.8 0 0 1-1.2-1.2l4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** 底部轻提示条，重复调用会重置计时；sticky 时不自动消失，需调用 hideToast 收起（适合悬停常驻）
    icon 传入常量 SVG 时在文字前显示一枚图标 */
export function toast(msg, { sticky = false, icon = "" } = {}) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = "";
  if (icon) {
    const ic = document.createElement("span");
    ic.className = "toast-ic";
    ic.innerHTML = icon; // 常量 SVG，非用户输入
    el.appendChild(ic);
  }
  const tx = document.createElement("span");
  tx.className = "toast-text";
  tx.textContent = String(msg ?? "");
  el.appendChild(tx);
  el.classList.toggle("with-ic", !!icon);
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("on"));
  clearTimeout(timer);
  if (sticky) return;
  timer = setTimeout(() => {
    el.classList.remove("on");
    setTimeout(() => {
      el.hidden = true;
    }, 200);
  }, 2200);
}

/** 立即收起轻提示条（悬停移出时用） */
export function hideToast() {
  const el = $("#toast");
  if (!el) return;
  clearTimeout(timer);
  el.classList.remove("on");
  setTimeout(() => {
    el.hidden = true;
  }, 200);
}
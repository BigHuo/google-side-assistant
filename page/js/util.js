/* 通用工具：选择器与轻提示 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let timer = null;

/** 成功图标（绿色圆环 + 对勾）：常量 SVG，供 toast 等轻提示复用 */
export const ICON_SUCCESS =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.3 7.1 10.2 11 6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
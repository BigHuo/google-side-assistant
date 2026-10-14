/* 框选 overlay：由 background 经 chrome.scripting 注入，一次性使用。
   拖出选区后不立即截图：选区与遮罩留在页面上，用户还能二次调整，
   再点工具条上的 ✓ 确认、✗ 或 Esc 取消。
   · 拖出矩形＝框选；原地单击（位移 <4px）＝选中整个视口（全屏），同样保留选区
   · 已有选区时，在选区内按下拖动＝移动选区；在选区外按下＝重新框选
   上报格式：rect=矩形 + full=false 为框选；rect=null + full=true 为全屏；
   rect=null（无 full）为取消。样式全部内联，避免被目标页 CSS 影响。 */
(() => {
  if (window.__saShotActive) return; // 重复注入只保留一份
  window.__saShotActive = true;

  const dpr = window.devicePixelRatio || 1;
  const Z = 2147483647; // 顶格 z-index
  const rnd = (v) => Math.round(v);

  const veil = document.createElement("div");
  veil.style.cssText = `position:fixed;inset:0;z-index:${Z};cursor:crosshair;`;

  // 选框：阴影外扩压暗四周，选区内部保持原色
  const box = document.createElement("div");
  box.style.cssText =
    `position:fixed;display:none;z-index:${Z};border:1.5px solid #3b82f6;` +
    `background:rgba(59,130,246,.10);box-shadow:0 0 0 9999px rgba(0,0,0,.28);pointer-events:none;`;

  // 选区尺寸标签
  const size = document.createElement("div");
  size.style.cssText =
    `position:fixed;display:none;z-index:${Z};padding:2px 6px;border-radius:4px;white-space:nowrap;` +
    `background:rgba(59,130,246,.92);color:#fff;font:11px/1.4 system-ui,sans-serif;pointer-events:none;`;

  const hint = document.createElement("div");
  hint.textContent = "拖动框选区域，单击截取全屏；Esc 取消";
  hint.style.cssText =
    `position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:${Z};` +
    `padding:6px 12px;border-radius:999px;background:rgba(17,24,39,.85);color:#fff;` +
    `font:12px/1.4 system-ui,sans-serif;pointer-events:none;`;

  const svg = (d) =>
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" ` +
    `stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

  const mkBtn = (title, bg, path) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.style.cssText =
      `all:unset;box-sizing:border-box;width:30px;height:30px;border-radius:50%;cursor:pointer;` +
      `display:flex;align-items:center;justify-content:center;background:${bg};` +
      `box-shadow:0 2px 8px rgba(0,0,0,.35);`;
    b.innerHTML = svg(path);
    return b;
  };
  const btnCancel = mkBtn("取消（Esc）", "#374151", "M18 6L6 18M6 6l12 12"); // 叉叉
  const btnOk = mkBtn("确认截图", "#2563eb", "M20 6L9 17l-5-5"); // 勾勾

  const bar = document.createElement("div");
  bar.style.cssText = `position:fixed;display:none;z-index:${Z};gap:8px;pointer-events:auto;`;
  bar.append(btnCancel, btnOk);

  const parts = [veil, box, size, bar, hint];

  const cleanup = () => {
    for (const el of parts) el.remove();
    removeEventListener("keydown", onKey, true);
  };

  const report = (rect, full = false) => {
    window.__saShotActive = false;
    cleanup();
    // 两帧 paint 确保遮罩与工具条从合成层消失，background 再截图就不会把它们截进去
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        chrome.runtime
          .sendMessage({ type: "SHOT_RECT", rect, dpr, full })
          .catch((e) => console.warn("[side-assistant] 截图结果上报失败：", e));
      }),
    );
  };

  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    report(null); // 取消
  };

  let rect = null; // 当前选区（CSS 像素）
  let mode = null; // "draw" | "move"
  let x0 = 0,
    y0 = 0; // 按下点
  let base = null; // 移动前的选区

  const fullView = () => ({ x: 0, y: 0, w: innerWidth, h: innerHeight });
  const coversView = (r) => r.x <= 0.5 && r.y <= 0.5 && r.w >= innerWidth - 1 && r.h >= innerHeight - 1;
  const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  const paint = () => {
    if (!rect) {
      box.style.display = size.style.display = bar.style.display = "none";
      return;
    }
    Object.assign(box.style, {
      display: "block",
      left: rect.x + "px",
      top: rect.y + "px",
      width: rect.w + "px",
      height: rect.h + "px",
    });
    hint.style.display = "none"; // 已有选区：顶部说明让位给尺寸与工具条

    size.style.display = "block";
    size.textContent = `${rnd(rect.w)} × ${rnd(rect.h)}`;
    size.style.left = rect.x + "px";
    size.style.top = (rect.y > 22 ? rect.y - 20 : rect.y + 4) + "px";

    // 工具条：默认贴选区右下角外侧；下方越界翻到上方，上方也放不下就贴框内底部
    bar.style.display = "flex";
    const bw = bar.offsetWidth || 68;
    const bh = bar.offsetHeight || 30;
    const m = 8;
    let bx = rect.x + rect.w - bw;
    let by = rect.y + rect.h + m;
    if (by + bh > innerHeight - 4) by = rect.y - bh - m;
    if (by < 4) by = rect.y + rect.h - bh - m;
    bar.style.left = Math.min(Math.max(bx, 4), Math.max(4, innerWidth - bw - 4)) + "px";
    bar.style.top = Math.min(Math.max(by, 4), Math.max(4, innerHeight - bh - 4)) + "px";
  };

  veil.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      veil.setPointerCapture(e.pointerId);
    } catch {
      /* 个别浏览器不支持，忽略即可 */
    }
    x0 = e.clientX;
    y0 = e.clientY;
    // 已有选区且按在选区内（铺满视口的全屏框除外）→ 移动；否则重新框选
    if (rect && !coversView(rect) && inRect(x0, y0, rect)) {
      mode = "move";
      base = { ...rect };
      veil.style.cursor = "move";
    } else {
      mode = "draw";
      base = null;
      rect = { x: x0, y: y0, w: 0, h: 0 };
      paint();
    }
  });

  veil.addEventListener("pointermove", (e) => {
    if (!mode) return;
    if (mode === "draw") {
      rect = {
        x: Math.min(x0, e.clientX),
        y: Math.min(y0, e.clientY),
        w: Math.abs(e.clientX - x0),
        h: Math.abs(e.clientY - y0),
      };
    } else {
      rect = {
        x: Math.min(Math.max(base.x + e.clientX - x0, 0), innerWidth - base.w),
        y: Math.min(Math.max(base.y + e.clientY - y0, 0), innerHeight - base.h),
        w: base.w,
        h: base.h,
      };
    }
    paint();
  });

  const endDrag = () => {
    if (!mode) return;
    if (mode === "draw" && (rect.w < 4 || rect.h < 4)) rect = fullView(); // 没怎么拖＝单击：全屏
    mode = null;
    base = null;
    veil.style.cursor = "crosshair";
    paint(); // 保留选区，等用户点 ✓ / ✗
  };
  veil.addEventListener("pointerup", (e) => {
    e.preventDefault();
    endDrag();
  });
  veil.addEventListener("pointercancel", endDrag);

  // 按钮悬停时的按下不要落到 veil 上，否则会被当成重新框选
  for (const b of [btnCancel, btnOk]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    report(null);
  });
  btnOk.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!rect) return;
    const full = coversView(rect);
    report(full ? null : { x: rnd(rect.x), y: rnd(rect.y), w: rnd(rect.w), h: rnd(rect.h) }, full);
  });

  addEventListener("keydown", onKey, true);
  (document.body || document.documentElement).append(...parts);
})();

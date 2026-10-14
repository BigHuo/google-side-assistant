/* 品牌商标：三处品牌位共用同一个等轴测立方体。
   空状态大图标（data-live）走 WebGPU 动态版（见 brand-cube.js）：真实环境反射的
   银器质感，跟随光标小幅转动；顶栏 18px 与状态行 16px 走 canvas 2D 静态版，
   一次画完、不进动画循环，极小尺寸也清晰。
   两者对外轮廓与配色一致（同一个商标），只是精度不同。 */

import { mountBrandCube } from "./brand-cube.js";

/* ---------- 静态版：等轴测立方体 ---------- */
// 单位空间（-1~1）里的外轮廓六边形：顶 / 右上 / 右下 / 底 / 左下 / 左上
const HULL = [
  [0, -1], [0.866, -0.5], [0.866, 0.5], [0, 1], [-0.866, 0.5], [-0.866, -0.5],
];

const lin = (ctx, coords, stops) => {
  const g = ctx.createLinearGradient(...coords);
  for (const [p, c] of stops) g.addColorStop(p, c);
  return g;
};

/** 把静态商标画在画布中心，占满 size×size */
function drawMark(ctx, size) {
  const R = size / 2;
  const k = R * 0.82; // 缩放：与 WebGPU 版在大图标里的留白大致对齐
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(R, R);
  ctx.scale(k, k);
  ctx.lineJoin = "round";

  const face = (pts, fill) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  // 顶面：最亮
  face([HULL[0], HULL[1], [0, 0], HULL[5]],
    lin(ctx, [0, -1, 0, 0], [[0, "#f6f4ee"], [1, "#cbc8c0"]]));
  // 右面：中段一条亮带（环形光幕的反射），两端压暗
  face([HULL[1], HULL[2], HULL[3], [0, 0]],
    lin(ctx, [0.866, -0.5, 0.866, 0.5], [
      [0, "#b7b4ac"], [0.42, "#eceadf"], [1, "#8b8881"],
    ]));
  // 左面：整体偏暗，亮带弱一些
  face([HULL[5], [0, 0], HULL[3], HULL[4]],
    lin(ctx, [-0.866, -0.5, -0.866, 0.5], [
      [0, "#9a978f"], [0.42, "#d9d6cd"], [1, "#6f6c66"],
    ]));

  // 三条内棱：分开三个面，压一点暗
  ctx.lineWidth = 0.5 / k;
  ctx.strokeStyle = "rgba(58, 56, 52, .42)";
  ctx.beginPath();
  ctx.moveTo(HULL[1][0], HULL[1][1]); ctx.lineTo(0, 0);
  ctx.moveTo(HULL[5][0], HULL[5][1]); ctx.lineTo(0, 0);
  ctx.moveTo(0, 0); ctx.lineTo(HULL[3][0], HULL[3][1]);
  ctx.stroke();

  // 外轮廓：小尺寸下靠它保住形体
  ctx.beginPath();
  ctx.moveTo(HULL[0][0], HULL[0][1]);
  for (let i = 1; i < HULL.length; i++) ctx.lineTo(HULL[i][0], HULL[i][1]);
  ctx.closePath();
  ctx.lineWidth = 0.6 / k;
  ctx.stroke();

  ctx.restore();
}

/** 把静态商标画进一块画布（按 DPR 放大，保证清晰） */
function paintStatic(canvas, size, dpr) {
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMark(ctx, size);
}

export async function initBrand() {
  const list = [...document.querySelectorAll("canvas[data-orb]")];
  if (!list.length) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const staticList = [];
  let hero = null;

  for (const canvas of list) {
    const size = Number(canvas.dataset.orb) || 56;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    if (canvas.hasAttribute("data-live")) hero = { canvas, size, aim: [0, 0] };
    else staticList.push({ canvas, size });
  }

  // 静态位：一次画完，不进 rAF
  for (const it of staticList) paintStatic(it.canvas, it.size, dpr);

  if (!hero) return;

  let live = false;
  if (navigator.gpu) {
    try {
      await mountBrandCube(hero.canvas, () => hero.aim);
      live = true;
    } catch (err) {
      console.warn("[side-assistant] 商标 3D 渲染不可用，回退静态版：", err);
    }
  }
  if (!live) {
    // 若 WebGPU 已经抢走过这块画布，2d 上下文就拿不到了，换一块干净的再画
    let canvas = hero.canvas;
    if (!canvas.getContext("2d")) {
      canvas = canvas.cloneNode(false);
      hero.canvas.replaceWith(canvas);
    }
    paintStatic(canvas, hero.size, dpr);
    return;
  }

  // 光标方向：与旧版一致，3 个图标半径外就到头；缓动在渲染侧做
  let mx = null;
  let my = null;
  let raf = 0;
  const aim = () => {
    const r = hero.canvas.getBoundingClientRect();
    if (mx == null || !r.width) return;
    const dx = mx - (r.left + r.width / 2);
    const dy = my - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(d, r.width * 3) / (r.width * 3);
    hero.aim = [(dx / d) * k, (dy / d) * k];
  };
  document.addEventListener("mousemove", (e) => {
    mx = e.clientX;
    my = e.clientY;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; aim(); });
  });
  window.addEventListener("scroll", aim, true); // 面板滚动时图标位置会变
  window.addEventListener("resize", aim);
}

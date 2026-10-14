/* 品牌商标 · 动态版：等轴测银色立方体（WebGPU）。
 *
 * 渲染来自 glass-prism：金属没有漫反射，颜色几乎全部来自程序化影棚的环形光幕
 * 反射 + 菲涅尔。这里只改一件事 —— 出屏时不再合成浅灰影棚底，直接把场景的
 * alpha 交给画布（vgpu 的 surface 默认 alphaMode=premultiplied），立方体就能
 * 坐在深色侧边栏上而不带一块灰底。
 *
 * 跟随光标做小幅转动（带阻尼）。任何一步失败都抛错，由 orb.js 回退到静态版。 */

import {
  init, surface, effect, sampler, target, frameLoop, frame,
  draw, geometry, box, perspectiveCamera,
} from "../vendor/vgpu.bundle.js";

// 相机仰角固定 35.26°（等轴测条件），由此推出可见面反射方向的仰角：
// 侧面 ≈ -0.61，顶面 ≈ +0.58。环形光幕就摆在两个中心上。
// 改相机参数时必须同步这两个值，否则光幕会滑出反射范围、侧面变死灰。
const REFL_SIDE_Y = -0.61;
const REFL_TOP_Y = 0.58;

const ENV_WGSL = /* wgsl */ `
// 程序化影棚环境。金属没有漫反射，表面颜色几乎全部来自这里的环境反射。
//
// 关键：模型绕 Y 旋转只改变反射的「方位角」，反射的「仰角」基本不变。
// 所以灯必须横铺成一整圈（环形光幕），才能在任意转角都留下亮带。
fn envColor(dIn: vec3f) -> vec3f {
  let d = normalize(dIn);

  // 底色：影棚天花板与地面都偏暗，照明靠两条环形光带。
  let sky = mix(vec3f(0.25, 0.25, 0.265), vec3f(0.50, 0.505, 0.515),
                smoothstep(-0.85, 0.85, d.y));
  var c = sky * mix(0.55, 1.0, smoothstep(-0.95, -0.05, d.y));

  // 双层环形光幕：窄芯给出金属亮带（边缘要够硬），宽底只做很轻的过渡。
  let sideBand = 0.65 * smoothstep(0.055, 0.0, abs(d.y - (${REFL_SIDE_Y})))
               + 0.06 * smoothstep(0.16, 0.0, abs(d.y - (${REFL_SIDE_Y})));
  let topBand = 0.38 * smoothstep(0.070, 0.0, abs(d.y - (${REFL_TOP_Y})))
              + 0.05 * smoothstep(0.20, 0.0, abs(d.y - (${REFL_TOP_Y})));
  c += vec3f(1.0, 0.99, 0.96) * sideBand;
  c += vec3f(1.0, 0.99, 0.96) * topBand;

  // 方位上的少许起伏，避免看起来像一根均匀的圆柱
  c += vec3f(1.0, 0.99, 0.96) * 0.05 * pow(max(dot(d, normalize(vec3f(0.75, ${REFL_SIDE_Y}, -0.27))), 0.0), 16.0);
  c += vec3f(0.90, 0.94, 1.0) * 0.04 * pow(max(dot(d, normalize(vec3f(-0.78, ${REFL_SIDE_Y}, 0.14))), 0.0), 16.0);
  return c;
}

// 按粗糙度做少量方向的平均，模拟模糊反射
fn envBlur(d: vec3f, rough: f32) -> vec3f {
  let s = rough * 0.30;
  var acc = envColor(d) * 2.0;
  acc += envColor(d + vec3f(s, s * 0.5, 0.0));
  acc += envColor(d - vec3f(s, s * 0.5, 0.0));
  acc += envColor(d + vec3f(0.0, s, s));
  acc += envColor(d - vec3f(0.0, s, s));
  return acc / 6.0;
}
`;

const OBJECT_SHADER = /* wgsl */ `
struct Camera { viewProjection: mat4x4f, position: vec3f }
struct Model { model: mat4x4f }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
}

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  let world = model.model * vec4f(position, 1.0);
  out.position = camera.viewProjection * world;
  out.normal = (model.model * vec4f(normal, 0.0)).xyz;
  out.worldPos = world.xyz;
  return out;
}
${ENV_WGSL}
@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let v = normalize(camera.position - in.worldPos);
  let ndv = clamp(dot(n, v), 0.0, 1.0);

  // 银：F0 接近中性高反射；掠射角由菲涅尔提亮（金属边缘发白的来源）
  let f0 = vec3f(0.955, 0.955, 0.965);
  let fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);

  let r = reflect(-v, n);
  // 粗糙度要小：envBlur 的采样跨度必须小于亮带半宽，否则模糊会把亮带稀释掉
  var col = envBlur(r, 0.07) * fres;

  // 朝下的面稍暗，压住底部
  col *= mix(0.86, 1.0, smoothstep(-0.65, 0.45, n.y));

  // 棱线：法线在像素间跳变处轻微压暗，保住 12 条棱的可读性
  let edge = smoothstep(0.04, 0.30, length(fwidth(in.normal)));
  col *= 1.0 - 0.32 * edge;

  return vec4f(col, 1.0);
}
`;

// 与预览不同：不合成影棚底，直接把场景纹理（含 alpha）交给画布。
// 场景清屏色是 [0,0,0,0]，立方体处 alpha 为 1，所以 premultiplied 下就是透明底。
const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(scene, samp, uv, 0.0);
}
`;

// ---------------------------------------------------------------------------
// 列主序 mat4 工具
// ---------------------------------------------------------------------------
const rotX = (b) => {
  const c = Math.cos(b), s = Math.sin(b);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
};
const rotY = (a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
};
const mul = (A, B) => {
  const C = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += A[k * 4 + row] * B[col * 4 + k];
      C[col * 4 + row] = sum;
    }
  }
  return C;
};

// 偏航基准 -30° 让两个可见侧面与相机方位（15°）各差 45°，左右宽度对称；
// 仰角 35.26°（等轴测）保证屏幕上的棱长比相等，面不会被拉成长方形。
// 光标只做小幅偏转，商标要稳，别晃。
const BASE_YAW = -0.5236; // -30°
const modelMatrix = (mx, my) =>
  mul(rotY(BASE_YAW + mx * 0.22), rotX(my * 0.13));

/**
 * 在 canvas 上挂一颗 WebGPU 立方体。
 * @param {HTMLCanvasElement} canvas 目标画布（CSS 尺寸即图标尺寸）
 * @param {() => [number, number]} getAim 每帧取一次光标方向（-1~1）
 */
export async function mountBrandCube(canvas, getAim) {
  if (!navigator.gpu) throw new Error("WebGPU 不可用");

  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  // 画布尺寸是固定的（图标不会变），所以直接给死，不开 autoResize ——
  // 空状态被隐藏时 clientWidth 会变 0，自动缩放会把目标缩成 0 导致报错。
  const px = Math.round(Number(canvas.dataset.orb || 88) * dpr);

  const gpu = await init();
  gpu.onError((e) => console.error("[vgpu]", e.detail ?? e));

  const cvs = surface(gpu, canvas, { size: [px, px] });
  const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

  // 相机按等轴测条件摆：仰角 35.26°、方位 15°（与模型基准偏航配合成 45°）；
  // 长焦段（fov 22）压低透视变形，正方形画布下 aspect 固定为 1。
  const camera = perspectiveCamera({
    fov: 22, aspect: 1, position: [1.61, 4.39, 5.99], target: [0, 0, 0],
  });

  // 3D 需要深度缓冲，而 surface 没有：先渲染到离屏 target，再合成到画布
  const scene = target(gpu, { size: [px, px], depth: true, msaa: 4 });

  const cube = draw(gpu, {
    shader: OBJECT_SHADER,
    geometry: geometry(gpu, box({ size: 1.4 })),
    cull: "back",
  });
  cube.set({
    camera: {
      viewProjection: camera.viewProjection,
      position: [camera.worldPosition[0], camera.worldPosition[1], camera.worldPosition[2]],
    },
    model: { model: modelMatrix(0, 0) },
  });

  const present = effect(gpu, PRESENT_SHADER, { set: { scene, samp: linear } });

  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };

  const step = (f) => {
    // 空状态被隐藏（display:none）时画布宽度为 0，此时提交渲染既没意义、
    // 也可能让 surface 拿到 0 尺寸的纹理；直接跳过，重新显示后自动恢复。
    if (!canvas.clientWidth) return;

    const aim = getAim?.() ?? [0, 0];
    ptr.tx = Math.max(-1, Math.min(1, aim[0] || 0));
    ptr.ty = Math.max(-1, Math.min(1, aim[1] || 0));
    ptr.x += (ptr.tx - ptr.x) * 0.055;
    ptr.y += (ptr.ty - ptr.y) * 0.055;
    cube.set({ model: { model: modelMatrix(ptr.x, ptr.y) } });

    f.pass({ target: scene, clear: [0, 0, 0, 0], clearDepth: 1 }, (pass) => pass.draw(cube));
    f.pass(cvs, present);
  };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    frame(gpu, step); // 静止一帧，不跑动画
  } else {
    frameLoop(gpu, step);
  }
}

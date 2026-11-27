// 证件照生成（GitHub Pages 版）
// 流程：拍照 / 相册 → MediaPipe 人像分割抠图 → 人脸关键点自动对齐（眼睛摆平 + 定位 + 定大小）
//      → 手动修边（擦除 / 恢复）→ 底色 / 规格 / 服装层（内置贴片或上传的衣服照片）→ 导出
// 全部在本页完成，照片不上传。
import { FilesetResolver, ImageSegmenter, FaceDetector } from './vendor/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nextFrame = () => new Promise(r => requestAnimationFrame(r));

/* ---------- 常量 ---------- */

const SIZES = [
  { id: '1in', label: '一寸 25×35mm', w: 295, h: 413, mm: [25, 35] },
  { id: '2s', label: '小二寸 33×48mm', w: 390, h: 567, mm: [33, 48] },
  { id: '2in', label: '二寸 35×49mm', w: 413, h: 579, mm: [35, 49] },
];

const BGS = [
  { id: 'white', label: '白底', css: '#ffffff' },
  { id: 'blue', label: '蓝底', css: '#438edb' },
  { id: 'gblue', label: '渐变蓝', css: ['#66abe8', '#2e6fc4'], grad: true },
  { id: 'red', label: '红底', css: '#bf2a2a' },
  { id: 'gray', label: '浅灰', css: '#e9ebee' },
];

// 内置服装贴片：assets/ 下预抠好的透明 webp。
// anchor = 贴片内「肩线」高度占贴片高的比例；stretchFrom = 该比例以上保比例、以下拉伸补高
// fill = V 领开口的补色（西装领口是开的，用衬衫色补底，不再依赖人自己穿什么）
const OUTFITS = [
  { id: 'suit', gender: 'm', label: '西装', variants: [
    { label: '藏蓝', file: 'suit_m_navy.webp', anchor: 0.03, stretchFrom: 0.58, fill: '#f6f6f6' },
    { label: '深灰', file: 'suit_m_gray.webp', anchor: 0.06, stretchFrom: 0.55, fill: '#f6f6f6' },
  ] },
  { id: 'shirt', gender: 'm', label: '衬衫', variants: [
    { label: '浅蓝', file: 'shirt_m_blue.webp', anchor: 0.05, stretchFrom: 0.55 },
  ] },
  { id: 'polo', gender: 'm', label: '短袖', variants: [
    { label: '白', file: 'polo_m_white.webp', anchor: 0.09, stretchFrom: 0.55 },
  ] },
  { id: 'sweater', gender: 'm', label: '毛衣', variants: [
    { label: '深灰', file: 'sweater_m_gray.webp', anchor: 0.02, stretchFrom: 0.5 },
  ] },
  { id: 'suit-f', gender: 'f', label: '西装', variants: [
    { label: '藏蓝', file: 'suit_f_navy.webp', anchor: 0.06, stretchFrom: 0.55, fill: '#f6f6f6' },
    { label: '酒红', file: 'suit_f_wine.webp', anchor: 0.08, stretchFrom: 0.55, fill: '#f6f6f6' },
  ] },
  { id: 'shirt-f', gender: 'f', label: '衬衫', variants: [
    { label: '白', file: 'shirt_f_white.webp', anchor: 0.05, stretchFrom: 0.55 },
  ] },
  { id: 'polo-f', gender: 'f', label: '短袖', variants: [
    { label: '白', file: 'polo_f_white.webp', anchor: 0.08, stretchFrom: 0.55 },
  ] },
  { id: 'sweater-f', gender: 'f', label: '毛衣', variants: [
    { label: '酒红', file: 'sweater_f_wine.webp', anchor: 0.02, stretchFrom: 0.5 },
  ] },
];
const NONE_OUTFIT = { id: 'none', label: '不换装' };
const CUSTOM_OUTFIT = { id: 'custom', label: '上传衣服' };

// 证件照模板：双眼连线中点放在高度的 EYE_Y 处，瞳距放大到宽度的 IPD 倍
const EYE_Y = 0.40;
const IPD = 0.245;
const MAX_ROLL = 25 * Math.PI / 180; // 自动摆正头部的最大角度
const MAX_EDGE = 1600;               // 处理用照片的最长边
const STORE_KEY = 'toolboxIdPhotoState';

/* ---------- 状态 ---------- */

const DEFAULT_PREFS = {
  gender: 'm', outfit: 'none', variantIdx: 0, size: '1in', bg: 'blue',
  shoulder: 0, outfitW: 115,        // 肩线相对自动位置的偏移（%）/ 内置服装宽度（%）
  clothCutout: true, clothTol: 24,  // 上传的衣服照片：自动抠底 + 容差
  brush: 3.5,                       // 修边笔刷大小（占照片长边的 %）
  cut: true,                        // 内置服装：领口以下截掉人像躯干（长发勿裁则关闭）
};
const prefs = { ...DEFAULT_PREFS };

let zoom = 1, dx = 0, dy = 0, rot = 0;   // 人像层微调（rot 是在自动摆正之上的额外角度）
let photoCanvas = null;                   // 原图（降采样 + EXIF 转正，可能已绕眼位旋转摆正）
let maskedCanvas = null;                  // 抠掉背景后的图（分割失败时 = photoCanvas）
let auto = null;                          // 自动对齐参数 {scale, ex, ey, mouthX, mouthY}（原图坐标系）
let activeLayer = 'person';               // 预览手势作用对象：'person' | 'cloth' | 'erase' | 'restore'

// 上传的衣服照片层：盖在人像上，可拖动 / 双指缩放旋转
const cloth = { img: null, cutCanvas: null, hasAlpha: false, scale: 1, rot: 0, dx: 0, dy: 0 };

let facing = 'user';
let stream = null;
let segmenter = null, faceDetector = null, modelPromise = null;

const outfitsFor = (g) => OUTFITS.filter(o => o.gender === g);
const currentOutfit = () =>
  prefs.outfit === 'none' || prefs.outfit === 'custom' ? null : outfitsFor(prefs.gender).find(o => o.id === prefs.outfit) || null;
const currentVariant = () => {
  const o = currentOutfit();
  return o ? o.variants[Math.min(prefs.variantIdx, o.variants.length - 1)] : null;
};
const isBrush = () => activeLayer === 'erase' || activeLayer === 'restore';

/* ---------- 小工具 ---------- */

function show(msg, cls) {
  const s = $('status');
  s.textContent = msg;
  s.className = 'ed-status ' + (cls || '');
  const h = $('homeStatus'); // 编辑器不可见时（如示例加载失败）同步到首页状态行
  if (h) { h.textContent = msg; h.className = 'status ' + (cls || ''); }
}

function showView(name) {
  for (const sec of document.querySelectorAll('.view')) {
    sec.hidden = sec.id !== 'view' + name;
  }
  window.scrollTo(0, 0);
}

function busy(on, msg) {
  $('busy').classList.toggle('on', !!on);
  if (msg) $('busyMsg').textContent = msg;
}

let saveTimer = null;
function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) { /* 私密模式忽略 */ }
  }, 300);
}

function flash(btn, text) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = btn.dataset.label; }, 1200);
}

/* ---------- 照片载入（降采样 + EXIF 转正） ---------- */

async function loadPhotoCanvas(source) {
  const bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  photoCanvas = c;
}

/* ---------- 模型：人像分割 + 人脸检测（vendor 内置，懒加载一次） ---------- */

const SEG_MODEL = './vendor/selfie_segmenter.tflite';
const FACE_MODEL = './vendor/blaze_face_short_range.tflite';

async function fetchBuf(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} 加载失败（HTTP ${r.status}）`);
  return new Uint8Array(await r.arrayBuffer());
}

function ensureModels() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks('./vendor');
      const [segBuf, faceBuf] = await Promise.all([fetchBuf(SEG_MODEL), fetchBuf(FACE_MODEL)]);
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: segBuf },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
      });
      faceDetector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: faceBuf },
        runningMode: 'IMAGE',
        minFaceDetectionConfidence: 0.35,
      });
    })();
    modelPromise.catch(() => { modelPromise = null; }); // 失败后允许重试
  }
  return modelPromise;
}

/* ---------- 人像分割 → alpha 蒙版 ---------- */

async function applySegmentation() {
  const res = segmenter.segment(photoCanvas);
  try {
    const mask = res.confidenceMasks && res.confidenceMasks[0];
    if (!mask) throw new Error('分割结果为空');
    const mw = mask.width, mh = mask.height;
    const conf = mask.getAsFloat32Array();
    const sc = document.createElement('canvas');
    sc.width = mw; sc.height = mh;
    const sctx = sc.getContext('2d');
    const img = sctx.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) {
      // smoothstep(0.42→0.62)：置信度 ≥0.62 完全实心、≤0.42 全透明，中间窄带过渡
      let t = (conf[i] - 0.42) / (0.62 - 0.42);
      t = Math.min(1, Math.max(0, t));
      img.data[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
    }
    // 去孤立噪点：蒙版只有 256×256，几个像素的孤岛放大后就是脸上的一颗黑点
    const bin = new Uint8Array(mw * mh), seen = new Uint8Array(mw * mh);
    for (let i = 0; i < bin.length; i++) bin[i] = img.data[i * 4 + 3] >= 40 ? 1 : 0;
    for (let i = 0; i < bin.length; i++) {
      if (!bin[i] || seen[i]) continue;
      const island = [], stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop(), x = p % mw, y = (p / mw) | 0;
        island.push(p);
        if (x > 0 && bin[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < mw - 1 && bin[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && bin[p - mw] && !seen[p - mw]) { seen[p - mw] = 1; stack.push(p - mw); }
        if (y < mh - 1 && bin[p + mw] && !seen[p + mw]) { seen[p + mw] = 1; stack.push(p + mw); }
      }
      if (island.length <= 4) for (const p of island) img.data[p * 4 + 3] = 0;
    }
    sctx.putImageData(img, 0, 0);
    // 用蒙版 alpha 裁剪原图（小蒙版平滑放大到全尺寸，发丝边缘不发硬）
    const out = document.createElement('canvas');
    out.width = photoCanvas.width;
    out.height = photoCanvas.height;
    const mctx = out.getContext('2d');
    mctx.drawImage(photoCanvas, 0, 0);
    mctx.globalCompositeOperation = 'destination-in';
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(sc, 0, 0, out.width, out.height);
    maskedCanvas = out;
  } finally {
    res.close && res.close();
  }
}

/* ---------- 人脸检测 → 自动对齐参数 ---------- */

function detectFace() {
  const phW = photoCanvas.width, phH = photoCanvas.height;
  let best = null, bestScore = 0;
  try {
    const res = faceDetector.detect(photoCanvas);
    for (const d of res.detections || []) {
      const score = d.categories && d.categories[0] ? d.categories[0].score : 0;
      if (score > bestScore && d.keypoints && d.keypoints.length >= 2) { best = d; bestScore = score; }
    }
  } catch (e) { /* 检测失败走居中兜底 */ }

  if (best) {
    const [k0, k1] = best.keypoints;
    // keypoints 是归一化坐标；眼睛基本水平，x 按宽、y 按高还原成像素
    const dist = Math.hypot((k1.x - k0.x) * phW, (k1.y - k0.y) * phH);
    if (dist >= 8) {
      auto = {
        scale: (SIZES[0].w * IPD) / dist, // 以一寸宽度为基准，切换尺寸时按比例同样适用
        ex: ((k0.x + k1.x) / 2) * phW,
        ey: ((k0.y + k1.y) / 2) * phH,
        roll: clamp(Math.atan2((k1.y - k0.y) * phH, (k1.x - k0.x) * phW), -MAX_ROLL, MAX_ROLL),
        mouthX: null, mouthY: null,
      };
      const km = best.keypoints[3]; // 嘴中心（关键点序：双眼 / 鼻尖 / 嘴 / 双耳），用于推算服装位置
      if (km) { auto.mouthX = km.x * phW; auto.mouthY = km.y * phH; }
      return true;
    }
  }
  // 兜底：按「cover 铺满 + 眼睛猜在 40% 高度」居中放置
  auto = {
    scale: Math.max(phW ? SIZES[0].w / phW : 1, SIZES[0].h / phH),
    ex: phW / 2, ey: phH * 0.40, roll: 0, mouthX: null, mouthY: null,
  };
  return false;
}

// 把照片绕中心旋转，使双眼连线水平（歪头的自拍也能出端正的证件照）。
// 直接烘焙进画布而不是绘制时旋转：不会露出照片边角，后续修边坐标也更简单。
function levelPhoto() {
  const roll = auto.roll;
  if (Math.abs(roll) < 0.5 * Math.PI / 180) return;
  const W = photoCanvas.width, H = photoCanvas.height;
  const c = Math.cos(roll), s = Math.sin(roll);
  const NW = Math.ceil(Math.abs(W * c) + Math.abs(H * s));
  const NH = Math.ceil(Math.abs(W * s) + Math.abs(H * c));
  const spin = (src) => {
    const cv = document.createElement('canvas');
    cv.width = NW; cv.height = NH;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.save(); // 画完必须还原：这个画布之后还要被修边笔刷直接写入，不能留着旋转矩阵
    ctx.translate(NW / 2, NH / 2);
    ctx.rotate(-roll);
    ctx.drawImage(src, -W / 2, -H / 2);
    ctx.restore();
    return cv;
  };
  photoCanvas = spin(photoCanvas);
  maskedCanvas = spin(maskedCanvas);

  // 关键点坐标跟着旋转（绕原图中心）
  const ex0 = auto.ex, ey0 = auto.ey, mx0 = auto.mouthX, my0 = auto.mouthY;
  const mapX = (x, y) => (x - W / 2) * c + (y - H / 2) * s + NW / 2;
  const mapY = (x, y) => -(x - W / 2) * s + (y - H / 2) * c + NH / 2;
  auto.ex = mapX(ex0, ey0);
  auto.ey = mapY(ex0, ey0);
  if (mx0 != null) { auto.mouthX = mapX(mx0, my0); auto.mouthY = mapY(mx0, my0); }
  auto.roll = 0;
}

/* ---------- 人像 → 输出坐标：颈部锚点与肩线 ---------- */

// 「颈根」锚点 = 嘴中心在输出图上的位置（跟随拖动 / 缩放 / 旋转）。
// 服装层以它为基准摆放，所以无论怎么调整人像，衣服都跟着头部走。
function neckPoint(W, H) {
  const s = auto.scale * zoom, a = rot * Math.PI / 180;
  let vx = 0, vy = 1.1 * IPD * W * zoom; // 无嘴关键点：按眼-嘴经验距离
  if (auto.mouthX != null) { vx = (auto.mouthX - auto.ex) * s; vy = (auto.mouthY - auto.ey) * s; }
  return {
    x: W / 2 + dx + vx * Math.cos(a) - vy * Math.sin(a),
    y: EYE_Y * H + dy + vx * Math.sin(a) + vy * Math.cos(a),
  };
}

// 内置服装的肩线：嘴下约 0.85 个瞳距（≈ 下巴 + 颈根），再加用户微调
function autoShoulderY(W, H) {
  const n = neckPoint(W, H);
  return clamp(n.y + 0.85 * IPD * W * zoom + prefs.shoulder / 100 * H, H * 0.45, H * 0.9);
}

// 输出坐标 → 原图像素坐标（修边时把笔画落回蒙版）
function exportToPhoto(X, Y, W, H) {
  const s = auto.scale * zoom, a = rot * Math.PI / 180;
  const ux = X - (W / 2 + dx), uy = Y - (EYE_Y * H + dy);
  return [
    auto.ex + (ux * Math.cos(a) + uy * Math.sin(a)) / s,
    auto.ey + (-ux * Math.sin(a) + uy * Math.cos(a)) / s,
  ];
}

/* ---------- 手动修边：擦除 / 恢复（直接改 maskedCanvas 的 alpha） ---------- */

let brushPos = null;          // 笔刷位置（输出坐标），仅预览画圈
let strokePrev = null, strokeBox = null;
const undoStack = [];         // 每笔画只存受影响区域：{ data: ImageData, x, y }
const brushCanvas = document.createElement('canvas');
const snapCanvas = document.createElement('canvas');

const brushR = () => Math.max(6, prefs.brush / 100 * Math.max(photoCanvas.width, photoCanvas.height));

function drawBrushDot(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x, y, r * 0.55, x, y, r); // 中心实、边缘渐隐
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function paintAt(px, py, erase) {
  const mctx = maskedCanvas.getContext('2d');
  const r = brushR();
  const x0 = Math.floor(px - r - 1), y0 = Math.floor(py - r - 1), sz = Math.ceil(2 * r) + 3;
  if (erase) {
    mctx.save();
    mctx.globalCompositeOperation = 'destination-out';
    drawBrushDot(mctx, px, py, r);
    mctx.restore();
  } else {
    // 恢复：从原图取笔画范围内的像素，按笔刷形状贴回蒙版
    const sx = Math.max(0, x0), sy = Math.max(0, y0);
    const ex = Math.min(photoCanvas.width, x0 + sz), ey = Math.min(photoCanvas.height, y0 + sz);
    if (ex <= sx || ey <= sy) return;
    brushCanvas.width = sz; brushCanvas.height = sz;
    const bctx = brushCanvas.getContext('2d');
    bctx.drawImage(photoCanvas, sx, sy, ex - sx, ey - sy, sx - x0, sy - y0, ex - sx, ey - sy);
    bctx.globalCompositeOperation = 'destination-in';
    drawBrushDot(bctx, px - x0, py - y0, r);
    mctx.drawImage(brushCanvas, x0, y0);
  }
  const bx = Math.max(0, x0), by = Math.max(0, y0);
  const bx2 = Math.min(maskedCanvas.width, x0 + sz), by2 = Math.min(maskedCanvas.height, y0 + sz);
  strokeBox = strokeBox
    ? [Math.min(strokeBox[0], bx), Math.min(strokeBox[1], by), Math.max(strokeBox[2], bx2), Math.max(strokeBox[3], by2)]
    : [bx, by, bx2, by2];
}

function beginStroke() {
  snapCanvas.width = maskedCanvas.width; // 落笔前整幅留底，收笔时只截取画过的区域
  snapCanvas.height = maskedCanvas.height;
  snapCanvas.getContext('2d').drawImage(maskedCanvas, 0, 0);
  strokeBox = null;
}

function endStroke() {
  if (strokeBox) {
    const [x, y, x2, y2] = strokeBox;
    undoStack.push({ data: snapCanvas.getContext('2d').getImageData(x, y, x2 - x, y2 - y), x, y });
    if (undoStack.length > 20) undoStack.shift();
  }
  snapCanvas.width = snapCanvas.height = 0; // 释放留底画布
  strokeBox = null;
  syncUndoBtn();
}

function undoStroke() {
  const u = undoStack.pop();
  if (!u) return;
  maskedCanvas.getContext('2d').putImageData(u.data, u.x, u.y);
  syncUndoBtn();
  scheduleRender();
}

function syncUndoBtn() {
  $('undoBtn').disabled = !undoStack.length;
}

/* ---------- 上传的衣服照片：纯色底自动抠图（四边取色 + 漫水 + 羽化） ---------- */

function floodCutout(srcCanvas, tol) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const data = srcCanvas.getContext('2d').getImageData(0, 0, W, H).data;

  // 参考底色：四条边像素的平均色
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  const sampleAt = (x, y) => {
    const i = (y * W + x) * 4;
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; cnt++;
  };
  for (let x = 0; x < W; x += 2) { sampleAt(x, 0); sampleAt(x, H - 1); }
  for (let y = 0; y < H; y += 2) { sampleAt(0, y); sampleAt(W - 1, y); }
  sr /= cnt; sg /= cnt; sb /= cnt;

  const stepTol = tol, globTol = tol * 1.5;
  const dist2 = (r, g, b) => { const dr = r - sr, dg = g - sg, db = b - sb; return dr * dr + dg * dg + db * db; };
  const stepTol2 = stepTol * stepTol * 3, globTol2 = globTol * globTol * 3;

  const isBg = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let qh = 0, qt = 0;
  const push = (p) => { isBg[p] = 1; queue[qt++] = p; };
  for (let x = 0; x < W; x++) {
    if (dist2(data[x * 4], data[x * 4 + 1], data[x * 4 + 2]) <= globTol2) push(x);
    const p = (H - 1) * W + x;
    if (!isBg[p] && dist2(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) <= globTol2) push(p);
  }
  for (let y = 0; y < H; y++) {
    const p1 = y * W, p2 = y * W + W - 1;
    if (!isBg[p1] && dist2(data[p1 * 4], data[p1 * 4 + 1], data[p1 * 4 + 2]) <= globTol2) push(p1);
    if (!isBg[p2] && dist2(data[p2 * 4], data[p2 * 4 + 1], data[p2 * 4 + 2]) <= globTol2) push(p2);
  }
  // BFS 漫水：与上一个背景像素颜色连续、且整体仍贴近参考底色，才判为背景
  const near = (p, q) => {
    const a = p * 4, b = q * 4;
    const dr = data[a] - data[b], dg = data[a + 1] - data[b + 1], db = data[a + 2] - data[b + 2];
    return dr * dr + dg * dg + db * db <= stepTol2;
  };
  const nearGlob = (p) => dist2(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) <= globTol2;
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % W, y = (p / W) | 0;
    if (x > 0 && !isBg[p - 1] && near(p, p - 1) && nearGlob(p - 1)) push(p - 1);
    if (x < W - 1 && !isBg[p + 1] && near(p, p + 1) && nearGlob(p + 1)) push(p + 1);
    if (y > 0 && !isBg[p - W] && near(p, p - W) && nearGlob(p - W)) push(p - W);
    if (y < H - 1 && !isBg[p + W] && near(p, p + W) && nearGlob(p + W)) push(p + W);
  }

  // alpha + 1px 盒模糊羽化
  const alpha = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) alpha[p] = isBg[p] ? 0 : 255;
  const blurred = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) { s += alpha[yy * W + xx]; n++; }
      }
      blurred[y * W + x] = s / n;
    }
  }
  const out = new ImageData(W, H);
  out.data.set(data);
  for (let p = 0; p < W * H; p++) out.data[p * 4 + 3] = blurred[p];
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

/* ---------- 上传的衣服照片：载入 / 抠图 ---------- */

function resetClothTransform() {
  cloth.scale = 1; cloth.rot = 0; cloth.dx = 0; cloth.dy = 0;
}

async function loadClothImage(file) {
  busy(true, '读取衣服照片…');
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    cloth.img = c;
    // 已带透明通道的 PNG/WebP 直接用，不需要抠底
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let transparent = 0, total = 0;
    for (let i = 3; i < d.length; i += 4 * 89) { total++; if (d[i] < 250) transparent++; }
    cloth.hasAlpha = transparent > total * 0.02;
    resetClothTransform();
  } catch (e) {
    busy(false);
    show('衣服照片读取失败：' + e.message, 'error');
    return;
  }
  await recutCloth(true);
}

async function recutCloth(fresh) {
  if (!cloth.img) return;
  if (cloth.hasAlpha || !prefs.clothCutout) {
    cloth.cutCanvas = cloth.img;
  } else {
    busy(true, '衣服抠图…');
    await nextFrame();
    cloth.cutCanvas = floodCutout(cloth.img, prefs.clothTol);
  }
  if (fresh) activeLayer = 'cloth'; // 换了新衣服图：手势默认先调衣服
  busy(false);
  syncUI();
  savePrefs();
}

/* ---------- 内置服装贴片 ---------- */

const imgCache = new Map();
const resolvedImgs = new Map();
const geoCache = new Map(); // 贴片 → 领口几何 {top, bottom, halfTop, cx}

// 贴片边缘的半透明像素是压在白底上抠出来的，直接叠到蓝底上会留一圈浅色描边：
// 按「白底 + 半透明前景」反推出前景本色；再把 alpha 拉陡（<30% 归零、>75% 全实），
// 否则肩口那几行半透明像素会在底色上晕成一条模糊的边
function cleanSticker(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = d[i + 3] / 255;
    if (k === 0 || k === 1) continue;
    for (let j = 0; j < 3; j++) d[i + j] = Math.max(0, Math.min(255, (d[i + j] - (1 - k) * 255) / k));
    d[i + 3] = Math.round(Math.max(0, Math.min(1, (k - 0.3) / 0.45)) * 255);
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

// 从贴片的透明通道提取领口：自上而下找「两侧都有不透明像素」的透明段（即领口洞），
// 一直跟到它闭合为止。贴片图片边缘的透明区不算领口；
// 零星杂点围出的假洞（太窄）、两三行就消失的洞（太短）丢弃后继续往下找。
function analyzeSticker(img) {
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const a = ctx.getImageData(0, 0, W, H).data;
  const clear = (x, y) => a[(y * W + x) * 4 + 3] < 128;

  let prev = null, chain = null;
  for (let y = 0; y < H; y++) {
    let run = null;
    for (let x = 0; x < W;) {
      if (!clear(x, y)) { x++; continue; }
      const x0 = x;
      while (x < W && clear(x, y)) x++;
      const x1 = x - 1;
      if (x0 === 0 || x1 >= W - 1) continue; // 顶到图片边缘：是贴片外部，不是领口
      if (!prev) {
        const d = Math.abs((x0 + x1) / 2 - W / 2);
        if (!run || d < run.d) run = { x0, x1, d }; // 一条新链的开头：取最靠近中间的洞
      } else if (x0 <= prev.x1 && x1 >= prev.x0) {  // 之后：与上一行的洞相连
        run = { x0, x1 };
        break;
      }
    }
    if (run) {
      const w = run.x1 - run.x0 + 1;
      if (!chain) chain = { top: y, minX: run.x0, maxX: run.x1, maxW: 0 };
      chain.minX = Math.min(chain.minX, run.x0);
      chain.maxX = Math.max(chain.maxX, run.x1);
      if (w > chain.maxW) { chain.maxW = w; chain.wide = run; } // 最宽的一行才是领口本体
      chain.bottom = y;
      prev = run;
      continue;
    }
    const ok = chain && chain.bottom - chain.top >= 3 && chain.maxW >= 0.04 * W;
    if (ok) break;
    prev = null; chain = null; // 不是领口（杂点假洞 / 小缝隙）：丢掉重找
  }
  if (!chain || chain.bottom - chain.top < 3 || chain.maxW < 0.04 * W) return null;

  // 服装的上轮廓：每一列第一个不透明像素所在的行（截断线沿着它走）
  const topRow = new Int16Array(W).fill(-1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (!clear(x, y)) { topRow[x] = y; break; }
    }
  }
  // 肩线 = 贴片上部 40% 以内各列轮廓行的 20 分位：把这一行对到人像的颈根，衣服就落在正确高度
  // （西装接近贴片顶端，Polo / 衬衫的肩线在贴片高度的 15%~25% 处，各不相同）
  const vals = [];
  for (let x = 0; x < W; x++) if (topRow[x] >= 0 && topRow[x] <= 0.4 * H) vals.push(topRow[x]);
  vals.sort((p, q) => p - q);

  // 领口可能从一条细缝开始、往下才变宽，所以窗口的宽度和中心取整条链里最宽的那一行
  const f = chain.wide;
  return {
    top: chain.top, bottom: chain.bottom, minX: chain.minX, maxX: chain.maxX, topRow,
    halfTop: (f.x1 - f.x0 + 1) / 2, cx: (f.x0 + f.x1) / 2,
    shoulderRow: vals.length ? vals[Math.floor(vals.length * 0.2)] : 0,
  };
}


function loadCloth(file) {
  if (!imgCache.has(file)) {
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const cv = cleanSticker(img);
        resolvedImgs.set(file, cv);
        geoCache.set(file, analyzeSticker(cv));
        resolve(cv);
      };
      img.onerror = () => { imgCache.delete(file); reject(new Error('贴片加载失败: ' + file)); };
      img.src = './assets/' + file;
    });
    imgCache.set(file, p);
  }
  return imgCache.get(file);
}

function ensureClothAndRender() {
  syncUI();
  const variant = currentVariant();
  if (variant) loadCloth(variant.file).then(() => scheduleRender()).catch(e => show(e.message, 'error'));
}

/* ---------- 服装层绘制 ---------- */

// 内置服装的摆放几何：贴片位置 + 领口窗口（人像在领口线以下只在这个窗口里可见）
function outfitGeom(W, H) {
  const variant = currentVariant();
  const el = variant && resolvedImgs.get(variant.file);
  if (!el) return null;
  const srcW = el.width, srcH = el.height;
  const dw = W * prefs.outfitW / 100;
  const dhNat = dw * srcH / srcW;
  const shoulderY = autoShoulderY(W, H);
  const hole = geoCache.get(variant.file);
  const sx = dw / srcW, sy = dhNat / srcH;
  const g = { el, srcW, srcH, dw, dhNat, variant, sx, sy };

  // 贴片自己的肩线对到人像的颈根（没有几何信息时退回按 anchor 比例估算）；
  // 贴片必须一直盖到照片底边（底部再压 4% 余量防悬空）
  g.yTop = shoulderY - (hole ? hole.shoulderRow : variant.anchor * srcH) * sy;
  g.x = neckPoint(W, H).x - dw / 2;
  g.dh = Math.max(dhNat, H * 1.04 - g.yTop);

  // 开襟西装做「沿轮廓截断 + V 领补色」：它的领口是开的，必须把人自己的衣服截掉、再补上衬衫。
  // 封闭款里只有高领做水平截断（见下）；低领的衬衫 / Polo 只做普通叠加。
  if (hole) {
    const m = 2; // 贴片像素余量，多出的部分会被不透明的衣领盖住
    const P = (px, py) => [g.x + px * sx, g.yTop + py * sy];
    const depth = hole.bottom - hole.top, h = hole.halfTop + m;
    // 贴片下半段会被拉伸，行坐标按两段式映射（与绘制时的切分一致）
    const cutRow = Math.round(srcH * (variant.stretchFrom || 0.55)), dCut = cutRow * sy;
    const Q = (px, row) => [g.x + px * sx, row <= cutRow ? g.yTop + row * sy : g.yTop + dCut + (row - cutRow) * (g.dh - dCut) / (srcH - cutRow)];

    // 脖颈窗口：领口范围内人像一直可见。开襟西装往下收成 V 形，V 以下补衬衫色；
    // 窗口的 V 边比补色区的 V 边更低，让补色区的上边缘压在人像像素上，交界处不露底色
    let win;
    if (variant.fill) {
      const yA = hole.top + 0.35 * depth, yB = hole.top + 0.85 * depth;
      win = [[hole.cx - h, hole.top - m], [hole.cx - h, yA], [hole.cx, yB + m], [hole.cx + h, yA], [hole.cx + h, hole.top - m]];
      g.fill = [P(hole.cx - h, yA), P(hole.cx, yB), P(hole.cx + h, yA), Q(hole.cx + h, srcH + 4), Q(hole.cx - h, srcH + 4)];
    } else { // 封闭款（衬衫 / Polo / 高领）：领口有多深，脖子就露多深
      win = [[hole.cx - h, hole.top - m], [hole.cx - h, hole.bottom + m], [hole.cx + h, hole.bottom + m], [hole.cx + h, hole.top - m]];
    }

    if (!variant.fill) {
      // 高领款：领口在肩线附近就闭合、领子明显高出肩线 —— 只保留领口以上和领口洞内的脖子，其余截掉；
      // 否则原上衣会从高领两侧的斜肩上方露出来（像把 T 恤套在高领外面）。
      // 低领的衬衫 / Polo 不做截断：它们领口两侧是斜肩，截断会把脖子到肩膀之间掏空。
      if (hole.bottom <= hole.shoulderRow + 0.02 * srcH && hole.shoulderRow - hole.top >= 0.02 * srcH) {
        // 脖颈窗口比领口窄（约 1.1 个瞳距宽）：领口洞里脖子两侧不露出原上衣，垫深色当作领子内侧的阴影
        const hn = Math.min(h, 0.55 * IPD * W / sx), cutY = g.yTop + hole.top * sy;
        const q = [[hole.cx - hn, hole.top - m], [hole.cx + hn, hole.top - m], [hole.cx + hn, hole.bottom + m], [hole.cx - hn, hole.bottom + m]].map(p => P(p[0], p[1]));
        g.clip = [[-W, -H], [2 * W, -H], [2 * W, cutY], q[1], q[2], q[3], q[0], [-W, cutY]];
        g.back = [[hole.cx - h, hole.top - m], [hole.cx + h, hole.top - m], [hole.cx + h, hole.bottom + m], [hole.cx - h, hole.bottom + m]].map(p => P(p[0], p[1])); // 垫满整个领口洞
        g.backColor = '#262626';
      }
      return g;
    }
    // 领口范围内先垫一层衬衫色（画在人像下面）：人像没拍全 / 被抠掉的部分不会露出底色
    g.back = [P(hole.cx - h, hole.top - m), P(hole.cx + h, hole.top - m), P(hole.cx + h, hole.bottom + m), P(hole.cx - h, hole.bottom + m)];

    // 截断范围 = 服装上轮廓以上（领口两外侧逐列沿轮廓走，并向下多留 2px 让衣缘压在人像上，不留缝）
    //           ∪ 脖颈窗口。轮廓以下、衣服以外的躯干一律裁掉，原来穿的衣服就不会露出来。
    // 上方没有衣服的列（如袖子外侧）按「顶行 + 25% 贴片高」封顶，避免把整条手臂放出来。
    let base = Infinity;
    for (let x = 0; x < srcW; x++) if (hole.topRow[x] >= 0 && hole.topRow[x] < base) base = hole.topRow[x];
    const limit = base + 0.25 * srcH, step = Math.max(1, Math.round(srcW / 180));
    // 轮廓行取横向 ±1.5% 宽度内的最大值：贴片顶角的零星杂点不会在截断线上戳出尖刺
    const rw = Math.max(1, Math.round(srcW * 0.015));
    const rowAt = (x) => {
      let r = -1;
      for (let k = Math.max(0, x - rw); k <= Math.min(srcW - 1, x + rw); k++) if (hole.topRow[k] > r) r = hole.topRow[k];
      return r;
    };
    const line = (x) => P(x, Math.min(rowAt(x) < 0 ? srcH : rowAt(x), limit) + 2 / sy);
    const left = [], right = [];
    for (let x = 0; x < hole.minX; x += step) left.push(line(x));
    if (hole.minX >= 1) left.push(line(hole.minX - 1));
    for (let x = hole.maxX + 1; x < srcW; x += step) right.push(line(x));
    right.push(line(srcW - 1));
    g.clip = [...left, ...win.map(p => P(p[0], p[1])), ...right, [g.x + srcW * sx, -H], [g.x, -H]];
  }
  return g;
}

function polyPath(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// 上传的衣服照片：默认「宽 = 115% 照片宽、领口在肩线附近」，以颈根为基准叠加平移 / 缩放 / 旋转
function drawClothCustom(ctx, W, H) {
  if (!cloth.cutCanvas) return;
  const n = neckPoint(W, H);
  const dw = W * 1.15 * cloth.scale;
  const dh = dw * cloth.cutCanvas.height / cloth.cutCanvas.width;
  ctx.save();
  ctx.translate(n.x + cloth.dx, autoShoulderY(W, H) + 0.1 * H + cloth.dy);
  ctx.rotate(cloth.rot * Math.PI / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cloth.cutCanvas, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/* ---------- 合成与渲染 ---------- */

function compose(ctx, W, H, withGuide) {
  const bg = BGS.find(b => b.id === prefs.bg) || BGS[0];
  if (bg.grad) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, bg.css[0]);
    g.addColorStop(1, bg.css[1]);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg.css;
  }
  ctx.fillRect(0, 0, W, H);

  const g = prefs.outfit === 'custom' ? null : outfitGeom(W, H);

  if (g && g.back) {
    ctx.beginPath();
    polyPath(ctx, g.back);
    ctx.fillStyle = g.backColor || g.variant.fill || '#f6f6f6';
    ctx.fill();
  }

  if (maskedCanvas && auto) {
    // 自动对齐为基准：双眼中点 → (W/2, EYE_Y·H)，瞳距 → IPD·W；再叠加用户微调
    const s = auto.scale * zoom;
    ctx.save();
    if (g && g.clip && (prefs.cut || !g.variant.fill)) { // 领口截断（西装可用「长发勿裁」关闭，高领必须截）
      ctx.beginPath();
      polyPath(ctx, g.clip);
      ctx.clip();
    }
    ctx.translate(W / 2 + dx, EYE_Y * H + dy);
    ctx.rotate(rot * Math.PI / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(maskedCanvas, -auto.ex * s, -auto.ey * s, photoCanvas.width * s, photoCanvas.height * s);
    ctx.restore();
  }

  if (prefs.outfit === 'custom') {
    drawClothCustom(ctx, W, H);
  } else if (g) {
    if (g.fill) { // V 领补衬衫色：盖住人自己的衣领，也保证领口里不会露出底色
      ctx.beginPath();
      polyPath(ctx, g.fill);
      ctx.fillStyle = g.variant.fill;
      ctx.fill();
    }
    // 不需要拉伸时整张一次画完（分段绘制会留一条细亮线）；
    // 需要拉长时才分两段：stretchFrom 以上（领口 / 领带结）保持原比例，以下的躯干拉伸补高，接缝处重叠 1px
    const cutRow = Math.round(g.srcH * (g.variant.stretchFrom || 0.55));
    ctx.imageSmoothingQuality = 'high';
    if (g.dh <= g.dhNat + 0.5) {
      ctx.drawImage(g.el, g.x, g.yTop, g.dw, g.dh);
    } else {
      const dCut = cutRow / g.srcH * g.dhNat, ov = 1, ovSrc = g.srcH / g.dhNat;
      ctx.drawImage(g.el, 0, 0, g.srcW, cutRow, g.x, g.yTop, g.dw, dCut);
      ctx.drawImage(g.el, 0, cutRow - ovSrc, g.srcW, g.srcH - cutRow + ovSrc, g.x, g.yTop + dCut - ov, g.dw, g.dh - dCut + ov);
    }
  }

  if (withGuide && isBrush() && brushPos && auto) { // 笔刷圈仅预览，不进导出
    ctx.save();
    ctx.beginPath();
    ctx.arc(brushPos[0], brushPos[1], brushR() * auto.scale * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(2.5, W / 150);
    ctx.stroke();
    ctx.strokeStyle = activeLayer === 'erase' ? 'rgba(255,80,80,0.95)' : 'rgba(60,210,110,0.95)';
    ctx.lineWidth = Math.max(1.2, W / 330);
    ctx.stroke();
    ctx.restore();
  }
}

const pv = $('preview');
let rafPending = false;

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function render() {
  if (!maskedCanvas) return;
  const size = SIZES.find(s => s.id === prefs.size);
  const scale = 2; // 预览按 2 倍渲染，高分屏不发虚
  pv.width = size.w * scale;
  pv.height = size.h * scale;
  // 画布适配预览区剩余空间（单屏布局：预览区 flex 撑满，控制台多一行预览就矮一行）
  const box = $('edPreview').getBoundingClientRect();
  const cssScale = Math.min(Math.max(80, box.width - 8) / size.w, Math.max(80, box.height - 8) / size.h);
  pv.style.width = Math.round(size.w * cssScale) + 'px';
  pv.style.height = Math.round(size.h * cssScale) + 'px';
  const ctx = pv.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  compose(ctx, size.w, size.h, true);
}

window.addEventListener('resize', scheduleRender);

/* ---------- 控件显隐同步 ---------- */

function syncUI() {
  const custom = prefs.outfit === 'custom';
  const brush = isBrush();
  if (activeLayer === 'cloth' && !(custom && cloth.cutCanvas)) activeLayer = 'person';

  for (const b of $('genderSeg').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.g === prefs.gender);
  }
  for (const b of $('gestureSeg').querySelectorAll('button')) {
    if (b.dataset.layer === 'cloth') b.hidden = !(custom && cloth.cutCanvas);
    b.classList.toggle('active', b.dataset.layer === activeLayer);
  }
  $('builtinSliders').hidden = custom || prefs.outfit === 'none' || brush;
  $('clothControls').hidden = !custom || brush;
  $('brushBar').hidden = !brush;

  $('clothTolRow').style.opacity = prefs.clothCutout && !cloth.hasAlpha ? '1' : '0.4';
  $('clothCutChk').checked = prefs.clothCutout;
  $('clothCutHint').textContent = cloth.hasAlpha ? '检测到透明底，直接使用' : '纯色背景的衣服照片会自动抠除背景';
  $('clothScale').value = Math.round(cloth.scale * 100);
  $('clothRot').value = Math.round(cloth.rot);
  const v = currentVariant();
  $('longHairChk').parentElement.hidden = !v || !v.fill; // 只有开襟西装会截断躯干
  $('longHairChk').checked = !prefs.cut;
  syncUndoBtn();
  scheduleRender(); // 控件行显隐会改变预览区高度
}

/* ---------- 预览手势：拖动 / 双指缩放旋转 / 滚轮 / 修边涂抹 ---------- */

const pointers = new Map();
let pinchBase = null;

function toExport(e) {
  const size = SIZES.find(s => s.id === prefs.size);
  const r = pv.getBoundingClientRect();
  return [(e.clientX - r.left) * size.w / r.width, (e.clientY - r.top) * size.h / r.height];
}

pv.addEventListener('pointerdown', (e) => {
  if (!maskedCanvas) return;
  e.preventDefault();
  try { pv.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (isBrush()) {
    if (strokePrev) { endStroke(); strokePrev = null; }
    if (pointers.size !== 1) return; // 双指不落笔
    beginStroke();
    const size = SIZES.find(s => s.id === prefs.size);
    const [px, py] = exportToPhoto(...toExport(e), size.w, size.h);
    paintAt(px, py, activeLayer === 'erase');
    strokePrev = [px, py];
    scheduleRender();
    return;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchBase = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      layer: activeLayer,
      person: { zoom, dx, dy, rot },
      clothT: { scale: cloth.scale, rot: cloth.rot, dx: cloth.dx, dy: cloth.dy },
    };
  }
});
pv.addEventListener('pointermove', (e) => {
  const size = SIZES.find(s => s.id === prefs.size);
  if (isBrush()) {
    brushPos = toExport(e);
    if (pointers.has(e.pointerId) && pointers.size === 1 && strokePrev) {
      const [px, py] = exportToPhoto(brushPos[0], brushPos[1], size.w, size.h);
      const r = brushR();
      const steps = Math.max(1, Math.ceil(Math.hypot(px - strokePrev[0], py - strokePrev[1]) / (r * 0.35)));
      for (let i = 1; i <= steps; i++) { // 快速滑动时沿路径补点，不断线
        paintAt(strokePrev[0] + (px - strokePrev[0]) * i / steps, strokePrev[1] + (py - strokePrev[1]) * i / steps, activeLayer === 'erase');
      }
      strokePrev = [px, py];
    }
    scheduleRender();
    return;
  }
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const f = size.w / pv.clientWidth; // CSS 像素 → 导出像素
  if (pointers.size === 1 && !pinchBase) {
    if (activeLayer === 'cloth') {
      cloth.dx += (e.clientX - prev.x) * f;
      cloth.dy += (e.clientY - prev.y) * f;
    } else {
      dx += (e.clientX - prev.x) * f;
      dy += (e.clientY - prev.y) * f;
    }
    scheduleRender();
  } else if (pointers.size === 2 && pinchBase) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) - pinchBase.ang) * 180 / Math.PI;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinchBase.layer === 'cloth') {
      cloth.scale = clamp(pinchBase.clothT.scale * dist / pinchBase.dist, 0.15, 3);
      cloth.rot = clamp(pinchBase.clothT.rot + deg, -45, 45);
      cloth.dx = pinchBase.clothT.dx + (mx - pinchBase.mid.x) * f;
      cloth.dy = pinchBase.clothT.dy + (my - pinchBase.mid.y) * f;
      $('clothScale').value = Math.round(cloth.scale * 100);
      $('clothRot').value = Math.round(cloth.rot);
    } else {
      zoom = clamp(pinchBase.person.zoom * dist / pinchBase.dist, 0.3, 3);
      rot = clamp(pinchBase.person.rot + deg, -45, 45);
      dx = pinchBase.person.dx + (mx - pinchBase.mid.x) * f;
      dy = pinchBase.person.dy + (my - pinchBase.mid.y) * f;
    }
    scheduleRender();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchBase = null;
  if (isBrush() && strokePrev && pointers.size === 0) { endStroke(); strokePrev = null; }
};
pv.addEventListener('pointerup', endPointer);
pv.addEventListener('pointercancel', endPointer);
pv.addEventListener('pointerleave', () => {
  if (isBrush()) { brushPos = null; scheduleRender(); }
});

pv.addEventListener('wheel', (e) => {
  if (!maskedCanvas) return;
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0012);
  if (activeLayer === 'cloth') {
    cloth.scale = clamp(cloth.scale * k, 0.15, 3);
    $('clothScale').value = Math.round(cloth.scale * 100);
  } else if (!isBrush()) {
    zoom = clamp(zoom * k, 0.3, 3);
  }
  scheduleRender();
}, { passive: false });

/* ---------- 控件渲染 ---------- */

function renderSizeChips() {
  const box = $('sizeChips');
  box.innerHTML = '';
  for (const s of SIZES) {
    const b = document.createElement('button');
    b.className = 'chip' + (s.id === prefs.size ? ' active' : '');
    b.textContent = s.label;
    b.onclick = () => { prefs.size = s.id; renderSizeChips(); scheduleRender(); savePrefs(); };
    box.appendChild(b);
  }
}

function renderBgSwatches() {
  const box = $('bgSwatches');
  box.innerHTML = '';
  for (const bg of BGS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (bg.id === prefs.bg ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = Array.isArray(bg.css) ? `linear-gradient(${bg.css[0]}, ${bg.css[1]})` : bg.css;
    b.append(dot, document.createTextNode(bg.label));
    b.onclick = () => { prefs.bg = bg.id; renderBgSwatches(); scheduleRender(); savePrefs(); };
    box.appendChild(b);
  }
}

// 服装 chips 扁平化：款式 + 颜色并成一个 chip（西装·藏蓝），不用二层选择
function renderOutfitChips() {
  const box = $('outfitChips');
  box.innerHTML = '';
  if (!['none', 'custom'].includes(prefs.outfit) && !outfitsFor(prefs.gender).some(o => o.id === prefs.outfit)) {
    prefs.outfit = 'none';
  }
  const entries = [{ o: NONE_OUTFIT, v: null, idx: 0 }, { o: CUSTOM_OUTFIT, v: null, idx: 0 }];
  for (const o of outfitsFor(prefs.gender)) {
    o.variants.forEach((v, idx) => entries.push({ o, v, idx }));
  }
  for (const e of entries) {
    const b = document.createElement('button');
    const on = prefs.outfit === e.o.id && (!e.v || prefs.variantIdx === e.idx);
    b.className = 'chip' + (on ? ' active' : '');
    b.textContent = e.v ? `${e.o.label}·${e.v.label}` : e.o.label;
    b.onclick = () => {
      prefs.outfit = e.o.id;
      prefs.variantIdx = e.v ? e.idx : 0;
      if (e.o.id === 'custom') {
        if (!cloth.img) $('clothInput').click(); // 还没有衣服图，直接弹选择
        else if (cloth.cutCanvas) activeLayer = 'cloth';
      } else {
        activeLayer = isBrush() ? activeLayer : 'person';
      }
      renderOutfitChips();
      ensureClothAndRender();
      savePrefs();
    };
    box.appendChild(b);
  }
}

/* ---------- 示例人物 ---------- */

// 照片放进 assets/demo/ 即出现在选择器（缺文件的条目自动隐藏）。
// gender / outfit：点一下直接配好服装出成片；shoulder：这位人物的肩线微调（%）
const DEMOS = [
  { id: 'bruce', label: '李小龙', file: 'demo_bruce.jpg', gender: 'm', outfit: 'suit' },
  { id: 'arnold', label: '施瓦辛格', file: 'demo_arnold.jpg', gender: 'm', outfit: 'suit', shoulder: -7 }, // 肩比常人高得多
  { id: 'jiangwen', label: '姜文', file: 'demo_jiangwen.jpg', gender: 'm', outfit: 'suit' },
  // 赫本肩线又高又方、几乎没有脖子，女装西装的斜肩盖不住她的原上衣，所以她只演示换底色
  { id: 'audrey', label: '赫本', file: 'demo_audrey.jpg', gender: 'f', outfit: 'none' },
];

function renderDemoChips() {
  const box = $('demoChips');
  box.innerHTML = '';
  for (const d of DEMOS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = d.label;
    b.onclick = async () => {
      busy(true, '载入示例…');
      try {
        const r = await fetch('./assets/demo/' + d.file);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        prefs.gender = d.gender;
        prefs.shoulder = d.shoulder || 0;
        $('shoulder').value = prefs.shoulder;
        // 当前款式在新性别下仍有效（或已有自定义衣服）就保留，否则换成示例自带的搭配
        const keep = prefs.outfit === 'custom' ? !!cloth.cutCanvas : outfitsFor(d.gender).some(o => o.id === prefs.outfit);
        if (!keep) { prefs.outfit = d.outfit; prefs.variantIdx = 0; }
        renderOutfitChips();
        await processPhoto(blob);
      } catch (e) {
        busy(false);
        show(`示例「${d.label}」加载失败：${e.message}`, 'error');
      }
    };
    box.appendChild(b);
    fetch('./assets/demo/' + d.file, { method: 'HEAD' })
      .then(r => { if (!r.ok) b.remove(); })
      .catch(() => b.remove());
  }
}

/* ---------- 控件事件 ---------- */

$('genderSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-g]');
  if (!b) return;
  prefs.gender = b.dataset.g;
  prefs.variantIdx = 0;
  if (activeLayer === 'cloth') activeLayer = 'person';
  renderOutfitChips();
  ensureClothAndRender(); // 内含 syncUI
  savePrefs();
});

$('gestureSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layer]');
  if (!b) return;
  activeLayer = b.dataset.layer;
  brushPos = null;
  if (isBrush()) {
    show(activeLayer === 'erase'
      ? '涂抹：擦掉多余的背景或杂物（如头发旁的墙角）'
      : '涂抹：涂回被误删的头发 / 肩膀 · 两指缩放请切回「人像」', 'ok');
  }
  syncUI();
});

$('shoulder').addEventListener('input', function () {
  prefs.shoulder = Number(this.value);
  scheduleRender(); savePrefs();
});
$('outfitW').addEventListener('input', function () {
  prefs.outfitW = Number(this.value);
  scheduleRender(); savePrefs();
});

$('longHairChk').addEventListener('change', function () {
  prefs.cut = !this.checked;
  scheduleRender(); savePrefs();
});
$('brushSize').addEventListener('input', function () {
  prefs.brush = Number(this.value);
  scheduleRender(); savePrefs();
});
$('undoBtn').onclick = undoStroke;

$('clothUploadBtn').onclick = () => $('clothInput').click();
$('clothInput').addEventListener('change', async function () {
  if (this.files && this.files[0]) {
    prefs.outfit = 'custom';
    renderOutfitChips();
    await loadClothImage(this.files[0]);
  }
  this.value = '';
});
$('clothScale').addEventListener('input', function () {
  cloth.scale = Number(this.value) / 100;
  scheduleRender();
});
$('clothRot').addEventListener('input', function () {
  cloth.rot = Number(this.value);
  scheduleRender();
});
$('clothResetBtn').onclick = () => { resetClothTransform(); syncUI(); };
$('clothCutChk').addEventListener('change', function () {
  prefs.clothCutout = this.checked;
  recutCloth(false);
});
$('clothTol').addEventListener('change', function () {
  prefs.clothTol = Number(this.value);
  recutCloth(false);
});

/* ---------- 处理管线：载入 → 分割 → 对齐 → 摆正 → 编辑器 ---------- */

async function processPhoto(source) {
  busy(true, '读取照片…');
  try {
    await loadPhotoCanvas(source);
  } catch (e) {
    busy(false);
    show('照片读取失败：' + e.message, 'error');
    return;
  }

  let segmented = false, faced = false;
  try {
    busy(true, '初始化模型…（首次约需几秒）');
    await ensureModels();
    busy(true, '人像分割…');
    await nextFrame();
    await applySegmentation();
    segmented = true;
  } catch (e) {
    maskedCanvas = photoCanvas; // 分割失败 → 保留原背景继续用
  }
  busy(true, '人脸对齐…');
  await nextFrame();
  faced = detectFace(); // 失败时也给出居中兜底的 auto
  if (segmented && faced) levelPhoto();

  zoom = 1; dx = 0; dy = 0; rot = 0;
  undoStack.length = 0;
  brushPos = null;
  activeLayer = prefs.outfit === 'custom' && cloth.cutCanvas ? 'cloth' : 'person';
  showView('Editor');
  busy(false);
  ensureClothAndRender(); // 同步控件 + 渲染，并确保当前服装贴片已加载
  if (!segmented) {
    show('抠图模型加载失败，已保留原背景（检查网络后重试）', 'error');
  } else if (!faced) {
    show('未检测到人脸，已居中放置 —— 可拖动 / 双指调整，或用「擦除」修边', 'ok');
  } else {
    show('已自动对齐 · 拖动或双指调整人像，衣服会跟着头部走', 'ok');
  }
}

/* ---------- 上传 ---------- */

$('uploadBtn').onclick = () => $('fileInput').click();
$('reuploadBtn').onclick = () => $('fileInput').click();
$('fileInput').addEventListener('change', function () {
  if (this.files && this.files[0]) processPhoto(this.files[0]);
  this.value = '';
});

/* ---------- 相机 ---------- */

async function startCamera() {
  $('camError').classList.add('hidden');
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const video = $('camVideo');
    video.srcObject = stream;
    video.classList.toggle('mirror', facing === 'user');
    await video.play();
  } catch (e) {
    const msg = window.isSecureContext
      ? `摄像头打开失败（${e.name}）：请在弹窗中允许摄像头权限；被拒绝时可改用「相册选择」。`
      : '摄像头需要 HTTPS 环境（当前页面不是安全上下文），请用 GitHub Pages 地址访问，或改用「相册选择」。';
    $('camError').textContent = msg;
    $('camError').classList.remove('hidden');
  }
}

function stopCamera() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
}

$('startCamBtn').onclick = () => { showView('Camera'); startCamera(); };
$('retakeBtn').onclick = () => { showView('Camera'); startCamera(); };
$('closeCamBtn').onclick = () => { stopCamera(); showView('Home'); };
$('flipBtn').onclick = () => {
  facing = facing === 'user' ? 'environment' : 'user';
  startCamera();
};
$('shotBtn').onclick = () => {
  const video = $('camVideo');
  if (!stream || !video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  stopCamera();
  processPhoto(c);
};

/* ---------- 导出 ---------- */

function exportCanvas() {
  if (!maskedCanvas) { show('请先拍照或选照片', 'error'); return null; }
  const size = SIZES.find(s => s.id === prefs.size);
  const c = document.createElement('canvas');
  c.width = size.w;
  c.height = size.h;
  compose(c.getContext('2d'), size.w, size.h, false); // 导出不含笔刷圈
  return c;
}

function fileName(ext) {
  const s = SIZES.find(x => x.id === prefs.size);
  const bg = BGS.find(b => b.id === prefs.bg);
  return `证件照_${s.label.split(' ')[0]}_${bg.label}_${s.w}x${s.h}.${ext}`;
}

function downloadBlob(blob, name, btn) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  if (btn) flash(btn, '已下载 ✓');
}

$('downloadBtn').onclick = function () {
  const c = exportCanvas();
  if (c) c.toBlob(b => b && downloadBlob(b, fileName('png'), this), 'image/png');
};

$('copyBtn').onclick = function () {
  const c = exportCanvas();
  if (!c) return;
  navigator.clipboard.write([new ClipboardItem({ 'image/png': new Promise(r => c.toBlob(r, 'image/png')) })])
    .then(() => flash(this, '已复制 ✓'))
    .catch(e => show(`复制图片失败（${e.message}），可用「下载」代替`, 'error'));
};

// 六寸排版照：152×102mm @300DPI = 1795×1205，自动铺满 + 裁切线
$('sheetBtn').onclick = function () {
  const c = exportCanvas();
  if (!c) return;
  const SW = 1795, SH = 1205, margin = 28, gap = 10;
  const sheet = document.createElement('canvas');
  sheet.width = SW;
  sheet.height = SH;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SW, SH);
  const cols = Math.max(1, Math.floor((SW - 2 * margin + gap) / (c.width + gap)));
  const rows = Math.max(1, Math.floor((SH - 2 * margin + gap) / (c.height + gap)));
  const ox = (SW - (cols * c.width + (cols - 1) * gap)) / 2;
  const oy = (SH - (rows * c.height + (rows - 1) * gap)) / 2;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = ox + col * (c.width + gap), y = oy + r * (c.height + gap);
      ctx.drawImage(c, x, y);
      ctx.strokeStyle = '#c9c9c9';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, c.width - 1, c.height - 1);
      ctx.setLineDash([]);
    }
  }
  sheet.toBlob(b => b && downloadBlob(b, `六寸排版_${cols}x${rows}.png`, this), 'image/png');
  show(`六寸相纸排了 ${cols} × ${rows} = ${cols * rows} 张，虚线为裁切线`, 'ok');
};

/* ---------- 初始化 ---------- */

(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(DEFAULT_PREFS)) {
        if (typeof saved[k] === typeof DEFAULT_PREFS[k]) prefs[k] = saved[k];
      }
    }
  } catch (e) { /* 忽略损坏的存档 */ }
  if (Math.abs(prefs.shoulder) > 10) prefs.shoulder = 0; // 旧版存的是绝对肩线高度，新版是相对偏移

  $('shoulder').value = prefs.shoulder;
  $('outfitW').value = prefs.outfitW;
  $('brushSize').value = prefs.brush;
  $('clothTol').value = prefs.clothTol;
  renderSizeChips();
  renderBgSwatches();
  renderOutfitChips();
  renderDemoChips();
  syncUI();
})();

// 证件照生成（GitHub Pages 版）：拍照/上传 → MediaPipe 人像分割抠图 → 人脸关键点自动对齐
// → 换底色/换正装 → 导出 PNG / 复制 / 六寸排版照。全部在本页完成，照片不上传。
// 换装贴片、规格、底色、排版逻辑移植自 browser-toolbox 旧桌面版（tools/idphoto）。
import { FilesetResolver, ImageSegmenter, FaceDetector } from './vendor/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);

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

// 服装贴片：assets/ 下预抠好的透明 webp。
// anchor = 贴片内「肩线」高度占贴片高的比例；stretchFrom = 该比例以上保比例、以下拉伸补高
const OUTFITS = [
  { id: 'suit', gender: 'm', season: '冬 · 正装', label: '西装', variants: [
    { label: '藏蓝', file: 'suit_m_navy.webp', anchor: 0.03, stretchFrom: 0.58 },
    { label: '深灰', file: 'suit_m_gray.webp', anchor: 0.06, stretchFrom: 0.55 },
  ] },
  { id: 'shirt', gender: 'm', season: '春秋 · 衬衫', label: '衬衫', variants: [
    { label: '浅蓝', file: 'shirt_m_blue.webp', anchor: 0.05, stretchFrom: 0.55 },
  ] },
  { id: 'polo', gender: 'm', season: '夏 · 短袖', label: '短袖', variants: [
    { label: '白', file: 'polo_m_white.webp', anchor: 0.09, stretchFrom: 0.55 },
  ] },
  { id: 'sweater', gender: 'm', season: '冬 · 针织', label: '毛衣', variants: [
    { label: '深灰', file: 'sweater_m_gray.webp', anchor: 0.02, stretchFrom: 0.5 },
  ] },
  { id: 'suit-f', gender: 'f', season: '冬 · 正装', label: '西装', variants: [
    { label: '藏蓝', file: 'suit_f_navy.webp', anchor: 0.06, stretchFrom: 0.55 },
    { label: '酒红', file: 'suit_f_wine.webp', anchor: 0.08, stretchFrom: 0.55 },
  ] },
  { id: 'shirt-f', gender: 'f', season: '春秋 · 衬衫', label: '衬衫', variants: [
    { label: '白', file: 'shirt_f_white.webp', anchor: 0.05, stretchFrom: 0.55 },
  ] },
  { id: 'polo-f', gender: 'f', season: '夏 · 短袖', label: '短袖', variants: [
    { label: '白', file: 'polo_f_white.webp', anchor: 0.08, stretchFrom: 0.55 },
  ] },
  { id: 'sweater-f', gender: 'f', season: '冬 · 针织', label: '毛衣', variants: [
    { label: '酒红', file: 'sweater_f_wine.webp', anchor: 0.02, stretchFrom: 0.5 },
  ] },
];

const NONE_OUTFIT = { id: 'none', label: '不换装', season: '保持原样' };
const CUSTOM_OUTFIT = { id: 'custom', label: '上传衣服照片', season: '自定义 · 自由定位' };

// 证件照模板：双眼连线中点放在高度的 EYE_Y 处，瞳距放大到宽度的 IPD 倍
const EYE_Y = 0.40;
const IPD = 0.245;
const MAX_EDGE = 1600;      // 处理用照片的最长边
const STORE_KEY = 'toolboxIdPhotoState';

/* ---------- 状态 ---------- */

const prefs = { gender: 'm', outfit: 'none', variantIdx: 0, size: '1in', bg: 'blue', shoulder: 56, outfitW: 115, clothCutout: true, clothTol: 24 };
let zoom = 1, dx = 0, dy = 0;           // 人像层微调（zoom 相对自动对齐的倍率）
let photoCanvas = null;                  // 处理用原图（降采样 + EXIF 转正）
let maskedCanvas = null;                 // 抠掉背景后的图（失败时 = photoCanvas）
let auto = null;                         // 自动对齐参数 {scale, ex, ey}（原图坐标系）
let facing = 'user';
let stream = null;
let segmenter = null, faceDetector = null, modelPromise = null;

// 自定义服装层：用户上传的衣服照片盖在人像上，可拖动 / 缩放 / 旋转
let activeLayer = 'person';              // 预览手势当前调整的层：'person' | 'cloth'
const cloth = { img: null, cutCanvas: null, hasAlpha: false, scale: 1, rot: 0, dx: 0, dy: 0 };

const outfitsFor = (g) => OUTFITS.filter(o => o.gender === g);
const currentOutfit = () =>
  prefs.outfit === 'none' ? null : outfitsFor(prefs.gender).find(o => o.id === prefs.outfit) || null;
const currentVariant = () => {
  const o = currentOutfit();
  return o ? o.variants[Math.min(prefs.variantIdx, o.variants.length - 1)] : null;
};

/* ---------- 小工具 ---------- */

function show(msg, cls) {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status ' + (cls || '');
}

function showView(name) {
  for (const sec of document.querySelectorAll('.view')) {
    sec.hidden = sec.id !== 'view' + name[0].toUpperCase() + name.slice(1);
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
  photoCanvas = document.createElement('canvas');
  photoCanvas.width = Math.round(bmp.width * scale);
  photoCanvas.height = Math.round(bmp.height * scale);
  const ctx = photoCanvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, photoCanvas.width, photoCanvas.height);
  bmp.close && bmp.close();
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
    // 置信度 0.35~0.72 线性映射为 alpha：内部实心、边缘保留一圈柔边
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
    sctx.putImageData(img, 0, 0);
    // 用蒙版 alpha 裁剪原图（小蒙版平滑放大到全尺寸，发丝边缘不发硬）
    maskedCanvas = document.createElement('canvas');
    maskedCanvas.width = photoCanvas.width;
    maskedCanvas.height = photoCanvas.height;
    const mctx = maskedCanvas.getContext('2d');
    mctx.drawImage(photoCanvas, 0, 0);
    mctx.globalCompositeOperation = 'destination-in';
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(sc, 0, 0, maskedCanvas.width, maskedCanvas.height);
    mctx.globalCompositeOperation = 'source-over';
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
    // keypoints 是归一化坐标；眼睛基本水平，x 按宽、y 按高还原成像素距离
    const dist = Math.hypot((k1.x - k0.x) * phW, (k1.y - k0.y) * phH);
    if (dist >= 8) {
      auto = {
        scale: (SIZES[0].w * IPD) / dist * 1, // 以一寸宽度为基准，切换尺寸时按比例同样适用
        ex: ((k0.x + k1.x) / 2) * phW,
        ey: ((k0.y + k1.y) / 2) * phH,
      };
      return true;
    }
  }
  // 兜底：按「cover 铺满 + 眼睛猜在 40% 高度」居中放置
  auto = { scale: Math.max(phW ? SIZES[0].w / phW : 1, SIZES[0].h / phH), ex: phW / 2, ey: phH * 0.40 };
  return false;
}

/* ---------- 自定义服装层：纯色底自动抠图（移植旧版漫水算法） ---------- */

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

  // alpha + 1px 盒模糊羽化（发丝/毛边不发硬）
  const alpha = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) alpha[p] = isBg[p] ? 0 : 255;
  const blurred = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
        const xx = x + dx2, yy = y + dy2;
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

/* ---------- 自定义服装层：上传 / 抠图 / 变换 ---------- */

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
    await new Promise(r => requestAnimationFrame(r));
    cloth.cutCanvas = floodCutout(cloth.img, prefs.clothTol);
  }
  if (fresh) activeLayer = 'cloth'; // 换了新衣服图：手势默认先调衣服
  busy(false);
  render(); syncClothUI(); savePrefs();
}

function syncClothSliders() {
  $('clothScale').value = Math.round(cloth.scale * 100);
  $('clothScaleVal').textContent = Math.round(cloth.scale * 100) + '%';
  $('clothRot').value = Math.round(cloth.rot);
  $('clothRotVal').textContent = Math.round(cloth.rot) + '°';
}

function syncClothUI() {
  const custom = prefs.outfit === 'custom';
  $('clothControls').hidden = !custom;
  $('builtinSliders').hidden = custom;
  $('layerSeg').hidden = !(custom && cloth.cutCanvas && maskedCanvas);
  $('clothTolRow').style.opacity = prefs.clothCutout && !cloth.hasAlpha ? '1' : '0.4';
  $('clothCutChk').checked = prefs.clothCutout;
  $('clothCutHint').textContent = cloth.hasAlpha
    ? '已检测到透明底，直接使用，无需抠图'
    : '建议纯色背景的衣服照片，纯色底会自动抠除；透明底 PNG 直接使用';
  for (const b of $('layerSeg').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.layer === activeLayer);
  }
  if (custom) syncClothSliders();
}

/* ---------- 服装层绘制（内置贴片 + 自定义照片） ---------- */

const imgCache = new Map();
const resolvedImgs = new Map();

function loadCloth(file) {
  if (!imgCache.has(file)) {
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { resolvedImgs.set(file, img); resolve(img); };
      img.onerror = () => { imgCache.delete(file); reject(new Error('贴片加载失败: ' + file)); };
      img.src = './assets/' + file;
    });
    imgCache.set(file, p);
  }
  return imgCache.get(file);
}

function drawClothing(ctx, W, H) {
  if (!photoCanvas) return;
  if (prefs.outfit === 'custom') { drawClothCustom(ctx, W, H); return; }
  const variant = currentVariant();
  if (!variant) return;
  const el = resolvedImgs.get(variant.file);
  if (!el) return;

  const shoulderY = H * prefs.shoulder / 100;
  const needDh = (H - shoulderY + 0.04 * H) / (1 - variant.anchor);
  const srcW = el.naturalWidth, srcH = el.naturalHeight;
  const dw = W * prefs.outfitW / 100;
  const dhNat = dw * srcH / srcW;
  const dh = Math.max(dhNat, needDh);
  const yTop = shoulderY - variant.anchor * dh;

  const cut = Math.round(srcH * (variant.stretchFrom || 0.55));
  const dCut = cut / srcH * dhNat;
  const x = (W - dw) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(el, 0, 0, srcW, cut, x, yTop, dw, Math.min(dCut, dh));
  if (dh > dCut) {
    ctx.drawImage(el, 0, cut, srcW, srcH - cut, x, yTop + dCut, dw, dh - dCut);
  }
}

// 自定义衣服照片：以「宽 = 115% 照片宽、中心在 72% 高度处」为默认位，叠加平移/缩放/旋转
function drawClothCustom(ctx, W, H) {
  if (!cloth.cutCanvas) return;
  const dw = W * 1.15 * cloth.scale;
  const dh = dw * cloth.cutCanvas.height / cloth.cutCanvas.width;
  ctx.save();
  ctx.translate(W / 2 + cloth.dx, H * 0.72 + cloth.dy);
  ctx.rotate(cloth.rot * Math.PI / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cloth.cutCanvas, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/* ---------- 合成与渲染 ---------- */

function compose(ctx, W, H, withGuide) {
  const bg = BGS.find(b => b.id === prefs.bg);
  if (bg.grad) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, bg.css[0]);
    g.addColorStop(1, bg.css[1]);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg.css;
  }
  ctx.fillRect(0, 0, W, H);

  if (maskedCanvas) {
    // 自动对齐为基准：双眼中点 → (W/2, EYE_Y·H)，瞳距 → IPD·W；再叠加用户微调
    const s = auto.scale * zoom;
    const dw = photoCanvas.width * s, dh = photoCanvas.height * s;
    const x = W / 2 - auto.ex * s + dx;
    const y = EYE_Y * H - auto.ey * s + dy;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(maskedCanvas, x, y, dw, dh);
  }

  drawClothing(ctx, W, H);

  if (withGuide) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,160,255,0.35)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = Math.max(1, W / 220);
    ctx.beginPath();
    ctx.arc(W / 2, EYE_Y * H, IPD * W / 2, 0, Math.PI * 2); // 双眼参考圈
    ctx.stroke();
    ctx.restore();
  }
}

const pv = $('preview');

function render() {
  if (!maskedCanvas) return;
  const size = SIZES.find(s => s.id === prefs.size);
  const scale = 2; // 预览按 2 倍渲染，高分屏不发虚
  pv.width = size.w * scale;
  pv.height = size.h * scale;
  const cssScale = Math.min(310 / size.w, 400 / size.h, (window.innerHeight - 220) / size.h);
  pv.style.width = Math.round(size.w * cssScale) + 'px';
  pv.style.height = Math.round(size.h * cssScale) + 'px';
  const ctx = pv.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  compose(ctx, size.w, size.h, true);
  $('previewMeta').textContent =
    `导出：${size.w} × ${size.h} px（300 DPI · ${size.mm[0]}×${size.mm[1]}mm）· 拖动/双指=调整「${activeLayer === 'cloth' ? '衣服' : '人像'}」层`;
}

/* ---------- 预览交互：拖动 / 双指缩放旋转 / 滚轮（作用于当前选中的层） ---------- */

const pointers = new Map();
let pinchBase = null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

pv.addEventListener('pointerdown', (e) => {
  if (!maskedCanvas) return;
  e.preventDefault();
  try { pv.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchBase = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      layer: activeLayer,
      person: { zoom, dx, dy },
      clothT: { scale: cloth.scale, rot: cloth.rot, dx: cloth.dx, dy: cloth.dy },
    };
  }
});
pv.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const size = SIZES.find(s => s.id === prefs.size);
  const f = size.w / pv.clientWidth; // CSS 像素 → 导出像素
  if (pointers.size === 1 && !pinchBase) {
    if (activeLayer === 'cloth') {
      cloth.dx += (e.clientX - prev.x) * f;
      cloth.dy += (e.clientY - prev.y) * f;
    } else {
      dx += (e.clientX - prev.x) * f;
      dy += (e.clientY - prev.y) * f;
    }
    render();
  } else if (pointers.size === 2 && pinchBase) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinchBase.layer === 'cloth') {
      cloth.scale = clamp(pinchBase.clothT.scale * dist / pinchBase.dist, 0.15, 3);
      cloth.rot = clamp(pinchBase.clothT.rot + (ang - pinchBase.ang) * 180 / Math.PI, -45, 45);
      cloth.dx = pinchBase.clothT.dx + (mx - pinchBase.mid.x) * f;
      cloth.dy = pinchBase.clothT.dy + (my - pinchBase.mid.y) * f;
      syncClothSliders();
    } else {
      zoom = clamp(pinchBase.person.zoom * dist / pinchBase.dist, 0.3, 3);
      dx = pinchBase.person.dx + (mx - pinchBase.mid.x) * f;
      dy = pinchBase.person.dy + (my - pinchBase.mid.y) * f;
    }
    render();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchBase = null;
};
pv.addEventListener('pointerup', endPointer);
pv.addEventListener('pointercancel', endPointer);

pv.addEventListener('wheel', (e) => {
  if (!maskedCanvas) return;
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0012);
  if (activeLayer === 'cloth') {
    cloth.scale = clamp(cloth.scale * k, 0.15, 3);
    syncClothSliders();
  } else {
    zoom = clamp(zoom * k, 0.3, 3);
  }
  render();
}, { passive: false });

/* ---------- 控件渲染 ---------- */

function renderSizeChips() {
  const box = $('sizeChips');
  box.innerHTML = '';
  for (const s of SIZES) {
    const b = document.createElement('button');
    b.className = 'chip' + (s.id === prefs.size ? ' active' : '');
    b.textContent = s.label;
    b.onclick = () => { prefs.size = s.id; renderSizeChips(); render(); savePrefs(); };
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
    dot.style.background = Array.isArray(bg.css)
      ? `linear-gradient(${bg.css[0]}, ${bg.css[1]})`
      : bg.css;
    b.append(dot, document.createTextNode(bg.label));
    b.onclick = () => { prefs.bg = bg.id; renderBgSwatches(); render(); savePrefs(); };
    box.appendChild(b);
  }
}

function renderGender() {
  for (const b of $('genderSeg').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.g === prefs.gender);
  }
}

function renderOutfitChips() {
  const box = $('outfitChips');
  box.innerHTML = '';
  const list = [NONE_OUTFIT, CUSTOM_OUTFIT, ...outfitsFor(prefs.gender)];
  if (prefs.outfit !== 'none' && prefs.outfit !== 'custom' && !list.some(o => o.id === prefs.outfit)) {
    prefs.outfit = 'none';
  }
  for (const o of list) {
    const b = document.createElement('button');
    b.className = 'chip style-chip' + (o.id === prefs.outfit ? ' active' : '');
    b.innerHTML = `<span class="season">${o.season}</span>${o.label}`;
    b.onclick = () => {
      prefs.outfit = o.id; prefs.variantIdx = 0;
      if (o.id === 'custom' && !cloth.img) $('clothInput').click(); // 还没有衣服图，直接弹选择
      renderOutfitChips(); renderVariants(); ensureClothAndRender(); syncClothUI(); savePrefs();
    };
    box.appendChild(b);
  }
}

function renderVariants() {
  const box = $('variantChips');
  box.innerHTML = '';
  const o = currentOutfit();
  if (!o) return;
  if (prefs.variantIdx >= o.variants.length) prefs.variantIdx = 0;
  o.variants.forEach((v, idx) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (idx === prefs.variantIdx ? ' active' : '');
    b.title = v.label;
    const thumb = document.createElement('img');
    thumb.src = './assets/' + v.file;
    thumb.alt = v.label;
    b.appendChild(thumb);
    b.onclick = () => { prefs.variantIdx = idx; renderVariants(); ensureClothAndRender(); savePrefs(); };
    box.appendChild(b);
  });
}

function ensureClothAndRender() {
  const variant = currentVariant();
  if (!variant) { render(); return; }
  loadCloth(variant.file).then(() => render()).catch(e => show(e.message, 'error'));
}

$('genderSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-g]');
  if (!b) return;
  prefs.gender = b.dataset.g;
  const list = outfitsFor(prefs.gender);
  if (prefs.outfit !== 'none' && prefs.outfit !== 'custom' && !list.some(o => o.id === prefs.outfit)) {
    prefs.outfit = 'none';
  }
  prefs.variantIdx = 0;
  renderGender(); renderOutfitChips(); renderVariants(); ensureClothAndRender(); syncClothUI(); savePrefs();
});

$('shoulder').addEventListener('input', function () {
  prefs.shoulder = Number(this.value);
  $('shoulderVal').textContent = this.value + '%';
  render(); savePrefs();
});
$('outfitW').addEventListener('input', function () {
  prefs.outfitW = Number(this.value);
  $('outfitWVal').textContent = this.value + '%';
  render(); savePrefs();
});

$('fitBtn').onclick = () => { zoom = 1; dx = 0; dy = 0; render(); };

/* ---------- 自定义服装层控件 ---------- */

$('clothUploadBtn').onclick = () => $('clothInput').click();
$('clothInput').addEventListener('change', async function () {
  if (this.files && this.files[0]) {
    prefs.outfit = 'custom';
    renderOutfitChips();
    await loadClothImage(this.files[0]);
  }
  this.value = '';
});

$('layerSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layer]');
  if (!b) return;
  activeLayer = b.dataset.layer;
  syncClothUI();
});

$('clothScale').addEventListener('input', function () {
  cloth.scale = Number(this.value) / 100;
  $('clothScaleVal').textContent = this.value + '%';
  render();
});
$('clothRot').addEventListener('input', function () {
  cloth.rot = Number(this.value);
  $('clothRotVal').textContent = this.value + '°';
  render();
});
$('clothResetBtn').onclick = () => { resetClothTransform(); syncClothSliders(); render(); };
$('clothCutChk').addEventListener('change', function () {
  prefs.clothCutout = this.checked;
  recutCloth(false);
});
$('clothTol').addEventListener('input', function () {
  $('clothTolVal').textContent = this.value;
});
$('clothTol').addEventListener('change', function () {
  prefs.clothTol = Number(this.value);
  recutCloth(false);
  savePrefs();
});

/* ---------- 处理管线：载入 → 分割 → 对齐 → 编辑器 ---------- */

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
    await new Promise(r => requestAnimationFrame(r));
    await applySegmentation();
    segmented = true;
  } catch (e) {
    maskedCanvas = photoCanvas; // 分割失败 → 保留原背景继续用
    auto = null;
  }
  if (segmented) {
    busy(true, '人脸对齐…');
    faced = detectFace();
  } else {
    detectFace(); // 失败时产生兜底 auto
  }

  zoom = 1; dx = 0; dy = 0;
  showView('Editor');
  render();
  busy(false);
  if (!segmented) {
    show('抠图模型加载失败，已保留原背景（可检查网络后重拍重试）', 'error');
  } else if (!faced) {
    show('未检测到人脸，已按居中放置 —— 请拖动/双指缩放对齐', 'ok');
  } else {
    show('已自动对齐，可拖动/双指缩放微调', 'ok');
  }
  ensureClothAndRender();
}

/* ---------- 上传 / 示例照片 ---------- */

$('uploadBtn').onclick = () => $('fileInput').click();
$('reuploadBtn').onclick = () => $('fileInput').click();
$('fileInput').addEventListener('change', function () {
  if (this.files && this.files[0]) processPhoto(this.files[0]);
  this.value = '';
});

// 程序合成示例人像：纯色墙 + 人像（含旧衣服，测换装遮挡），也用于无摄像头环境验证
$('demoBtn').onclick = () => {
  const W = 700, H = 950;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const wall = ctx.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, '#e2e8ee');
  wall.addColorStop(1, '#ccd6de');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#7c8f9c'; // 肩膀（旧衣服）
  ctx.beginPath();
  ctx.moveTo(W * 0.24, H);
  ctx.quadraticCurveTo(W * 0.27, H * 0.72, W * 0.5, H * 0.68);
  ctx.quadraticCurveTo(W * 0.73, H * 0.72, W * 0.76, H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ddb490'; // 脖子
  ctx.fillRect(W * 0.455, H * 0.47, W * 0.09, H * 0.18);
  ctx.fillStyle = '#e8c39c'; // 头
  ctx.beginPath();
  ctx.ellipse(W * 0.5, H * 0.34, W * 0.155, H * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#332b28'; // 头发
  ctx.beginPath();
  ctx.ellipse(W * 0.5, H * 0.29, W * 0.158, H * 0.115, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(W * 0.345, H * 0.33, W * 0.02, H * 0.07, 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(W * 0.655, H * 0.33, W * 0.02, H * 0.07, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c2622'; // 眉
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(W * (0.5 + side * 0.06), H * 0.315, W * 0.045, H * 0.008, side * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#4a3830'; // 眼
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(W * (0.5 + side * 0.06), H * 0.345, W * 0.022, H * 0.014, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#b06a5a'; // 嘴
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(W * 0.5, H * 0.42, W * 0.05, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  processPhoto(c);
};

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
      : `摄像头需要 HTTPS 环境（当前页面不是安全上下文），请用 GitHub Pages 地址访问，或改用「相册选择」。`;
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
  compose(c.getContext('2d'), size.w, size.h, false); // 导出不含参考圈
  return c;
}

function fileName(ext) {
  const s = SIZES.find(x => x.id === prefs.size);
  const bg = BGS.find(b => b.id === prefs.bg);
  return `证件照_${s.label.split(' ')[0]}_${bg.label}_${s.w}x${s.h}.${ext}`;
}

$('downloadBtn').onclick = function () {
  const c = exportCanvas();
  if (!c) return;
  c.toBlob((blob) => {
    if (!blob) { show('导出失败：画布无法编码为 PNG', 'error'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName('png');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    flash(this, '已下载 ✓');
  }, 'image/png');
};

$('copyBtn').onclick = function () {
  const c = exportCanvas();
  if (!c) return;
  navigator.clipboard.write([new ClipboardItem({ 'image/png': new Promise(r => c.toBlob(r, 'image/png')) })])
    .then(() => flash(this, '已复制 ✓'))
    .catch(e => show(`复制图片失败（${e.message}），可用「下载 PNG」代替`, 'error'));
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
  sheet.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `六寸排版_${cols}x${rows}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }, 'image/png');
  flash(this, '已下载 ✓');
  show(`六寸相纸排了 ${cols} × ${rows} = ${cols * rows} 张，虚线为裁切线`, 'ok');
};

/* ---------- 初始化 ---------- */

(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.assign(prefs, saved);
  } catch (e) { /* 忽略 */ }
  if (prefs.outfit !== 'none' && prefs.outfit !== 'custom' && !OUTFITS.some(o => o.id === prefs.outfit)) {
    prefs.outfit = 'none';
  }

  renderGender(); renderOutfitChips(); renderVariants();
  renderSizeChips(); renderBgSwatches();
  $('shoulder').value = prefs.shoulder; $('shoulderVal').textContent = prefs.shoulder + '%';
  $('outfitW').value = prefs.outfitW; $('outfitWVal').textContent = prefs.outfitW + '%';
  $('clothTol').value = prefs.clothTol; $('clothTolVal').textContent = prefs.clothTol;
  syncClothUI();
})();

// 画面烧录字幕遮罩
//
// 目的：很多英语学习视频把英文字幕**烧进画面**了。眼睛盯着字幕看，其实是在做
// 阅读理解，听力一点没练到。这里把画面底部那一小条就地模糊掉，逼自己先听；
// 想核对原文时按住 Alt 临时揭开。
//
// 为什么用 backdrop-filter，而不是把视频帧画进 canvas：
//   遮罩只是一个盖在视频上的空 div，让合成器去模糊它背后的像素。
//   不复制视频帧、不逐帧重绘、播放/暂停/拖进度条都不用管它，
//   只有窗口尺寸变化时才需要重算一次位置。
//   （唯一的例外是「马赛克」—— CSS 没有像素化滤镜，那种样式才退回 canvas 逐帧画。）
//
// 两个必须算对的地方：
//   1. 视频是 object-fit: contain 的，画面外面还垫着黑边。遮罩必须贴在
//      **画面内容**的坐标系里算，否则一有黑边位置就整体偏掉。
//   2. 只覆盖画面内容底部约 8%，上下羽化。铺太宽会像一条脏横杠，
//      而且会挡住画面本身的底部信息。

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const MASK_STYLE_KEYS = ['soft', 'frosted', 'mosaic', 'solid'];

/** 遮罩的默认状态。enabled 默认关：不改变用户已有的使用习惯。 */
export const MASK_DEFAULTS = {
  enabled: false,
  style: 'soft',
  strength: 34,
  topRatio: 0.905,
  bottomRatio: 0.987,
  auto: true,
};

/* ---------------- 几何：画面内容区在哪 ---------------- */

/**
 * 视频**画面内容**（去掉 object-fit: contain 留下的黑边）相对 wrap 的位置，CSS px。
 * 拿不到尺寸（还没 loadedmetadata）时返回 null。
 */
export function contentBox(video, wrap) {
  const r = video.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh || !r.width || !r.height) return null;

  const mediaAspect = vw / vh;
  const boxAspect = r.width / r.height;
  let cw, ch;
  if (mediaAspect > boxAspect) { cw = r.width; ch = cw / mediaAspect; }   // 上下垫黑边
  else { ch = r.height; cw = ch * mediaAspect; }                          // 左右垫黑边

  return {
    x: (r.x - wr.x) + (r.width - cw) / 2,
    y: (r.y - wr.y) + (r.height - ch) / 2,
    w: cw,
    h: ch,
  };
}

/** 字幕带在 wrap 坐标系里的矩形 */
export function bandBox(video, wrap, topRatio, bottomRatio) {
  const c = contentBox(video, wrap);
  if (!c) return null;
  const t = clamp01(Math.min(topRatio, bottomRatio));
  const b = clamp01(Math.max(topRatio, bottomRatio));
  if (b - t < 0.01) return null;
  return {
    x: c.x,
    y: c.y + c.h * t,
    w: c.w,
    h: c.h * (b - t),
    content: c,
  };
}

/* ---------------- 样式表 ---------------- */

function backdropStyle(style, strength) {
  switch (style) {
    case 'frosted':
      // 模糊 + 轻微提亮，像贴了一块磨砂玻璃
      return {
        backdropFilter: `blur(${strength + 8}px) saturate(1.02) brightness(1.06)`,
        background: 'rgba(255,255,255,0.07)',
      };
    case 'solid':
      // 完全盖死。
      // 这里踩过一次坑：原本用 rgba(...,0.94)，算下来白字幕还有 10% 透光；
      // 改成 0.984 后实测透过率仍有 6.7%（白字亮度 252 → 17）。数值上很小，
      // 但在大片均匀暗色上，4 个灰阶的差就足以让人认出字形。
      // 「纯色」就该是纯色，直接 alpha = 1，数学上不可能透。
      return { backdropFilter: 'none', background: 'rgb(10,13,18)' };
    case 'mosaic':
      // 由 canvas 负责，这里不设 backdrop-filter
      return { backdropFilter: 'none', background: 'transparent' };
    case 'soft':
    default:
      return {
        backdropFilter: `blur(${strength}px) saturate(0.92) brightness(0.94)`,
        background: 'rgba(8,10,14,0.10)',
      };
  }
}

// 羽化只占带高的很小一段。
// 教训：一开始开到 30%/70%，结果字幕正好落在羽化区里 —— 笔画上半截没被糊干净，
// 留下一排黑点，比不遮还难看。现在只有边缘 14% 是过渡区，文字主体一定在
// 「完全模糊」的范围内。
const FEATHER = 'linear-gradient(to bottom, transparent 0%, #000 14%, #000 86%, transparent 100%)';

/* ---------------- 遮罩控制器 ---------------- */

/**
 * 在 wrap 里建一个遮罩层（以及马赛克用的 canvas 和提示条）。
 * 这些元素都由本模块自己创建，不依赖 index.html —— 老 HTML + 新 JS 的
 * 混搭场景下也不会因为找不到元素而在启动阶段抛异常。
 */
export function createMask({ wrap, video }) {
  const layer = document.createElement('div');
  layer.className = 'submask';
  layer.hidden = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'submask-canvas';
  canvas.hidden = true;

  const chip = document.createElement('div');
  chip.className = 'submask-chip';
  chip.hidden = true;

  const small = document.createElement('canvas');   // 马赛克用的中转小图
  const sctx = small.getContext('2d', { willReadFrequently: false });

  let state = { ...MASK_DEFAULTS };
  let box = null;
  let mosaicRaf = 0;
  let lastVideoTime = -1;

  wrap.appendChild(layer);
  wrap.appendChild(canvas);
  wrap.appendChild(chip);

  function applyStyles() {
    const st = backdropStyle(state.style, state.strength);
    layer.style.backdropFilter = st.backdropFilter;
    layer.style.webkitBackdropFilter = st.backdropFilter;
    layer.style.background = st.background;
    layer.style.maskImage = FEATHER;
    layer.style.webkitMaskImage = FEATHER;

    const useCanvas = state.style === 'mosaic' && state.enabled;
    canvas.hidden = !useCanvas;
    layer.hidden = !state.enabled || useCanvas;
    chip.hidden = !state.enabled;
  }

  /** 重算位置。窗口缩放、进出全屏、换视频都要调一次。 */
  function reposition() {
    box = bandBox(video, wrap, state.topRatio, state.bottomRatio);
    if (!box) { layer.hidden = true; canvas.hidden = true; chip.hidden = true; return; }
    const left = box.x + box.w * 0.015;
    const width = box.w * 0.97;
    Object.assign(layer.style, {
      left: left + 'px', width: width + 'px', top: box.y + 'px', height: box.h + 'px',
    });
    Object.assign(canvas.style, {
      left: left + 'px', width: width + 'px', top: box.y + 'px', height: box.h + 'px',
    });
    // 提示条钉在字幕带正上方，避免本身就挡住要遮的东西
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(box.h * dpr));
    chip.style.left = (box.x + box.w * 0.02) + 'px';
    chip.style.top = Math.max(box.y - 34, 4) + 'px';
    chip.hidden = !state.enabled;
    applyStyles();
    drawMosaic(true);
  }

  /** 马赛克：把视频里对应的那一条画到小 canvas，再无插值放大贴回来 */
  function drawMosaic(force) {
    if (!state.enabled || state.style !== 'mosaic' || !box) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    if (!force && video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const sx = 0;
    const sy = Math.round(state.topRatio * vh);
    const sw = vw;
    const sh = Math.max(1, Math.round((state.bottomRatio - state.topRatio) * vh));

    const cols = 28;
    const rows = Math.max(2, Math.round(cols * (sh / sw)));
    if (small.width !== cols || small.height !== rows) { small.width = cols; small.height = rows; }
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(video, sx, sy, sw, sh, 0, 0, cols, rows);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  }

  function loopMosaic() {
    if (!state.enabled || state.style !== 'mosaic') { mosaicRaf = 0; return; }
    drawMosaic(false);
    mosaicRaf = requestAnimationFrame(loopMosaic);
  }

  // 播放时逐帧重画马赛克；暂停时画一次就够
  const onPlay = () => { if (state.enabled && state.style === 'mosaic' && !mosaicRaf) loopMosaic(); };
  const onPause = () => drawMosaic(true);
  const onSeeked = () => drawMosaic(true);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('loadedmetadata', reposition);

  const ro = ('ResizeObserver' in window) ? new ResizeObserver(() => reposition()) : null;
  if (ro) { ro.observe(wrap); ro.observe(video); }
  window.addEventListener('resize', reposition);

  return {
    get state() { return state; },
    get box() { return box; },

    /** 更新状态（部分字段即可），返回是否真的变了 */
    setState(patch) {
      const before = JSON.stringify({ ...state, ...patch });
      state = { ...state, ...patch };
      applyStyles();
      reposition();
      if (state.enabled && state.style === 'mosaic' && !mosaicRaf) loopMosaic();
      return before !== JSON.stringify(state);
    },

    /** 临时揭开原文（按住 Alt 时用） */
    peek(on) {
      layer.classList.toggle('peek', !!on);
      canvas.classList.toggle('peek', !!on);
      chip.classList.toggle('peek', !!on);
    },

    setChipText(s) { chip.textContent = s; },

    reposition,

    destroy() {
      if (mosaicRaf) cancelAnimationFrame(mosaicRaf);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', reposition);
      window.removeEventListener('resize', reposition);
      ro?.disconnect();
      layer.remove(); canvas.remove(); chip.remove();
    },
  };
}

/* ---------------- 自动定位字幕带 ----------------
   思路：不看「哪里有字」，而是看「哪一行的像素既像文字、又会随时间变化」。
   逐行累计三个特征：

     edge   横向梯度能量 —— 文字笔画有大量横向明暗跳变，平坦背景没有
     change 与第一帧的差异 —— 字幕每几秒换一次，画面背景变得慢
     var    行内亮度方差 —— 文字行同时有前景和背景，方差天然偏高

   三者归一化后加权。再限制在画面下半部找（字幕极少出现在上半部），
   取最高分附近的连续区间。置信度不够就返回 null，让调用方保留默认带。
------------------------------------------------- */

export function createBandDetector({ maxFrames = 90, width = 320, height = 180 } = {}) {
  let frames = 0;
  let first = null;
  let edgeSum = null;
  let changeSum = null;
  let varSum = null;
  let W = 0, H = 0;

  function reset() {
    frames = 0; first = null; edgeSum = null; changeSum = null; varSum = null;
  }

  /** @param {Uint8ClampedArray} gray 灰度像素，长度 W*H */
  function push(gray, w, h) {
    if (frames >= maxFrames) return false;
    W = w; H = h;
    if (!edgeSum) {
      edgeSum = new Float64Array(h);
      changeSum = new Float64Array(h);
      varSum = new Float64Array(h);
    }
    if (!first) first = Uint8ClampedArray.from(gray);

    const x0 = Math.floor(w * 0.12);        // 左右各留一点，避开台标/水印
    const x1 = Math.ceil(w * 0.88);

    for (let y = 0; y < h; y++) {
      const base = y * w;
      let edge = 0, sum = 0, sum2 = 0, change = 0, n = 0;
      for (let x = x0; x < x1; x++) {
        const v = gray[base + x];
        edge += Math.abs(gray[base + x + 1] - v);
        change += Math.abs(v - first[base + x]);
        sum += v; sum2 += v * v; n++;
      }
      if (!n) continue;
      const mean = sum / n;
      edgeSum[y] += edge / n;
      changeSum[y] += change / n;
      varSum[y] += (sum2 / n) - mean * mean;
    }
    frames++;
    return true;
  }

  function result() {
    if (frames < 8 || !edgeSum) return null;

    // 只看画面下半部：字幕极少跑到上半部去
    const yStart = Math.floor(H * 0.52);
    const norm = (arr) => {
      let max = 0;
      for (let y = yStart; y < H; y++) max = Math.max(max, arr[y]);
      return max > 1e-6 ? 1 / max : 0;
    };
    const eN = norm(edgeSum), cN = norm(changeSum), vN = norm(varSum);

    const score = new Float64Array(H);
    let best = yStart, bestVal = -1, sum = 0, cnt = 0;
    for (let y = yStart; y < H; y++) {
      const s = 0.45 * edgeSum[y] * eN + 0.35 * changeSum[y] * cN + 0.20 * varSum[y] * vN;
      score[y] = s;
      sum += s; cnt++;
      if (s > bestVal) { bestVal = s; best = y; }
    }
    const mean = sum / Math.max(1, cnt);
    // 峰值不够突出 → 这一段视频大概压根没有烧录字幕
    if (bestVal < mean * 1.9 || bestVal <= 0) return null;

    const thr = bestVal * 0.42;
    let lo = best, hi = best;
    while (lo > yStart && score[lo - 1] >= thr) lo--;
    while (hi < H - 1 && score[hi + 1] >= thr) hi++;
    // 上下各留一点余量，再收进画面的 52%~100%
    lo = Math.max(yStart, lo - 3);
    hi = Math.min(H - 1, hi + 3);

    const topRatio = +(lo / H).toFixed(4);
    const bottomRatio = +((hi + 1) / H).toFixed(4);
    if (bottomRatio - topRatio < 0.025) return null;   // 太窄，多半是噪声
    if (bottomRatio - topRatio > 0.22) return null;    // 太宽，多半把画面当字幕了

    return { topRatio, bottomRatio, confidence: +(bestVal / (mean || 1)).toFixed(2), frames };
  }

  return { push, result, reset, get frames() { return frames; }, get size() { return { W, H }; } };
}

/** 从 video 当前帧抓一张小灰度图，喂给检测器。返回 false 表示这一帧没抓到。 */
export function grabGrayFrame(video, detector, canvas) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return false;
  const { W, H } = detector.size.W ? detector.size : { W: 0, H: 0 };
  const w = W || 320;
  const h = H || Math.max(2, Math.round((w * vh) / vw));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // 整数权重的亮度近似，比 0.299/0.587/0.114 的浮点乘法快
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return detector.push(gray, w, h);
}

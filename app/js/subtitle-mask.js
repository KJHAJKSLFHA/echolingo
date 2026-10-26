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
export function createMask({ wrap, video, onBand = null }) {
  const layer = document.createElement('div');
  layer.className = 'submask';
  layer.hidden = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'submask-canvas';
  canvas.hidden = true;

  const chip = document.createElement('div');
  chip.className = 'submask-chip tappable';
  chip.hidden = true;
  // 触屏设备没有 Alt 键，伸不到「按住看原文」；点一下 chip 切换即可。
  // 用 pointerdown 而不是 click：视频区有拖动/双击，click 会被那套手势吃掉。
  let peeking = false;
  /** 真正落地 peek 状态的地方：键盘 Alt 与触摸点击都汇到这里 */
  function self_peek(on) {
    peeking = !!on;
    layer.classList.toggle('peek', peeking);
    canvas.classList.toggle('peek', peeking);
    chip.classList.toggle('peek', peeking);
  }
  chip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    self_peek(!peeking);
  });

  // 「在画面上调整位置」的编辑层：虚线框 + 上下两条抓手 + 一句提示。
  // 同样由本模块自建，老 HTML 也不会缺元素。
  const edit = document.createElement('div');
  edit.className = 'submask-edit';
  edit.hidden = true;
  const editBox = document.createElement('div');
  editBox.className = 'submask-edit-box';
  const gripTop = document.createElement('div');
  gripTop.className = 'submask-edit-grip top';
  const gripBot = document.createElement('div');
  gripBot.className = 'submask-edit-grip bottom';
  const editHint = document.createElement('div');
  editHint.className = 'submask-edit-hint';
  // 「完成」放在画面上而不是只放设置面板里 —— 进调整态时面板会收起来，
  // 不然用户拖完就没有出口了。
  const editDone = document.createElement('button');
  editDone.type = 'button';
  editDone.className = 'submask-edit-done';
  editDone.textContent = '完成';
  editDone.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onBand?.({ phase: 'done' });
  });
  editBox.append(gripTop, gripBot);
  edit.append(editBox, editHint, editDone);

  const small = document.createElement('canvas');   // 马赛克用的中转小图
  const sctx = small.getContext('2d', { willReadFrequently: false });

  let state = { ...MASK_DEFAULTS };
  let box = null;
  let mosaicRaf = 0;
  let lastVideoTime = -1;
  let editing = false;
  let drag = null;

  wrap.appendChild(layer);
  wrap.appendChild(canvas);
  wrap.appendChild(chip);
  wrap.appendChild(edit);

  /** 该不该显示遮罩：开着就要，正在调整时也要（否则看不见自己在拖什么） */
  const live = () => state.enabled || editing;

  function applyStyles() {
    const st = backdropStyle(state.style, state.strength);
    layer.style.backdropFilter = st.backdropFilter;
    layer.style.webkitBackdropFilter = st.backdropFilter;
    layer.style.background = st.background;
    layer.style.maskImage = FEATHER;
    layer.style.webkitMaskImage = FEATHER;

    const on = live();
    const useCanvas = state.style === 'mosaic' && on;
    canvas.hidden = !useCanvas;
    layer.hidden = !on || useCanvas;
    chip.hidden = !state.enabled || editing;   // 调整位置时让位给编辑提示
  }

  /** 重算位置。窗口缩放、进出全屏、换视频都要调一次。 */
  function reposition() {
    box = bandBox(video, wrap, state.topRatio, state.bottomRatio);
    if (!box) {
      layer.hidden = true; canvas.hidden = true; chip.hidden = true;
      editBox.style.display = 'none';
      return;
    }
    editBox.style.display = '';
    const left = box.x + box.w * 0.015;
    const width = box.w * 0.97;
    Object.assign(layer.style, {
      left: left + 'px', width: width + 'px', top: box.y + 'px', height: box.h + 'px',
    });
    Object.assign(canvas.style, {
      left: left + 'px', width: width + 'px', top: box.y + 'px', height: box.h + 'px',
    });
    // 编辑框跟遮罩对齐，看起来就是同一条
    Object.assign(editBox.style, {
      left: left + 'px', width: width + 'px', top: box.y + 'px', height: box.h + 'px',
    });
    // 提示条钉在字幕带正上方，避免本身就挡住要遮的东西
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(box.h * dpr));
    chip.style.left = (box.x + box.w * 0.02) + 'px';
    chip.style.top = Math.max(box.y - 34, 4) + 'px';
    chip.hidden = !state.enabled;
    editHint.style.left = (box.x + box.w * 0.02) + 'px';
    editHint.style.top = Math.max(box.y - 30, 4) + 'px';
    applyStyles();
    drawMosaic(true);
  }

  /** 马赛克：把视频里对应的那一条画到小 canvas，再无插值放大贴回来 */
  function drawMosaic(force) {
    if (!live() || state.style !== 'mosaic' || !box) return;
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
    if (!live() || state.style !== 'mosaic') { mosaicRaf = 0; return; }
    drawMosaic(false);
    mosaicRaf = requestAnimationFrame(loopMosaic);
  }

  // 播放时逐帧重画马赛克；暂停时画一次就够
  const onPlay = () => { if (live() && state.style === 'mosaic' && !mosaicRaf) loopMosaic(); };
  const onPause = () => drawMosaic(true);
  const onSeeked = () => drawMosaic(true);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('loadedmetadata', reposition);

  const ro = ('ResizeObserver' in window) ? new ResizeObserver(() => reposition()) : null;
  if (ro) { ro.observe(wrap); ro.observe(video); }
  window.addEventListener('resize', reposition);

  /* ---- 在画面上拖动调整位置 ---- */

  const MIN_H = 0.02;   // 允许的最小带高（画面的 2%）
  // 可移动的范围。必须和设置面板里两条滑杆的 min/max 完全一致
  // （#setMaskTop 5~97、#setMaskBottom 8~100），否则拖到一个位置、
  // 滑杆却显示另一个位置，用户会以为没生效。
  const BAND_MIN_TOP = 0.05;
  const BAND_MAX_TOP = 0.97;
  const BAND_MIN_BOTTOM = 0.08;
  const BAND_MAX_BOTTOM = 1;

  /** 更新状态（部分字段即可），返回是否真的变了 */
  function applyState(patch) {
    const before = JSON.stringify({ ...state, ...patch });
    state = { ...state, ...patch };
    applyStyles();
    reposition();
    if (live() && state.style === 'mosaic' && !mosaicRaf) loopMosaic();
    return before !== JSON.stringify(state);
  }

  function onEditDown(e) {
    if (!editing) return;
    const mode = e.target === gripTop ? 'top' : e.target === gripBot ? 'bottom' : 'move';
    if (mode === 'move' && e.target !== editBox) return;   // 提示文字等不该拖动
    drag = { mode, startY: e.clientY, top: state.topRatio, bottom: state.bottomRatio };
    try { editBox.setPointerCapture(e.pointerId); } catch { /* 老浏览器没有也无妨 */ }
    e.preventDefault();
    e.stopPropagation();
  }

  function onEditMove(e) {
    if (!drag || !editing) return;
    const c = contentBox(video, wrap);
    if (!c) return;
    const dy = (e.clientY - drag.startY) / c.h;   // 屏幕位移 → 画面比例
    let t = drag.top, b = drag.bottom;
    if (drag.mode === 'move') {
      t = drag.top + dy;
      b = drag.bottom + dy;
      if (t < BAND_MIN_TOP) { b += BAND_MIN_TOP - t; t = BAND_MIN_TOP; }   // 顶到上边缘就整体停住，带高不变
      if (b > BAND_MAX_BOTTOM) { t -= b - BAND_MAX_BOTTOM; b = BAND_MAX_BOTTOM; }
    } else if (drag.mode === 'top') {
      t = Math.min(drag.top + dy, b - MIN_H);
    } else {
      b = Math.max(drag.bottom + dy, t + MIN_H);
    }
    t = Math.max(BAND_MIN_TOP, Math.min(t, BAND_MAX_TOP));
    b = Math.max(BAND_MIN_BOTTOM, Math.min(b, BAND_MAX_BOTTOM));
    if (b - t < MIN_H) return;
    applyState({ topRatio: +t.toFixed(4), bottomRatio: +b.toFixed(4) });
    onBand?.({ phase: 'move', topRatio: state.topRatio, bottomRatio: state.bottomRatio });
    e.preventDefault();
  }

  function onEditUp(e) {
    if (!drag) return;
    drag = null;
    try { editBox.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
    onBand?.({ phase: 'end', topRatio: state.topRatio, bottomRatio: state.bottomRatio });
  }

  // 拖动过程中指针可能跑出画布，所以 move/up 挂在 window 上，
  // 不依赖 pointer capture（capture 只是为了让光标保持抓取样式）。
  edit.addEventListener('pointerdown', onEditDown);
  window.addEventListener('pointermove', onEditMove);
  window.addEventListener('pointerup', onEditUp);
  window.addEventListener('pointercancel', onEditUp);

  return {
    get state() { return state; },
    get box() { return box; },
    get editing() { return editing; },

    setState: applyState,

    /** 进出「在画面上调整位置」模式 */
    setEditing(on) {
      editing = !!on;
      edit.hidden = !editing;
      if (!editing) drag = null;
      applyStyles();
      reposition();
      if (editing && state.style === 'mosaic' && !mosaicRaf) loopMosaic();
    },

    setEditHint(s) { editHint.textContent = s || ''; },
    setDoneLabel(s) { editDone.textContent = s || ''; },

    /** 拿屏幕坐标换算出的新位置（测试与外部程序化拖动用） */
    dragBy(mode, dyRatio) {
      const c = contentBox(video, wrap);
      if (!c) return null;
      drag = { mode, startY: 0, top: state.topRatio, bottom: state.bottomRatio };
      onEditMove({ clientY: dyRatio * c.h, preventDefault() {} });
      drag = null;
      onBand?.({ phase: 'end', topRatio: state.topRatio, bottomRatio: state.bottomRatio });
      return { topRatio: state.topRatio, bottomRatio: state.bottomRatio };
    },

    /** 临时揭开原文（按住 Alt 时用；触屏点 chip 也走这里） */
    peek(on) {
      peeking = !!on;
      self_peek(peeking);
    },

    setChipText(s) {
      chip.textContent = s;
      // 换句就把「点开看原文」收回：否则点过一次之后整段视频都摊开着，
      // 遮挡等于被永久关掉了。
      if (peeking) self_peek(false);
    },

    reposition,

    destroy() {
      if (mosaicRaf) cancelAnimationFrame(mosaicRaf);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', reposition);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('pointermove', onEditMove);
      window.removeEventListener('pointerup', onEditUp);
      window.removeEventListener('pointercancel', onEditUp);
      ro?.disconnect();
      layer.remove(); canvas.remove(); chip.remove(); edit.remove();
    },
  };
}

/* ---------------- 自动定位字幕带 ----------------
   思路：不看「哪里有字」，而是看「哪一行的像素既像文字、又会随时间变化」。
   逐行累计三个特征：

     edge   横向梯度能量 —— 文字笔画有大量横向明暗跳变，平坦背景没有
     change 与第一帧的差异 —— 字幕每几秒换一次，画面背景变得慢
     var    行内亮度方差 —— 文字行同时有前景和背景，方差天然偏高

   三者**各自做稳健标准化**（中位数 / MAD，不是除以全局最大值）后加权，
   再限制在画面下半部找（字幕极少出现在上半部），取最高分附近的连续区间，
   中间允许跨过几行空隙（两行字幕之间的那条缝）。不够自信就返回 null，
   让调用方保留默认带。

   ⚠ 为什么不能用「除以全局最大值」—— 2026-10-13 那条西语 Vlog 的真事故：
     手持镜头拍的水面、慢摇镜头这类画面里，change 在**每一行**都很大。
     全局归一化下，整段搜索区的得分会被一起抬到峰值附近。实测那次：
       · 峰值 0.963 其实**找对了**（行 161，画面高度 89.4%，正是字幕）
       · 但搜索区 87 行里有 80 行的得分 ≥ 0.42×峰值
       · 于是「连续高分区」一路长到 lo=93 / hi=172（占画面高 44%）
       · 被「太宽」（>22%）的自检打回 → 结论「没找到烧录字幕」，遮罩留在默认位置
     换句话说：**峰值定位没问题，是「从峰值往外长」这一步被背景淹了**。
     中位数/MAD 问的是「这一行比典型行突出多少」：烧录字幕只占百分之十几的行，
     典型行必然是背景，水面再晃也会被减掉。
------------------------------------------------- */

// 从峰值往外长时，最多允许连续几行不达标（用来跨过两行字幕中间的空隙）
const BAND_GAP = 4;

/* 打分与定带拆成两个纯函数（导出只为测试）：
   bench/test-band-detect.mjs 除了喂合成帧，还会把**真实录下来的剖面**
   （bench/fixtures/mask-profile-vlog.json，那条找不到字幕的西语 Vlog）
   原样重放一遍 —— 真素材不适合当回归测试（900MB），但剖面只有几 KB。 */

/** 一组数的稳健尺度：中位数 + MAD（×1.4826 折算成标准差量级）。 */
function robustOf(values) {
  const v = values.slice().sort((a, b) => a - b);
  const med = v[v.length >> 1];
  const dev = v.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  let scale = dev[dev.length >> 1] * 1.4826;
  // MAD 下限：不允许把「比典型值高不到 2%」的抖动放大成几十个 σ。
  // 少了这一句，一段几乎均匀的画面里随便一行的微小抖动就能刷出很高的 z，
  // 于是「没字幕」被误判成「有字幕」。
  if (scale < med * 0.02) scale = med * 0.02;
  // 中位数本身也是 0（整段全黑之类）：退一步用「最大值离中位数多远」估。
  // 仍为 0 就是这一路特征在这个视频里毫无信息量，后面 z 一律记 0。
  if (scale < 1e-6) scale = (v[v.length - 1] - med) / 3;
  return { med, scale };
}

/**
 * 逐行打分。三个特征各自做稳健标准化后加权。
 * @param {ArrayLike<number>} edge     逐行横向梯度能量
 * @param {ArrayLike<number>} change   逐行「与第一帧的差异」
 * @param {ArrayLike<number>} variance 逐行行内亮度方差
 * @param {number} H 画面高（检测分辨率下）
 * @returns {{yStart:number, score:Float64Array, best:number, bestVal:number, bg:number, H:number}}
 */
export function scoreRows(edge, change, variance, H) {
  const yStart = Math.floor(H * 0.52);          // 只看下半部
  const half = (arr) => { const v = []; for (let y = yStart; y < H; y++) v.push(arr[y]); return v; };
  const se = robustOf(half(edge)), sc = robustOf(half(change)), sv = robustOf(half(variance));
  const zOf = (s, v) => (s.scale > 1e-6 ? Math.max(0, (v - s.med) / s.scale) : 0);

  const score = new Float64Array(H);
  let best = yStart, bestVal = -1;
  for (let y = yStart; y < H; y++) {
    score[y] = 0.45 * zOf(se, edge[y]) + 0.35 * zOf(sc, change[y]) + 0.20 * zOf(sv, variance[y]);
    if (score[y] > bestVal) { bestVal = score[y]; best = y; }
  }
  const sorted = half(score).sort((a, b) => a - b);
  return { yStart, score, best, bestVal, bg: sorted[sorted.length >> 1], H };
}

/**
 * 从打分结果定出字幕带边界；不自信就返回 null（调用方保留默认位置）。
 * @returns {{topRatio:number, bottomRatio:number, confidence:number}|null}
 */
export function bandFromScore({ score, best, bestVal, bg, yStart, H }) {
  // 峰值必须明显高出「典型行」，否则这段视频大概压根没有烧录字幕。
  // 单位是稳健标准差（z），不是百分比：6 表示比典型行高 6 个稳健 σ。
  if (bestVal - bg < 6) return null;

  // 从峰值往外长，中途允许跨过 BAND_GAP 行空隙（两行字幕之间的缝）。
  const thr = bg + (bestVal - bg) * 0.32;
  let lo = best, hi = best, miss = 0;
  for (let y = best - 1; y >= yStart; y--) {
    if (score[y] >= thr) { lo = y; miss = 0; }
    else if (++miss > BAND_GAP) break;
  }
  miss = 0;
  for (let y = best + 1; y < H; y++) {
    if (score[y] >= thr) { hi = y; miss = 0; }
    else if (++miss > BAND_GAP) break;
  }
  // 上下各留一点余量，再收进画面的 52%~100%
  lo = Math.max(yStart, lo - 3);
  hi = Math.min(H - 1, hi + 3);

  const topRatio = +(lo / H).toFixed(4);
  const bottomRatio = +((hi + 1) / H).toFixed(4);
  if (bottomRatio - topRatio < 0.025) return null;   // 太窄，多半是噪声
  if (bottomRatio - topRatio > 0.22) return null;    // 太宽，多半把画面当字幕了

  return { topRatio, bottomRatio, confidence: +(bestVal - bg).toFixed(2) };
}

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

  /** 逐行得分。result() 与 profile() 共用，免得诊断用的剖面和真正做判断的
      算法各走各的；打分本身在模块级的 scoreRows() 里（纯函数，可测）。 */
  function compute() {
    if (frames < 8 || !edgeSum) return null;
    return scoreRows(edgeSum, changeSum, varSum, H);
  }

  function result() {
    const c = compute();
    if (!c) return null;
    const band = bandFromScore(c);
    return band ? { ...band, frames } : null;
  }

  /** 诊断用：把逐行原始特征与得分原样交出来，专门用来查「为什么没找到」。
      bench/probe-mask-detect.mjs 靠它打印逐行剖面。 */
  function profile() {
    const c = compute();
    if (!c) return null;
    return {
      frames, W, H, yStart: c.yStart, best: c.best,
      bestVal: +c.bestVal.toFixed(5), bg: +c.bg.toFixed(5),
      prominence: +(c.bestVal - c.bg).toFixed(3),
      edge: Array.from(edgeSum), change: Array.from(changeSum),
      variance: Array.from(varSum), score: Array.from(c.score),
    };
  }

  return { push, result, profile, reset, get frames() { return frames; }, get size() { return { W, H }; } };
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

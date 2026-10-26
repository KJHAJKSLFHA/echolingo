// EchoLingo · 回声语言 — 主控制器

import {
  $, $$, el, fmtTime, clamp, escapeHtml, hashStr, debounce,
  toast, download, openDB, idbAll, idbPut, idbDelete, idbClear,
} from './util.js';
import { initLang, setLang, getLang, t, onLangChange, nextLang, LANG_SHORT } from './i18n.js';
import {
  MODEL_FILES, availableASRModels, modelMeta, resolveASRModel, DEFAULT_ASR_MODEL, modelLang,
  LS_ASR_CACHED, LS_MT_CACHED, isModelCached, markModelCached,
} from './models.js';
import * as DICT from './dict.js';
import * as TTS from './tts.js';
import * as SUB from './subtitle.js';
import * as SUBMASK from './subtitle-mask.js';
import * as ASR from './asr.js';
import * as MT from './mt.js';
import * as SRS from './srs.js';

// 与 index.html 里的 window.__ECHOLINGO_VER__ 必须保持一致。
// 改这两个值时请一起改（sw.js 的 VERSION 也顺手升一级）。
export const APP_VER = '3.17.0';

/* ============================ 状态 ============================ */

const S = {
  cues: [],
  activeIdx: -1,
  name: '',
  view: 'all',
  loop: false,
  stopAt: null,
  busy: null,          // 'asr' | 'mt' | null
  transAbort: null,
  asrRun: 0,           // 识别任务代号：换文件/导入字幕时自增，作废进行中的任务
  recog: false,        // 是否正在识别（右侧面板据此显示进行态）
  db: null,
  favWords: new Map(),
  favSentences: new Map(),
  favTab: 'words',
  cueEls: [],
  asrModels: [],       // 本机实际存在的识别模型 id
  asrModel: '',        // 当前使用的识别模型 id
  recogLang: null,     // 现有字幕是**按哪种语言**识别出来的（切模式时用来判断要不要问「重新识别」）
  modelSwitched: false,// 用户是否手动切过模型（切过就不再做开机预热）
  settings: {
    // 朗读音色按语言各记一个：英语模式和西语模式用的是两套完全不同的音色，
    // 共用一个槽位的话每切一次模式都要重选，语音还会串味。
    voiceEn: '', voiceEs: '', ttsRate: 0.95, fontSize: 18, autoScroll: true,
    markWords: true, transMode: 'local', wordTs: 'auto', autoRun: true,
    karaoke: true, asrModel: '',
    // 查词时暂停；是否恢复由「打开前是否在播 + 中途是否自己暂停」决定，不无条件续播
    pauseOnLookup: true,
    // 右侧两列可以分别收起。练听力时不想被英文剧透就关掉英文，
    // 只想听不想看中文就关掉中文 —— 比把译文弄模糊更干脆。
    // showMid 是西语模式多出来的「英文翻译」那一行，英语模式下没有这一行。
    showEn: true, showMid: true, showZh: true,
    // 复习：三选一；语言列与自动朗读独立记忆
    reviewShowZh: true, reviewShowEn: true, reviewAutoSpeak: true,
    // 学习语言模式（左上角 English / Español）：决定识别模型与翻译链。
    mode: 'en',
    // 画面烧录字幕遮罩。默认关：不改变用户已有的使用习惯。
    mask: { ...SUBMASK.MASK_DEFAULTS },
  },
  themePref: 'auto',   // 'light' | 'dark' | 'auto'
  wordCardFor: null,
  rafId: 0,
  lastUserScroll: 0,
  // 用户主动滚动后暂停跟随；只有点「回到当前句」才恢复
  followPaused: false,
  // 词卡打开前的播放状态与「用户是否在中途自己暂停过」
  wordCardPause: null,
  // 最近学习记录与当前会话主键
  recent: [],
  sessionKey: '',
  mediaPending: false,
  pendingHandleKey: null,
  pendingHandleHasApi: false,
  // 当前真实任务的取消句柄与失败信息
  jobAbort: null,
  lastFail: null,
  lastStatus: null,
  resumeAt: 0,
  jobStage: null,
  // 复习会话。queue 在开始时一次定好，中途答对答错都不会往里加东西 ——
  // 边复习边追加会让「还剩几条」变成一直在变的数字，看不到头。
  review: null,        // { queue, idx, ok, bad, revealed, tab, lang }
};

const LS_KEY = 'echolingo.settings.v1';
const LS_THEME = 'echolingo.theme';
const LS_SESSION = 'echolingo.session.v1';
const LS_RECENT = 'echolingo.recent.v1';
const LS_SESSION_PREFIX = 'echolingo.session.v2:';
const RECENT_MAX = 8;
const SESSION_BYTES_MAX = 3_500_000;   // 单条字幕/词时间戳的保守上限
const RECENT_BYTES_MAX = 12_000_000;   // 所有记录的本地预算

/* ============================ 启动 ============================ */

/* ============================ 激活（一次性付费 · 永久可用） ============================ */
// 校验完全在本机完成（app/js/license.js），不联网、不上报。填错只提示，不锁死。
const SELLER_WX = 'Orion';   // ← 显示在激活窗里的微信号
let LIC_ON = false;

function licenseOk() {
  try { return !!(window.ECLicense && ECLicense.state().active); } catch (e) { return false; }
}

/** 未激活时挡住功能并弹出激活窗；返回是否已激活 */
function needLicense() {
  if (licenseOk()) return true;
  openGate();
  toast(t('gate.need'));
  return false;
}

function openGate() {
  const g = $('#gateOverlay');
  if (!g) return;
  g.hidden = false;
  const c = $('#gateContact');
  if (c) c.textContent = t('gate.contact').replace('{wx}', SELLER_WX);
  const box = $('#gateCode');
  if (box) setTimeout(() => box.focus(), 80);
}

function closeGate() {
  const g = $('#gateOverlay');
  if (g) g.hidden = true;
}

function formatCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20);
  return s.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function initLicense() {
  LIC_ON = licenseOk();
  if (LIC_ON) { closeGate(); return; }
  openGate();

  const box = $('#gateCode');
  const go = $('#gateGo');
  const note = $('#gateNote');
  if (!box || !go || !note) return;

  const say = (text, cls) => {
    note.textContent = text;
    note.classList.toggle('bad', cls === 'bad');
    note.classList.toggle('ok', cls === 'ok');
  };

  const submit = () => {
    const code = formatCode(box.value);
    if (!code || code.replace(/-/g, '').length < 20) {
      box.setAttribute('aria-invalid', 'true');
      say(t('gate.invalid'), 'bad');
      return;
    }
    go.disabled = true;
    const label = go.textContent;
    go.textContent = t('gate.activating');
    const r = window.ECLicense ? ECLicense.activate(code) : { ok: false, reason: 'invalid' };
    if (r.ok) {
      LIC_ON = true;
      box.removeAttribute('aria-invalid');
      say(t('gate.ok'), 'ok');
      setTimeout(() => {
        closeGate();
        toast(t('gate.ok'));
        go.disabled = false;
        go.textContent = label;
      }, 420);
      return;
    }
    go.disabled = false;
    go.textContent = label;
    box.setAttribute('aria-invalid', 'true');
    say(r.reason === 'storage' ? t('gate.storage') : t('gate.invalid'), 'bad');
  };

  // 弹窗自己的语言切换：客户扫完码看不懂中文，就地换语言
  const langBtns = Array.from(document.querySelectorAll('[data-gate-lang]'));
  const paintLang = () => {
    langBtns.forEach((b) => b.classList.toggle('active', b.dataset.gateLang === getLang()));
    const c = $('#gateContact');
    if (c) c.textContent = t('gate.contact').replace('{wx}', SELLER_WX);
  };
  langBtns.forEach((b) => {
    b.addEventListener('click', () => {
      setLang(b.dataset.gateLang);
      paintLang();
      if (note.getAttribute('aria-live') === null) note.setAttribute('aria-live', 'polite');
    });
  });
  // 换语言后把提示回到「格式说明」，免得残留上一种语言的报错
  onLangChange(() => { paintLang(); note.classList.remove('ok', 'bad'); note.textContent = t('gate.note'); });
  paintLang();

  go.addEventListener('click', submit);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  box.addEventListener('input', () => {
    const pos = box.selectionStart;
    const before = box.value.length;
    box.value = formatCode(box.value);
    const after = box.value.length;
    const next = Math.max(0, pos + (after - before));
    try { box.setSelectionRange(next, next); } catch (e) {}
    box.removeAttribute('aria-invalid');
  });
  box.addEventListener('paste', () => setTimeout(() => { box.value = formatCode(box.value); }, 0));
}


async function boot() {
  initLang();
  loadSettings();
  initLicense();
  applyTheme();
  S.recent = loadRecent();
  TTS.initTTS();
  bindUI();
  registerSW();
  await openStores();
  await refreshFavCounts();
  await refreshRecentEntries();

  DICT.initDict(() => { MS.dict = { state: 'loading', text: t('status.dictLoading') }; renderStatus(); })
    .then(async (info) => {
      MS.dict = {
        state: 'ready',
        text: t('status.dictReady', { total: info.total.toLocaleString(), core: info.coreSize.toLocaleString() }),
      };
      renderStatus();
    })
    .catch((e) => {
      MS.dict = { state: 'bad', text: t('status.dictFail', { msg: e.message }) };
      renderStatus();
    });

  await initModelUI();
  probeModels();
  TTS.onVoices((voices) => fillVoiceSelect(voices));
  updateNetStatus();
  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);
  window.addEventListener('pagehide', () => { if (S.sessionKey) persistSession(); });
  startTick();
  setupLangUI();
  renderRecent();
  onLangChange(() => { setupLangUI(); renderModelOptions(); renderStatus(); rerenderAll(); applyLangView(); applyDropzoneTitle(); });

  // 空闲时把模型读进内存，这样「导入视频即出字幕」不用再等模型冷启动
  if (S.settings.autoRun) setTimeout(preloadModels, 1200);
}

async function preloadModels() {
  // 用户已经手动切过模型就不要再插手，免得两个装载任务互相打断
  if (!S.modelSwitched) {
    try {
      await startModelJob(S.asrModel);
    } catch (e) {
      console.warn('[asr] 预热失败', e);   // 状态已经标红，这里不打扰用户
    }
  }
  maybePreloadMT();
}

/**
 * 要不要顺手把翻译模型（113MB）也预热了？
 *
 * ── 为什么加了这么多条件 ──
 *
 * 以前这里是**无条件**预热的。结果是：首次打开页面，识别模型 80MB 下完，
 * 紧接着又默默拉 113MB 的翻译模型 —— 合计约 200MB。实测本站单连接只有
 * 400KB/s，200MB 要走八分钟以上（用户报的「十几分钟甚至半小时」就是它）。
 * 而绝大多数人第一次进来只是想知道「这东西能不能认出字幕」。
 *
 * 所以现在的规矩是：**首次访问的全部带宽都留给识别模型**，那是用户马上要用的。
 * 翻译模型等下次进来再说 —— 那时识别模型已经在缓存里，装载只要一两秒，
 * 这 113MB 才真正「不占别人的路」。
 *
 * 翻译功能本身不受影响：真要用的时候 translateMany() 会自己把模型拉起来，
 * 只是那一刻才下载（进度条上会明说是首次下载、约 113MB）。
 */
function maybePreloadMT() {
  if (S.settings.transMode === 'off') return;              // 用户压根不用翻译
  if (!asrWasCachedAtBoot) return;                        // 首次访问 → 带宽全给识别
  const c = navigator.connection || {};
  if (c.saveData) return;                                 // 用户开了省流量模式
  if (/^(slow-2g|2g|3g)$/.test(c.effectiveType || '')) return;   // 弱网别再雪上加霜

  // 两步预热，顺序是有意为之：
  //   1. 先把文件拉进缓存 —— 纯网络，和识别互不干扰
  //   2. 空闲时再建 ORT 会话 —— 这一步要读权重、跑图优化，会把 CPU 吃满，
  //      和识别撞上能让识别慢掉近两成，所以躲着识别走
  MT.warmupFiles().catch(() => {});
  scheduleMTPreload();
}

let mtPreloadTimer = null;
/** 挑一个「没在识别也没在翻译」的时刻装载翻译模型 */
function scheduleMTPreload() {
  clearTimeout(mtPreloadTimer);
  mtPreloadTimer = setTimeout(async () => {
    if (S.busy) { scheduleMTPreload(); return; }
    try {
      await MT.loadMT();
      markCached(LS_MT_CACHED);
      MS.mt = { state: 'ready' };
      renderStatus();
    } catch (e) {
      console.warn('[mt] 预热失败', e);
      MS.mt = { state: 'pending' };
      renderStatus();
    }
  }, 1000);
}

/* ============================ 识别模型 ============================ */

async function initModelUI() {
  S.asrModels = await availableASRModels();
  S.asrModel = await resolveASRModel(S.settings.asrModel);
  if (!S.asrModel) {
    MS.asr = { state: 'bad', note: t('set.asrModel.missing') };
    renderStatus();
    return;
  }
  S.settings.asrModel = S.asrModel;
  saveSettings();
  applySourceLang();
  ASR.setModel(S.asrModel);
  renderModelOptions();
}

/** 识别模型决定了音频是什么语言，翻译链要跟着换（en→zh 还是 es→en→zh）。
 *  必须在装模型**之前**调用：换了语言要重建翻译线程池，
 *  否则会拿着上一轮的模型去翻这一轮的句子。
 *
 *  另外这里是「模式」与「模型」的唯一校准点：真正决定识别语言的是模型，
 *  所以在设置抽屉里手动换成西语模型时，左上角那个模式按钮要跟着亮过去。 */
function applySourceLang() {
  const lang = modelLang(S.asrModel);
  MT.setLang(lang);
  if ((lang === 'en' || lang === 'es') && S.settings.mode !== lang) {
    S.settings.mode = lang;
    saveSettings();
  }
  // 朗读音色也跟着识别语言换：西语模式要挑西语音色，否则念出来是一口英文腔。
  // 放在 applyModeView 之前 —— 它内部会刷新设置抽屉里那份音色下拉。
  TTS.setTTSLang(lang);
  applyModeView();
  fillVoiceSelect(TTS.getVoices());
  return lang;
}

/** 重建模型下拉与说明。选项文案要跟着界面语言走，所以切语言时也要调一次。 */
function renderModelOptions() {
  const sel = $('#setAsrModel');
  if (sel) {
    sel.innerHTML = S.asrModels.map((id) => {
      const m = modelMeta(id);
      const label = m ? `${m.label} · ${t('set.asrModel.size', { mb: m.sizeMB })}` : id;
      return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (S.asrModel) sel.value = S.asrModel;
  }
  updateModelNote();
}

function updateModelNote() {
  const note = $('#asrModelNote');
  if (!note) return;
  const m = modelMeta(S.asrModel);
  let txt = m ? t(m.descKey) : t('set.asrModel.note');
  // 把「实际跑成什么样」写出来。识别慢的时候，这一行往往就是答案：
  // 要么是浏览器没进跨域隔离只能单线程，要么是内存太小只敢开一个会话。
  const p = ASR.poolInfo();
  if (p && p.size > 0) {
    txt += ' ' + t('set.asrModel.parallel', { n: p.size, threads: p.threads, cores: p.cores });
    if (!p.isolated) txt += ' ' + t('set.asrModel.slow');
  }
  note.textContent = txt;
}

/* 模型装载的串行化。
   开机预热与用户在设置里切换模型有可能同时发生：两个装载任务会互相打断
   （Worker 侧一次只收一条 load），晚到的进度回调还会把终态覆盖成「正在装载」。
   这里用「在途 Promise + 令牌」兜住：新任务先等旧任务收尾，旧任务的进度和
   结果一旦令牌过期就整体丢弃。 */
let modelJobToken = 0;
let modelJobInFlight = null;

// 首次下载时按实测速度估剩余时间。模型要下好几分钟，一个只会从 0% 爬到 100% 的
// 百分比条在用户眼里和卡死没有区别 —— 有「还剩多久」才让人愿意等。
let loadPace = { t0: 0, bytes: 0 };

/** 装载阶段的文案。状态栏和进度条共用一份，免得同一件事两处说法不一样。 */
function loadProgressText(p) {
  // totalBytes 为 0 = 两个大文件的总长度还没凑齐（预取刚开始那几百毫秒），
  // 这时只说「加载识别模型…」，不编一个会把进度条带偏的分母
  if (p.received != null && p.totalBytes > 0) {
    const mb = (p.received / 1048576).toFixed(1);
    const total = Math.round(p.totalBytes / 1048576);
    return t(hasCached(LS_ASR_CACHED) ? 'prog.loadModelMB' : 'prog.loadModelMBFirst', { mb, total });
  }
  if (p.received != null) return t('prog.loadAsr');
  return p.file
    ? t(hasCached(LS_ASR_CACHED) ? 'prog.loadModel' : 'prog.loadModelFirst', { file: shortFile(p.file) })
    : t('prog.loadAsr');
}

/** 由已下载字节与耗时算「还剩多久」，返回可直接拼进文案的短句（算不出来就空串） */
function paceEta(p) {
  if (p.received == null) return '';
  const now = performance.now();
  // 字节数回落（换了模型或重新开始）就把计时归零，别拿旧速度算新下载
  if (!loadPace.t0 || p.received < loadPace.bytes) loadPace = { t0: now, bytes: 0 };
  loadPace.bytes = p.received;
  const dt = (now - loadPace.t0) / 1000;
  if (dt < 2 || !p.totalBytes) return '';         // 采样太短，估出来只会乱跳
  const speed = p.received / dt;
  if (!(speed > 0)) return '';
  const left = (p.totalBytes - p.received) / speed;
  return left >= 1 ? ' ' + t('prog.etaTime', { t: fmtTime(left) }) : '';
}

function applyLoadProgress(id, p) {
  if (p.received != null) {
    MS.asr = { state: 'loading', note: t('status.warmingMB', { mb: (p.received / 1048576).toFixed(1) }), model: id };
    renderStatus();
    return;
  }
  if (p.pct != null && p.pct > 0 && p.pct < 100) {
    MS.asr = { state: 'loading', note: t('status.warmingPct', { pct: Math.round(p.pct) }), model: id };
    renderStatus();
  }
}

function startModelJob(id) {
  const token = ++modelJobToken;
  const prev = modelJobInFlight;
  loadPace = { t0: 0, bytes: 0 };   // 新的装载任务 → 速度采样重新开始
  const job = (async () => {
    if (prev) await prev.catch(() => {});
    if (token !== modelJobToken) return 'superseded';
    MS.asr = { state: 'loading', note: t('status.warmingAsr'), model: id };
    renderStatus();
    await ASR.loadASR((p) => { if (token === modelJobToken) applyLoadProgress(id, p); }, id);
    if (token !== modelJobToken) return 'superseded';
    MS.asr = { state: 'ready', name: '', model: id };
    markCached(LS_ASR_CACHED);   // 下次装载就快多了，不必再提「下载」
    renderStatus();
    updateModelNote();   // 池子刚建好，把真实并行度刷出来
    return 'ok';
  })().catch((e) => {
    if (token !== modelJobToken) return 'superseded';
    MS.asr = { state: 'bad', note: e?.message || String(e), model: id };
    renderStatus();
    throw e;
  });
  modelJobInFlight = job.catch(() => {});
  return job;
}

async function switchASRModel(id) {
  if (!id || id === S.asrModel) return true;
  if (S.busy) {
    toast(t('toast.busy'));
    const sel = $('#setAsrModel');
    if (sel) sel.value = S.asrModel;
    return false;
  }
  S.modelSwitched = true;
  S.asrModel = id;
  S.settings.asrModel = id;
  saveSettings();
  // 语言跟着模型走：从英语切到西语时，翻译链要从 en→zh 换成 es→en→zh。
  // 翻译线程池会在这里被丢弃重建，已经翻好的中文保留不动 —— 换模型本身
  // 就该重新识别，旧译文留着反而会和新的英文对不上。
  applySourceLang();
  ASR.setModel(id);
  // 从左上角的模式按钮切过来时，设置抽屉里那个下拉也得跟着走，
  // 否则两个控件会各说各话（下拉还停在旧模型上）。
  const sel = $('#setAsrModel');
  if (sel) sel.value = id;
  updateModelNote();
  try {
    if (await startModelJob(id) === 'ok') {
      toast(t('set.asrModel.switched', { model: modelMeta(id)?.label || id }));
      return true;
    }
    return false;
  } catch (e) {
    toast(t('toast.recogFail', { msg: e?.message || e }), 5000);
    return false;
  }
}

/* 首次使用标记。
   两处要用它：
   1. 进度文案：模型第一次要从网上拉几十 MB，这期间那句平淡的
      「加载识别模型…」在用户眼里和卡死没有区别，所以得明说「在下载、只需一次」。
      第二次以后命中缓存，读文件只要一两秒，就不用再吓唬人了。
   2. **决定这一轮要不要预热翻译模型**（113MB）。见 maybePreloadMT()。
   键名与判定函数统一放在 models.js，主线程和 asr.js 共用同一份，
   免得两边各写一个字符串、哪天改岔了还以为在缓存。 */
const hasCached = isModelCached;
const markCached = markModelCached;

// 开机这一刻的快照：「这次进来之前，识别模型是不是已经在本机了」。
// 必须在任何装载动作**之前**取，否则首次访问时 startModelJob 一成功就把标记写上了，
// 下面那些「首次就别预热翻译」的判断会全部失效。
const asrWasCachedAtBoot = hasCached(LS_ASR_CACHED);

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(S.settings, JSON.parse(raw));
  } catch {}
  // 嵌套对象要单独合一次：上面那句是浅合并，老版本存下的 mask 若少字段，
  // 缺的会变成 undefined，后面按百分比算位置就会得到 NaN。
  S.settings.mask = { ...SUBMASK.MASK_DEFAULTS, ...(S.settings.mask || {}) };
  // 老版本只有一个 voiceName（不分语言）。音色改成按语言记之后，把那个值
  // 当作英语音色迁过来 —— 用户在设置里挑过的音色不该因为升级丢掉。
  if (!S.settings.voiceEn && !S.settings.voiceEs && S.settings.voiceName) {
    S.settings.voiceEn = S.settings.voiceName;
  }
  delete S.settings.voiceName;
  try {
    const th = localStorage.getItem(LS_THEME);
    if (th === 'light' || th === 'dark' || th === 'auto') S.themePref = th;
  } catch {}
  const st = S.settings;
  $('#selRate').value = '1';
  // 音色下拉不在这里填：它要按当前模式挑 voiceEn / voiceEs 槽，
  // 交给 applySourceLang()（它知道模式，且跑在 TTS.initTTS 之后）去填。
  $('#setTtsRate').value = st.ttsRate;
  $('#setFontSize').value = st.fontSize;
  $('#chkAutoScroll').checked = st.autoScroll;
  $('#chkWordMark').checked = st.markWords;
  $('#chkAutoRun').checked = st.autoRun !== false;
  $('#chkKaraoke').checked = st.karaoke !== false;
  const chkPause = $('#chkPauseLookup');
  if (chkPause) chkPause.checked = st.pauseOnLookup !== false;
  const chkThird = $('#chkThirdLang');
  if (chkThird) chkThird.checked = st.showMid !== false;
  const chkFollow = $('#chkAutoScroll2');
  if (chkFollow) chkFollow.checked = st.autoScroll !== false;
  $('#rvZhToggle')?.classList.toggle('on', st.reviewShowZh !== false);
  $('#rvEnToggle')?.classList.toggle('on', st.reviewShowEn !== false);
  $('#rvAutoToggle')?.classList.toggle('on', st.reviewAutoSpeak !== false);
  $('#setTransMode').value = st.transMode;
  $('#setWordTs').value = st.wordTs;
  document.documentElement.style.setProperty('--sub-font', st.fontSize + 'px');
  document.getElementById('subs').classList.toggle('nomark', !st.markWords);
  document.getElementById('bigScreen').classList.toggle('nomark', !st.markWords);
}

function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S.settings)); } catch {}
}

/* ============================ 主题 ============================ */

const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolvedTheme() {
  if (S.themePref === 'dark' || S.themePref === 'light') return S.themePref;
  return darkMedia?.matches ? 'dark' : 'light';
}

const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/>';

function applyTheme() {
  const rt = resolvedTheme();
  document.documentElement.dataset.theme = rt;
  const icon = $('#themeIcon');
  if (icon) icon.innerHTML = rt === 'dark' ? MOON : SUN;
  $$('#themeCards .theme-card').forEach((b) => b.classList.toggle('on', b.dataset.themeOpt === S.themePref));
}

function setThemePref(pref) {
  S.themePref = pref;
  try { localStorage.setItem(LS_THEME, pref); } catch {}
  applyTheme();
}

if (darkMedia) {
  const onSys = () => { if (S.themePref === 'auto') applyTheme(); };
  darkMedia.addEventListener ? darkMedia.addEventListener('change', onSys) : darkMedia.addListener(onSys);
}

/* ============================ 通用确认框 ============================ */

/** 一个只问「行 / 不行」的小弹窗。返回 Promise<boolean>。 */
function askModal({ title, body, okText, cancelText }) {
  return new Promise((resolve) => {
    const box = $('#askModal');
    if (!box) { resolve(window.confirm(`${title}\n\n${body}`)); return; }   // 兜底：极端情况下也要能问出来
    setText('askTitle', title);
    setText('askBody', body);
    setText('askOk', okText);
    setText('askCancel', cancelText);
    box.hidden = false;

    const done = (v) => {
      box.hidden = true;
      $('#askOk').removeEventListener('click', onOk);
      $('#askCancel').removeEventListener('click', onCancel);
      box.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === box) done(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    $('#askOk').addEventListener('click', onOk);
    $('#askCancel').addEventListener('click', onCancel);
    box.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    $('#askOk').focus();
  });
}

/* ============================ 学习语言模式 ============================

   左上角那个 English / Español 开关。它决定「识别什么语言 + 走哪条翻译链」：

     en → whisper-base.en（纯英语）   → en → zh
     es → whisper-base（多语言）      → es → en → zh

   和右上角的界面语言（EN 按钮）是两件完全独立的事 —— 你可以用中文界面学西语。
   唯一的耦合点是「模式 ↔ 识别模型的语言」始终保持同步，因为真正决定识别语言
   的是模型：在这个开关上点一下会换模型，在设置里手动换模型也会让这里跟着亮。

   ⚠️ 西语必须用多语言版模型（不带 .en）。纯英语模型喂西语音频**不会报错**，
      只会吐出一串看起来像英语的无意义猜测 —— 这正是需要这个开关的原因。
--------------------------------------------------------------- */

/** 每个模式的默认识别模型。模型不在本机时不静默降级，直接告诉用户。 */
const MODE_MODEL = { en: 'whisper-base.en', es: 'whisper-base' };

/** 当前模式 = 当前识别模型的语言；模型还没解析出来时退回存档值。 */
function getMode() {
  const byModel = modelLang(S.asrModel);
  if (S.asrModel && (byModel === 'en' || byModel === 'es')) return byModel;
  return S.settings.mode === 'es' ? 'es' : 'en';
}

function applyModeView() {
  const mode = getMode();
  $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  // 字幕面板那三个语言按钮跟着走：西语模式要多一个「英文翻译」的开关，
  // 原文按钮的标签也从「英文」变成「西语」。
  applyLangView();
  applyDropzoneTitle();
  // 收藏夹按模式分区：切完模式，角标和抽屉内容都要当场换成另一档
  refreshFavCounts();
  if (!$('#favDrawer').hidden) renderFavs();
}

/** 拖拽区标题跟着学习语言走 —— 英文模式下说「拖英语视频」，
 *  西班牙模式下说「拖西班牙语视频」，别让用户拖错文件进来白等一轮识别。 */
function applyDropzoneTitle() {
  renderRecent();
  // 空状态里的「选择文件 / 继续上次」也要跟着界面语言刷新
  if (!S.cues.length && !S.mediaPending) renderSubs();
  // 注意：选择器不能写死 [data-i18n="dz.title"]。这个函数自己会把 dataset.i18n
  // 改成 dz.titleEs，改完那个选择器就再也选不中它了 —— 于是「es → en」切回来时
  // 静默什么都不做，标题永远停在「把西班牙语视频拖进来」。两个 key 都要能选中。
  const el = $('[data-i18n="dz.title"], [data-i18n="dz.titleEs"]');
  if (el) {
    const key = getMode() === 'es' ? 'dz.titleEs' : 'dz.title';
    // 行内 textContent 会盖住 data-i18n 的效果，而 setLang → applyI18n 又是按
    // dataset.i18n 重刷一遍所有静态文案的。所以这里必须把 dataset.i18n 一起换掉，
    // 否则界面语言一改，标题就被 applyI18n 刷回静态 key（dz.title）的译文，
    // 西语模式下会看到「Drop an English video here」这种自相矛盾的句子。
    el.dataset.i18n = key;
    el.textContent = t(key);
  }
}

/* ── 收藏分区 ──
   英语模式只看英语收藏，西语模式只看西语收藏。
   分区键统一取 getMode()：存的时候按它打标、看的时候按它筛，同一个来源，
   不会出现「刚收藏完却在列表里找不到」。
   老记录没有 lang 字段（都是英语时代存的），一律当英语，升级后一条都不会少。 */
const favLang = () => (getMode() === 'es' ? 'es' : 'en');
const recLang = (r) => (r && r.lang === 'es' ? 'es' : 'en');

/** 收藏主键。西语要带语言前缀 —— 「no」「a」「son」这些词英语西语都有，
 *  拿裸词当主键两边会互相覆盖。英语那批不加前缀，只为兼容老库里已有的键。 */
const favWordId = (word, lang = favLang()) => (lang === 'es' ? `es:${word}` : word);

/** 切到某个学习语言模式。界面语言不动。 */
async function setMode(mode) {
  if (mode !== 'en' && mode !== 'es') return;
  if (mode === getMode()) return;

  const want = MODE_MODEL[mode];
  if (want && !S.asrModels.includes(want)) {
    toast(t('mode.needModel', { model: modelMeta(want)?.label || want }), 6000);
    applyModeView();          // 把按钮弹回真实状态，别留一个骗人的高亮
    return;
  }

  // 已经识出来的字幕是按另一种语言跑的 → 先问一句再动手。
  // 不问就切的话，用户会看到「模式是西语、字幕还是英语」这种看不懂的状态。
  // 答「先不重识别」也照切模式，只是不动已有字幕。
  const prev = getMode();
  let redo = false;
  if (S.cues.length && S.recogLang && S.recogLang !== mode) {
    redo = await askModal({
      title: t('mode.confirmTitle'),
      body: t('mode.confirmBody', { from: t('mode.lang.' + prev), to: t('mode.lang.' + mode) }),
      okText: t('mode.confirmYes'),
      cancelText: t('mode.confirmNo'),
    });
  }

  // 先落存档再换模型：applySourceLang → applyModeView 会回头读它做校准
  S.settings.mode = mode;
  saveSettings();
  applyModeView();

  if (want && want !== S.asrModel) {
    const ok = await switchASRModel(want);
    if (!ok) {
      // 换模型被拒绝（正在识别中）或装载失败：把模式回退到真实语言，别虚标
      S.settings.mode = getMode();
      saveSettings();
      applyModeView();
      return;
    }
  }
  applyModeView();
  toast(t('mode.switched', { lang: t('mode.lang.' + mode) }));

  // 换完模型再重跑：runTranscribe 要用新模型，顺序反了会拿旧模型再识别一遍
  if (redo) runTranscribe();
}

/* ============================ 界面语言 ============================ */

function setupLangUI() {
  // 按钮上显示的是「按一下会切到哪种语言」，所以用 nextLang
  setText('langLabel', LANG_SHORT[nextLang(getLang())] || 'EN');
  const sel = $('#setLang');
  if (sel) sel.value = getLang();
  document.body.dataset.dropHint = t('dropHint');
  const exp = $('#btnExportSrt');
  if (exp) exp.textContent = t('cue.exportSrt');
}

/** 切语言后把所有动态内容重建一遍 */
function rerenderAll() {
  closeWordCard();
  renderSubs($('#subSearch').value.trim());
  if (S.activeIdx >= 0) setActive(S.activeIdx, false);
  if (!$('#favDrawer').hidden) { renderFavs(); fillSettings(); }
  if (!$('#setDrawer').hidden) fillSettings();
  fillVoiceSelect(TTS.getVoices());
  renderStatus();
  updateNetStatus();
  setText('btnTranscribeLabel', S.busy === 'asr'
    ? t('top.running')
    : (S.cues.length ? t('top.redo') : t('top.start')));
}

/* ============================ 本地学习记录 ============================
   只保存「用户本机可重建的东西」：文件名、识别语言、字幕与译文、播放位置、
   真实处理状态。视频 Blob 本身不存 —— 浏览器也不允许网页记住本机文件路径。
   重新打开时能恢复字幕与位置，但要用户再选一次同一个文件，这是诚实的限制。
   收藏/复习仍走原来的 IndexedDB 两个 store，这里不碰它们。
==================================================================== */

const safeReadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};

function loadSession(key = null) {
  // v2：每个 key 一条独立 payload；旧版单一 payload 仍可读，避免升级即丢。
  const storeKey = key ? LS_SESSION_PREFIX + key : null;
  let v = storeKey ? safeReadJSON(storeKey, null) : null;
  if (!v) v = safeReadJSON(LS_SESSION, null);
  if (key && v && v.key && v.key !== key) return null;
  if (!v || typeof v !== 'object' || !v.key) return null;
  return {
    key: String(v.key),
    name: String(v.name || ''),
    mode: v.mode === 'es' ? 'es' : 'en',
    recogLang: v.recogLang === 'es' ? 'es' : (v.recogLang === 'en' ? 'en' : null),
    cues: Array.isArray(v.cues) ? v.cues.filter((c) => c && Number.isFinite(+c.start)) : [],
    at: Number.isFinite(+v.at) ? Math.max(0, +v.at) : 0,
    status: ['ready', 'partial', 'failed', 'processing'].includes(v.status) ? v.status : 'partial',
    updatedAt: Number(v.updatedAt) || 0,
  };
}

function loadRecent() {
  const list = safeReadJSON(LS_RECENT, []);
  return Array.isArray(list) ? list.filter((r) => r && r.key).slice(0, RECENT_MAX) : [];
}

/** 最近记录 + 句柄是否存在。句柄只做存在性标记，不在这里请求权限。 */
async function refreshRecentEntries() {
  if (!S.db) return;
  try {
    const rows = await idbAll(S.db, 'handles');
    const keys = new Set(rows.map((r) => r.key));
    S.recent = S.recent.map((r) => ({ ...r, hasHandle: keys.has(r.key) }));
  } catch { /* IndexedDB 不可用时保持原样 */ }
  renderContinuePop();
}

function sessionIdFor(file) {
  // 文件名 + 大小 + 最后修改时间：同一文件重选时能对上，不同文件不会撞车。
  // 不依赖路径（浏览器根本不提供），也不假装它是持久句柄。
  return `${file.name}|${file.size}|${file.lastModified || 0}`;
}

const finite = (v) => Number.isFinite(+v);

/** 只保留可重建 UI 需要的字段；words 是 Whisper 的真实逐词时间戳，
 *  必须原样保留，否则恢复后会被按句长估算，跟读高亮就失真。 */
function cueForStorage(c) {
  const out = {
    start: +c.start, end: +c.end, text: c.text || '', zh: c.zh || '', mid: c.mid || '',
  };
  if (Array.isArray(c.words) && c.words.length) {
    out.words = c.words
      .filter((w) => w && finite(w.s) && finite(w.e))
      .map((w) => ({ w: String(w.w || ''), s: +w.s, e: +w.e }));
  }
  if (c.noAudio) out.noAudio = true;
  return out;
}

function persistSession({ status } = {}) {
  if (!S.sessionKey) return;
  const payload = {
    key: S.sessionKey,
    name: S.name || '',
    mode: getMode(),
    recogLang: S.recogLang || null,
    cues: S.cues.map(cueForStorage),
    // 只有在真的有媒体、且已经读到元数据时才用 currentTime；
    // 否则保留恢复时的位置（restorePositionOnLoad 之前 currentTime 还是 0）。
    at: (S.file && $('#player').readyState >= 1)
      ? Math.max(0, +$('#player').currentTime || 0)
      : Math.max(0, +S.resumeAt || 0),
    status: status || S.lastStatus || 'partial',
    updatedAt: Date.now(),
  };
  const json = JSON.stringify(payload);
  const storeKey = LS_SESSION_PREFIX + payload.key;
  let stored = false;
  try {
    if (json.length <= SESSION_BYTES_MAX) {
      localStorage.setItem(storeKey, json);
      // 新格式写成功后才清旧单条，避免两边都不是最新
      try { localStorage.removeItem(LS_SESSION); } catch { /* 忽略 */ }
      stored = true;
    }
  } catch (e) {
    // 配额：只删本应用最旧的会话副本，不动收藏/其它站点数据
    stored = evictOldestSessions(payload.key);
    if (stored) { try { localStorage.setItem(storeKey, json); stored = true; } catch { stored = false; } }
  }
  if (!stored) {
    // 放不下就诚实降级：不声明「可恢复字幕」，只保留可重选元数据
    payload.cues = [];
    const small = JSON.stringify(payload);
    try { localStorage.setItem(LS_SESSION, small); } catch { /* 隐私模式 */ }
  }
  S.lastStatus = payload.status;
  const entry = {
    key: payload.key, name: payload.name, mode: payload.mode,
    n: payload.cues.length, at: payload.at, status: payload.status,
    recoverable: stored || payload.cues.length > 0, updatedAt: payload.updatedAt,
  };
  S.recent = [entry, ...S.recent.filter((r) => r.key !== entry.key)].slice(0, RECENT_MAX);
  trimRecentBudget();
  saveRecentIndex();
  renderRecent();
}

function saveRecentIndex() {
  try { localStorage.setItem(LS_RECENT, JSON.stringify(S.recent)); } catch { /* 忽略 */ }
}

/** 单条会话已各自限长；这里再按总字节数从最旧开始丢弃**会话副本**，
 *  保留目录项并标成不可恢复，绝不假装还能恢复。 */
function trimRecentBudget() {
  const keys = S.recent.map((r) => r.key).reverse();   // 最旧在前
  let total = 0;
  for (const r of S.recent) {
    const raw = localStorage.getItem(LS_SESSION_PREFIX + r.key);
    total += raw ? raw.length : 0;
  }
  for (const key of keys) {
    if (total <= RECENT_BYTES_MAX) break;
    const raw = localStorage.getItem(LS_SESSION_PREFIX + key);
    if (!raw) continue;
    total -= raw.length;
    try { localStorage.removeItem(LS_SESSION_PREFIX + key); } catch { /* 忽略 */ }
  deleteHandle(key);
    const entry = S.recent.find((r) => r.key === key);
    if (entry) { entry.recoverable = false; entry.n = 0; }
  }
}

function evictOldestSessions(keepKey) {
  const keys = S.recent.map((r) => r.key).filter((k) => k !== keepKey);
  for (const key of keys.reverse()) {
    try {
      if (localStorage.getItem(LS_SESSION_PREFIX + key)) {
        localStorage.removeItem(LS_SESSION_PREFIX + key);
        const entry = S.recent.find((r) => r.key === key);
        if (entry) { entry.recoverable = false; entry.n = 0; }
        saveRecentIndex();
        return true;
      }
    } catch { /* 忽略 */ }
  }
  return false;
}

function removeRecent(key) {
  S.recent = S.recent.filter((r) => r.key !== key);
  try { localStorage.setItem(LS_RECENT, JSON.stringify(S.recent)); } catch { /* 忽略 */ }
  try { localStorage.removeItem(LS_SESSION_PREFIX + key); } catch { /* 忽略 */ }
  const cur = loadSession();
  if (cur && cur.key === key) {
    try { localStorage.removeItem(LS_SESSION); } catch { /* 忽略 */ }
    if (S.sessionKey === key && !S.file) clearRestoredSession();
  }
  renderRecent();
  toast(t('dz.recentRemoved'));
}

function clearRestoredSession() {
  S.pendingHandleKey = null;
  S.cues = [];
  S.activeIdx = -1;
  S.sessionKey = '';
  S.mediaPending = false;
  S.resumeAt = 0;
  renderSubs();
  renderMediaNotice();
}

async function clearAllHistory() {
  S.recent = [];
  S.sessionKey = '';
  S.resumeAt = 0;
  try {
    localStorage.removeItem(LS_RECENT);
    localStorage.removeItem(LS_SESSION);
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LS_SESSION_PREFIX)) localStorage.removeItem(k);
    }
    if (S.db) await idbClear(S.db, 'handles');
  } catch { /* 忽略 */ }
  if (!S.file) { S.cues = []; renderSubs(); }
  renderRecent();
  renderMediaNotice();
  toast(t('set.recentClearDone'));
}

/** 右侧空状态里的紧凑记录入口：只列前三条，真实状态；没有就不画。 */
/* ============================ 顶栏「继续学习」 ============================
   弹层只读真实本地记录；没有记录时按钮仍可见，并解释为什么是空的。
   选择一条记录时：有文件句柄且已授权 → 直接重开原文件；
   未授权 → 用户明确点「授权并继续」才请求权限；不支持/拒绝 → 退回复选文件。
========================================================================= */

function continueStatusText(r) {
  const st = r.status;
  if (st === 'ready') return t('continue.statusReady');
  if (st === 'processing') return t('continue.statusProcessing');
  if (st === 'failed') return t('continue.statusFailed');
  if (st === 'partial') return t('continue.statusPartial');
  return r.n ? t('continue.statusPartial') : t('continue.statusProcessing');
}

function renderContinuePop() {
  const list = $('#continueList');
  const btn = $('#btnContinue');
  if (!list) return;
  const count = S.recent.length;
  const badge = $('#continueCount');
  if (badge) { badge.hidden = !count; badge.textContent = String(count); }
  if (btn) btn.setAttribute('aria-label', t('continue.title') + (count ? ` (${t('continue.count', { n: count })})` : ''));
  if (!count) {
    list.innerHTML = `<div class="cp-empty">${escapeHtml(t('continue.empty'))}` +
      `<div><label class="btn btn-sm" for="fileVideo">${escapeHtml(t('dz.choose'))}</label></div></div>`;
    return;
  }
  list.innerHTML = S.recent.map((r) => {
    const state = ['ready', 'processing', 'failed'].includes(r.status) ? r.status : 'partial';
    const meta = r.n
      ? t('continue.savedAt', { n: r.n, t: fmtTime(r.at || 0) })
      : '';
    return `<div class="cp-item" data-key="${escapeHtml(r.key)}">` +
      `<button class="cp-open" type="button" data-act="open" data-key="${escapeHtml(r.key)}"` +
      ` title="${escapeHtml(t('dz.recentOpen'))}">` +
      `<span class="cp-name">${escapeHtml(r.name || r.key)}</span>` +
      `<span class="cp-meta">${[
        meta, continueStatusText(r),
        r.hasHandle ? t('continue.canReopen') : t('continue.needReselect'),
      ].filter(Boolean).map(escapeHtml).join(' · ')}</span>` +
      `</button>` +
      `<span class="cp-state ${state}">${escapeHtml(r.mode === 'es' ? 'ES' : 'EN')}</span>` +
      `<button class="icon-btn cp-remove" type="button" data-act="remove" data-key="${escapeHtml(r.key)}"` +
      ` title="${escapeHtml(t('continue.remove'))}" aria-label="${escapeHtml(t('continue.remove'))}">×</button>` +
      `</div>`;
  }).join('');
}

function positionContinuePop() {
  const pop = $('#continuePop');
  const btn = $('#btnContinue');
  if (!pop || !btn || pop.hidden) return;
  if (window.matchMedia('(max-width: 640px), (pointer: coarse)').matches) return; // CSS sheet
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 420;
  const left = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8));
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
}

function openContinuePop() {
  const pop = $('#continuePop');
  const btn = $('#btnContinue');
  if (!pop || !btn) return;
  renderContinuePop();
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  positionContinuePop();
  const first = pop.querySelector('[data-act="open"]') || pop.querySelector('label[for="fileVideo"]');
  first?.focus({ preventScroll: true });
}

function closeContinuePop({ returnFocus = true } = {}) {
  const pop = $('#continuePop');
  const btn = $('#btnContinue');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  btn?.setAttribute('aria-expanded', 'false');
  if (returnFocus) btn?.focus({ preventScroll: true });
}

function toggleContinuePop() {
  const pop = $('#continuePop');
  if (!pop) return;
  if (pop.hidden) openContinuePop(); else closeContinuePop();
}

/** 记录是否有可复用的文件句柄。只有支持且成功存过才有。 */
function hasFileHandleSupport() {
  return typeof window.showOpenFilePicker === 'function'
    && typeof indexedDB !== 'undefined';
}

/** 读取某个 key 的句柄。structured clone 失败（旧浏览器/清理过）就当作没有。 */
async function loadHandle(key) {
  // 测试钩子：只用于无头浏览器模拟句柄方法（默认不存在）
  if (typeof window.__ecHandleTestHook === 'function') {
    const h = window.__ecHandleTestHook(key);
    if (h) return h;
  }
  if (!S.db) return null;
  try {
    const rows = await idbAll(S.db, 'handles');
    const row = rows.find((x) => x.key === key);
    return row?.handle || null;
  } catch { return null; }
}

async function saveHandle(key, handle) {
  if (!S.db || !handle) return false;
  try {
    await idbPut(S.db, 'handles', { key, handle, savedAt: Date.now() });
    return true;
  } catch { return false; }
}

async function deleteHandle(key) {
  if (!S.db) return;
  try { await idbDelete(S.db, 'handles', key); } catch { /* 忽略 */ }
}

/** 只在用户明确点击后调用。永远只请求 read，绝不请求目录或写权限。 */
async function requestHandlePermission(handle) {
  if (!handle) return 'unsupported';
  if (typeof handle.queryPermission !== 'function') return 'unsupported';
  try {
    const state = await handle.queryPermission({ mode: 'read' });
    if (state === 'granted') return 'granted';
    if (!handle.requestPermission) return state === 'denied' ? 'denied' : 'prompt';
    const asked = await handle.requestPermission({ mode: 'read' });
    return asked === 'granted' ? 'granted' : (asked === 'denied' ? 'denied' : 'prompt');
  } catch (e) {
    console.warn('[continue] permission failed', e);
    return 'error';
  }
}

/** 用句柄恢复媒体。先校验身份/变化，再走与普通导入相同的恢复路径。 */
async function reopenFromHandle(key) {
  const session = loadSession(key);
  const meta = S.recent.find((r) => r.key === key);
  if (!session) { toast(t('dz.recentReselect')); return false; }
  const handle = await loadHandle(key);
  if (!handle) return false;
  const state = await requestHandlePermission(handle);
  if (state !== 'granted') {
    toast(state === 'denied' ? t('continue.denied') : (state === 'unsupported' ? t('continue.unsupported') : t('continue.reopenFailed')));
    return false;
  }
  let file;
  try { file = await handle.getFile(); } catch { toast(t('continue.stale')); return false; }
  const newKey = sessionIdFor(file);
  if (newKey !== key) {
    // 名称相同但大小/mtime 变了：不静默把旧字幕套到新文件上
    const ok = await askModal({
      title: t('continue.changed'),
      body: t('continue.confirmChanged'),
      okText: t('continue.grant'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return false;
  }
  await openVideoFile(file, { fromHandle: true, sessionKey: key });
  closeContinuePop();
  return true;
}

/** 选中一条真实记录：能直接重开就重开，否则显式进入复选文件路径。 */
async function continueRecent(key) {
  const meta = S.recent.find((r) => r.key === key);
  if (!meta) return;
  closeContinuePop({ returnFocus: false });
  const handle = await loadHandle(key);
  openRecent(key);           // 先恢复字幕与位置（不触发识别）
  S.pendingHandleKey = handle ? key : null;
  S.pendingHandleHasApi = !!(handle && typeof handle.queryPermission === 'function');
  if (handle) {
    // 有句柄也要用户明确同意后才 requestPermission；这里只展示「授权并继续」
    renderMediaNotice();
  }
  closeContinuePop();
}

function renderRecent() {
  renderContinuePop();
}

/** 恢复一条记录：只恢复字幕与位置，视频必须由用户重新选择。 */
function openRecent(key) {
  const session = loadSession(key);
  if (!session || session.key !== key) { toast(t('dz.recentReselect')); return; }
  S.sessionKey = key;
  S.name = session.name;
  S.recogLang = session.recogLang;
  S.cues = session.cues.map((c, i) => ({ ...c, i }));
  S.cues.forEach((c) => { delete c._wt; });
  S.activeIdx = -1;
  S.resumeAt = session.at;
  S.lastStatus = session.status;
  S.mediaPending = true;
  S.file = null;
  const player = $('#player');
  if (player.src) URL.revokeObjectURL(player.src);
  player.removeAttribute('src');
  player.load();
  $('#playerWrap').classList.remove('audio-only');
  $('#audioBadge')?.remove();
  $('#bigScreen').hidden = true;
  $('#dropzone').classList.add('hide');
  $('#playerBar').hidden = true;
  $('#btnTranscribe').disabled = false;
  setText('btnTranscribeLabel', S.cues.length ? t('top.redo') : t('top.start'));
  renderSubs();
  renderMediaNotice();
  showFollowReturn(false);
  refreshRecentEntries();
}

/** 恢复字幕但没有媒体时，播放器区域明确说明浏览器限制与下一步。 */
function renderMediaNotice() {
  const wrap = $('#playerWrap');
  let n = $('#mediaNotice');
  if (!S.mediaPending) { if (n) n.hidden = true; return; }
  if (!n) {
    // 兼容旧 HTML：节点不存在时才动态建，且一次建全，后续只改文本
    n = el('div', { class: 'media-notice', id: 'mediaNotice' });
    n.innerHTML = `<div class="media-notice-card"><h3></h3><p></p><div class="set-btns">` +
      `<button class="btn" id="mediaGrant" type="button" hidden></button>` +
      `<label class="btn" for="fileVideo"></label><label class="btn" for="fileVideo"></label></div></div>`;
    wrap.appendChild(n);
  }
  if (!n.querySelector('h3')) return;
  n.hidden = false;
  n.querySelector('h3').textContent = t('media.needFile');
  const pending = S.pendingHandleKey && S.pendingHandleKey === S.sessionKey
    && S.pendingHandleHasApi !== false;
  n.querySelector('p').textContent = pending ? t('continue.note') : t('media.needFileBody');
  const [a, b] = n.querySelectorAll('label');
  a.textContent = t('media.chooseFile');
  b.textContent = t('media.pickAnother');
  const grant = n.querySelector('#mediaGrant');
  if (grant) {
    grant.hidden = !pending;
    if (pending) {
      grant.textContent = t('continue.grant');
      grant.onclick = () => reopenFromHandle(S.pendingHandleKey);
    }
  }
}

/* ============================ IndexedDB ============================ */

async function openStores() {
  try {
    // v1 → v2 只新增句柄 store；words / sentences 原样保留，升级不迁移、不清空。
    S.db = await openDB('echolingo', 2, [
      { name: 'words', keyPath: 'id' },
      { name: 'sentences', keyPath: 'id' },
      { name: 'handles', keyPath: 'key' },
    ]);
    const words = await idbAll(S.db, 'words');
    const sents = await idbAll(S.db, 'sentences');
    // 老库里的收藏没有 SRS 字段（复习功能上线前存的）。这里补上，并按
    // 「立刻可复习」处理 —— 否则升级后复习页空着，看着像坏了。
    // 只在内存里补，不立刻回写：回写要几百次事务，而下次复习打分会顺手存回去。
    S.favWords = new Map(words.map((w) => [w.id, SRS.ensureSrs(w)]));
    S.favSentences = new Map(sents.map((s) => [s.id, SRS.ensureSrs(s)]));
  } catch (e) {
    toast(t('fav.dbUnavailable', { msg: e.message }));
  }
}

async function refreshFavCounts() {
  // 角标 = 当前模式这一档的条数，跟抽屉里看到的对得上。
  // 显示总数会让「切到西语模式，角标 100、抽屉里 3 条」看起来像 bug。
  const mine = favLang();
  const n = Array.from(S.favWords.values()).filter((w) => recLang(w) === mine).length
    + Array.from(S.favSentences.values()).filter((s) => recLang(s) === mine).length;
  setText('favCount', String(n));
  // 复习角标跟着一起刷：两处都依赖「当前档位有哪些收藏」，
  // 分开调用迟早会漏掉一处，变成「删了收藏复习角标还挂着」。
  refreshReviewBadge();
  renderFavScope();
}

/* ============================ UI 绑定 ============================ */

function bindUI() {
  const player = $('#player');

  // --- 文件导入 ---
  // 顶栏/空态的主导入：支持时走句柄选择器（保留句柄供「继续学习」），否则原生 input
  $$('label[for="fileVideo"]').forEach((lab) => {
    lab.addEventListener('click', async (ev) => {
      if (!hasFileHandleSupport()) return;   // 原生 input
      ev.preventDefault();
      const ok = await openViaPicker();
      if (!ok) $('#fileVideo').click();
    });
  });
  $('#fileVideo').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) openVideoFile(f);
    e.target.value = '';
  });

  // --- 链接导入 ---
  $('#btnUrlImport').addEventListener('click', () => { if (needLicense()) openUrlImport(); });
  $('#urlClose').addEventListener('click', () => closeUrlImport());
  $('#urlCancel').addEventListener('click', () => closeUrlImport());
  $('#urlOverlay').addEventListener('click', (ev) => {
    if (ev.target === $('#urlOverlay')) closeUrlImport();
  });
  $('#urlLookup').addEventListener('click', lookupUrl);
  $('#urlField').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); lookupUrl(); }
  });
  $('#urlField').addEventListener('input', resetUrlLookup);
  $('#urlGo').addEventListener('click', startUrlImport);

  // File System Access 优先：只有在支持且用户点击时才调用；失败/取消退回 input
  $('#btnContinue').addEventListener('click', (e) => { e.stopPropagation(); toggleContinuePop(); });
  $('#continueClose').addEventListener('click', () => closeContinuePop());
  $('#continuePop').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'open') continueRecent(b.dataset.key);
    else if (b.dataset.act === 'remove') { removeRecent(b.dataset.key); renderContinuePop(); }
  });
  document.addEventListener('click', (ev) => {
    const pop = $('#continuePop');
    if (!pop || pop.hidden) return;
    if (pop.contains(ev.target) || ev.target.closest('#btnContinue')) return;
    closeContinuePop({ returnFocus: false });
  });
  window.addEventListener('resize', debounce(() => { if (!$('#continuePop').hidden) positionContinuePop(); }, 100));
  $('#fileSub').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importSubtitle(f);
    e.target.value = '';
  });
  $('#btnTranscribe').addEventListener('click', runTranscribe);
  $('#btnCancelJob').addEventListener('click', cancelCurrentJob);
  $('#btnRetryJob').addEventListener('click', retryLastJob);
  $('#btnPlayerSettings').addEventListener('click', () => {
    toggleDrawer('setDrawer');
    setTimeout(() => $('#setMaskSec')?.scrollIntoView({ block: 'start' }), 120);
  });
  $('#followReturn').addEventListener('click', () => {
    S.followPaused = false;
    showFollowReturn(false);
    if (S.activeIdx >= 0) setActive(S.activeIdx, true, { force: true });
  });
  $('#btnDemo').addEventListener('click', loadDemo);
  $('#btnDemoSub').addEventListener('click', async () => {
    try {
      const res = await fetch('media/demo.srt', { cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      await importSubtitle(new File([text], 'demo.srt', { type: 'text/plain' }));
    } catch (e) { toast(t('toast.demoSubFail', { msg: e.message })); }
  });

  // 拖放
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((t2) =>
    document.addEventListener(t2, (e) => {
      e.preventDefault();
      document.body.classList.add('dragover');
    }));
  ['dragleave', 'drop'].forEach((t2) =>
    document.addEventListener(t2, (e) => {
      e.preventDefault();
      if (t2 === 'dragleave' && e.relatedTarget) return;
      document.body.classList.remove('dragover');
    }));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const n = f.name.toLowerCase();
    if (/\.(srt|vtt)$/.test(n)) importSubtitle(f);
    else openVideoFile(f);
  });

  // --- 主题 / 语言 ---
  $('#btnTheme').addEventListener('click', () => {
    setThemePref(resolvedTheme() === 'dark' ? 'light' : 'dark');
  });
  $('#btnLang').addEventListener('click', () => setLang(nextLang(getLang())));

  // 左上角的学习语言模式。它跟界面语言是两回事，所以这里不碰 setLang。
  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.mode) setMode(b.dataset.mode);
  });
  applyModeView();
  $('#themeCards').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-opt]');
    if (b) setThemePref(b.dataset.themeOpt);
  });
  $('#setLang').addEventListener('change', (e) => setLang(e.target.value));

  // --- 播放条 ---
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnBack5').addEventListener('click', () => seekBy(-5));
  $('#btnFwd5').addEventListener('click', () => seekBy(5));
  $('#seek').addEventListener('input', (e) => {
    if (!player.duration) return;
    S.stopAt = null;
    const t0 = (e.target.value / 1000) * player.duration;
    player.currentTime = t0;
    const i = findCue(t0);
    if (i >= 0) setActive(i, true);
  });
  $('#selRate').addEventListener('change', (e) => { player.playbackRate = parseFloat(e.target.value); });
  $('#btnPrevSent').addEventListener('click', () => jumpCue(-1));
  $('#btnNextSent').addEventListener('click', () => jumpCue(1));
  $('#btnReplaySent').addEventListener('click', replayCurrent);
  $('#btnLoopSent').addEventListener('click', toggleLoop);

  player.addEventListener('loadedmetadata', () => { updateDuration(); restorePositionOnLoad(); });
  player.addEventListener('timeupdate', onTimeUpdate);
  player.addEventListener('play', syncPlayIcon);
  // 只同步图标。暂停归因不看媒体事件（加载/系统打断也会触发 pause），
  // 而是看用户是否真的操作了播放控件（togglePlay / 空格 / 播放器点击）。
  player.addEventListener('pause', syncPlayIcon);

  // --- 字幕面板 ---
  $('#subs').addEventListener('click', onSubsClick);
  $('#bigScreen').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    markWord(w);
    openWordCard(w.dataset.w, w, S.activeIdx, { fromSentence: true });
  });
  $('#subs').addEventListener('scroll', () => { S.lastUserScroll = Date.now(); }, { passive: true });
  // 用户一滚就暂停跟随（滚轮 / 触控 / 拖滚动条都算），不自动抢回
  ['wheel', 'touchstart', 'pointerdown'].forEach((ev) => {
    $('#subs').addEventListener(ev, () => {
      if (S.cues.length) { S.followPaused = true; showFollowReturn(true); }
    }, { passive: true });
  });
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#viewSeg button').forEach((x) => x.classList.toggle('active', x === b));
    S.view = b.dataset.view;
    $('.reader').classList.toggle('focus', S.view === 'focus');
    $('#focusBar').hidden = S.view !== 'focus';
    if (S.activeIdx >= 0) setActive(S.activeIdx, true);
  });
  $('#subSearch').addEventListener('input', debounce((e) => applySearch(e.target.value.trim()), 180));
  const syncAutoScroll = (on) => {
    S.settings.autoScroll = on;
    S.settings.follow = on;
    saveSettings();
    $('#chkAutoScroll').checked = on;
    const c2 = $('#chkAutoScroll2');
    if (c2) c2.checked = on;
    if (on) { S.followPaused = false; showFollowReturn(false); if (S.activeIdx >= 0) setActive(S.activeIdx, true, { force: true }); }
  };
  $('#chkAutoScroll').addEventListener('change', (e) => syncAutoScroll(e.target.checked));
  $('#chkAutoScroll2')?.addEventListener('change', (e) => syncAutoScroll(e.target.checked));
  $('#chkThirdLang')?.addEventListener('change', (e) => {
    S.settings.showMid = e.target.checked;
    applyLangView();
    saveSettings();
  });
  const chkPause = $('#chkPauseLookup');
  if (chkPause) chkPause.addEventListener('change', (e) => { S.settings.pauseOnLookup = e.target.checked; saveSettings(); });
  const btnRecentClear = $('#btnRecentClear');
  if (btnRecentClear) btnRecentClear.addEventListener('click', async () => {
    const ok = await askModal({ title: t('set.recent'), body: t('set.recentConfirm'), okText: t('set.recentClear'), cancelText: t('common.cancel') });
    if (ok) clearAllHistory();
  });

  // --- 右侧英文 / 中文的独立开关 ---
  // 提示条做成 #subs 的兄弟节点：renderSubs 会整块重写 #subs 的内容，
  // 挂在里面的话每次重排都会把它冲掉。
  const subsBox = $('#subs');
  if (subsBox && !$('#bareHint')) {
    subsBox.before(el('div', {
      class: 'reader-bare-hint', id: 'bareHint', hidden: true,
      'data-i18n': 'lang.bare', text: t('lang.bare'),
    }));
  }
  $$('#langSeg button').forEach((b) => {
    b.addEventListener('click', () => toggleLang(b.dataset.lang));
  });
  applyLangView();
  $('#chkWordMark').addEventListener('change', (e) => {
    S.settings.markWords = e.target.checked; saveSettings();
    $('#subs').classList.toggle('nomark', !e.target.checked);
    $('#bigScreen').classList.toggle('nomark', !e.target.checked);
  });

  $('#fbPrev').addEventListener('click', () => jumpCue(-1));
  $('#fbNext').addEventListener('click', () => jumpCue(1));
  $('#fbReplay').addEventListener('click', replayCurrent);
  $('#fbSlower').addEventListener('click', () => {
    const sel = $('#selRate');
    const opts = Array.from(sel.options).map((o) => parseFloat(o.value));
    const cur = player.playbackRate;
    const next = opts.filter((v) => v < cur - 0.001).pop() ?? opts[0];
    sel.value = String(next);
    player.playbackRate = next;
    toast(t('toast.rate', { rate: next }));
  });

  // --- 单词卡片 ---
  $('#wcClose').addEventListener('click', closeWordCard);
  $('#wcSpeak').addEventListener('click', () => {
    const w = S.wordCardFor; if (!w) return;
    speakIn(w.word, w.lang || getMode(), { rate: S.settings.ttsRate });
  });
  $('#wcSpeakSlow').addEventListener('click', () => {
    const w = S.wordCardFor; if (!w) return;
    speakIn(w.word, w.lang || getMode(), { rate: 0.6 });
  });
  $('#wcFav').addEventListener('click', () => { if (S.wordCardFor) toggleFavWord(S.wordCardFor); });

  // --- 抽屉 ---
  $('#btnFavs').addEventListener('click', () => toggleDrawer('favDrawer'));
  $('#favClose').addEventListener('click', () => closeDrawers());
  $('#btnSettings').addEventListener('click', () => toggleDrawer('setDrawer'));
  $('#setClose').addEventListener('click', () => closeDrawers());
  $('#scrim').addEventListener('click', closeDrawers);

  // --- 复习（三选一）---
  $('#btnReview').addEventListener('click', openReview);
  $('#rvClose').addEventListener('click', closeReview);
  $('#rvSpeak').addEventListener('click', speakReview);
  $('#rvSpeakSlow').addEventListener('click', () => {
    const cur = reviewCur();
    if (!cur) return;
    speakIn(cur.quiz.prompt, recLang(cur.rec), { rate: 0.6 });
  });
  $('#rvFinish').addEventListener('click', () => {
    const r = S.review;
    if (!r) return;
    if (r.idx + 1 >= r.queue.length) { r.idx = r.queue.length; renderReview(); }
    else nextReview();
  });
  const syncReviewToggle = (which, on) => {
    const r = S.review;
    if (!r) return;
    r[which] = on;
    const key = which === 'showZh' ? 'reviewShowZh' : which === 'showEn' ? 'reviewShowEn' : 'reviewAutoSpeak';
    S.settings[key] = on;
    saveSettings();
    if (which === 'autoSpeak' && !on) TTS.stopSpeak();
    renderReview();
  };
  $('#rvZhToggle').addEventListener('click', () => syncReviewToggle('showZh', !S.review?.showZh));
  $('#rvEnToggle').addEventListener('click', () => syncReviewToggle('showEn', !S.review?.showEn));
  $('#rvAutoToggle').addEventListener('click', () => syncReviewToggle('autoSpeak', !S.review?.autoSpeak));
  document.addEventListener('keydown', (e) => {
    if ($('#reviewOverlay').hidden || !S.review) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    const done = S.review.idx >= S.review.queue.length;
    if (e.code === 'Space') { e.preventDefault(); if (!done) speakReview(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (done) closeReview();
      else if (S.review.answered) nextReview();
      else if (!$('#rvFinish').hidden) nextReview();
    }
    else if (/^[1-3]$/.test(e.key) && !done && !S.review.answered) {
      e.preventDefault(); answerReview(Number(e.key) - 1);
    }
    else if (e.key === 'Escape') { e.preventDefault(); closeReview(); }
  });
  $('#favSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#favSeg button').forEach((x) => x.classList.toggle('active', x === b));
    S.favTab = b.dataset.tab;
    renderFavs();
  });
  $('#favSearch').addEventListener('input', debounce(renderFavs, 160));
  $('#favBody').addEventListener('click', onFavBodyClick);
  $('#favExport').addEventListener('click', exportFavs);
  $('#favImport').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importFavs(f);
    e.target.value = '';
  });

  // --- 设置项 ---
  $('#setVoice').addEventListener('change', (e) => {
    // 音色按语言分槽：在西语模式里选的记到 voiceEs，英语模式记到 voiceEn
    S.settings[voiceKey()] = e.target.value;
    saveSettings();
  });
  $('#setTtsRate').addEventListener('input', (e) => { S.settings.ttsRate = parseFloat(e.target.value); saveSettings(); });
  $('#setFontSize').addEventListener('input', (e) => {
    S.settings.fontSize = parseInt(e.target.value, 10);
    document.documentElement.style.setProperty('--sub-font', S.settings.fontSize + 'px');
    saveSettings();
  });
  $('#setTransMode').addEventListener('change', (e) => { S.settings.transMode = e.target.value; saveSettings(); });
  $('#setWordTs').addEventListener('change', (e) => { S.settings.wordTs = e.target.value; saveSettings(); });
  // 这个元素是后加的，旧版 index.html 里没有。取不到就跳过绑定，
  // 避免「新 JS + 旧 HTML」混搭时在启动阶段直接抛异常把整个页面打死。
  const modelSel = $('#setAsrModel');
  if (modelSel) modelSel.addEventListener('change', (e) => { switchASRModel(e.target.value); });
  $('#chkKaraoke').addEventListener('change', (e) => {
    S.settings.karaoke = e.target.checked;
    saveSettings();
    if (S.settings.karaoke) prepareKaraoke(S.cueEls[S.activeIdx]);
    else clearKaraoke();
  });
  $('#chkAutoRun').addEventListener('change', (e) => {
    S.settings.autoRun = e.target.checked;
    saveSettings();
    toast(S.settings.autoRun ? t('toast.autoRunOn') : t('toast.autoRunOff'));
  });
  $('#btnCacheAll').addEventListener('click', cacheEverything);
  $('#btnClearCache').addEventListener('click', clearCaches);
  $('#btnTranslateAll').addEventListener('click', () => translateAll({ force: true }));
  $('#btnStopTranslate').addEventListener('click', () => {
    if (S.transAbort) { S.transAbort.abort(); toast(t('toast.transAbort')); }
    else toast(t('toast.transNone'));
  });

  // --- 字幕导出（动态加入工具栏） ---
  const tools = $('.reader-tools');
  const expBtn = el('button', { class: 'btn btn-sm', id: 'btnExportSrt', text: t('cue.exportSrt'), onclick: exportSRT });
  tools.appendChild(expBtn);

  // --- 快捷键 ---
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', (e) => {
    const wc = $('#wordcard');
    if (wc.hidden) return;
    // 收藏抽屉里点出来的词卡，锚点在抽屉里 —— 抽屉跟词卡是兄弟节点，不在
    // wc.contains() 范围里。少了这一条，点收藏里的词卡会「刚弹出来就被关掉」。
    if (wc.contains(e.target) || e.target.closest('.w') || e.target.closest('#favDrawer')) return;
    closeWordCard();
  });
  window.addEventListener('resize', debounce(() => { if (!$('#wordcard').hidden) closeWordCard(); }, 120));

  initMask();
  initReaderRail();
}

/* ============================ 画面烧录字幕遮罩 ============================
   把画面里**烧录进去的**英文字幕就地模糊掉，逼自己先听。
   位置与样式都在 js/subtitle-mask.js 里算，这里只负责跟界面、设置对接。

   自动定位分两条路，各有各的场合：
     · 播放中静默采样 —— 不打断观看，开着遮罩看几秒就把位置悄悄校正了；
     · 整片扫描（设置里的「重新自动定位」）—— 跳着抽十几帧，准得多，
       但要动播放进度，所以只在用户明确点按钮时才做。
========================================================================= */

let mask = null;
let maskDetector = null;
const maskGrabCanvas = document.createElement('canvas');
let maskAutoDone = false;      // 当前这条视频是否已经自动校正过位置
let maskLiveStop = null;       // 停掉「播放中采样」的回调
let maskSeeking = false;       // 整片扫描是否进行中
let maskEditing = false;       // 是否正在「在画面上调整位置」

const maskChipText = () => t('mask.chip');

function initMask() {
  const wrap = $('#playerWrap');
  const video = $('#player');
  if (!wrap || !video) return;

  mask = SUBMASK.createMask({ wrap, video, onBand: onMaskBand });
  maskDetector = SUBMASK.createBandDetector();

  // 播放器栏里的开关。沿用 .pb-btn + 已有的 .on 激活态，风格自动一致。
  const bar = $('#playerBar .pb-right');
  if (bar && !$('#btnMask')) {
    const b = el('button', {
      class: 'pb-btn', id: 'btnMask',
      'data-i18n': 'mask.toggle', 'data-i18n-title': 'mask.toggle', title: t('mask.toggle'),
    });
    b.textContent = t('mask.toggle');
    b.addEventListener('click', toggleMask);
    bar.insertBefore(b, bar.firstChild);
  }

  // 按住 Alt 临时看原文。Alt 在 onKeyDown 里已经被排除，不会跟快捷键打架。
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && !e.repeat) mask?.peek(true); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') mask?.peek(false); });
  window.addEventListener('blur', () => mask?.peek(false));
  // Esc 退出「在画面上调整位置」
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && maskEditing) { e.preventDefault(); setMaskAdjust(false); }
  });

  bindMaskSettingsUI();
  onLangChange(() => {
    mask?.setChipText(maskChipText());
    mask?.setEditHint(t('set.mask.adjustHint'));
    mask?.setDoneLabel(t('set.mask.adjustDone'));
    refreshMaskAdjustBtn();
    const b = $('#btnMask');
    if (b) b.title = t('mask.toggle');
  });
  applyMaskState();
}

/** 把设置写进遮罩与面板，两边的显示永远一致 */
function applyMaskState() {
  if (!mask) return;
  const m = S.settings.mask;
  mask.setState({ ...m });
  mask.setChipText(maskChipText());

  const btn = $('#btnMask');
  if (btn) btn.classList.toggle('on', !!m.enabled);

  const setVal = (id, v) => { const n = $(id); if (n) n.value = v; };
  const setChk = (id, v) => { const n = $(id); if (n) n.checked = !!v; };
  setChk('#chkMask', m.enabled);
  setVal('#setMaskStyle', m.style);
  setVal('#setMaskStrength', m.strength);
  setChk('#chkMaskAuto', m.auto);
  setVal('#setMaskTop', Math.round(m.topRatio * 100));
  setVal('#setMaskBottom', Math.round(m.bottomRatio * 100));
  saveSettings();
}

function toggleMask() {
  const m = S.settings.mask;
  if (!m.enabled && !S.file) { toast(t('toast.maskNoVideo')); return; }
  m.enabled = !m.enabled;
  applyMaskState();
  toast(m.enabled ? t('toast.maskOn') : t('toast.maskOff'));
  if (m.enabled) {
    mask?.reposition();
    if (m.auto) startMaskLiveDetect();
  } else {
    stopMaskLiveDetect();
    if (maskEditing) setMaskAdjust(false, { quiet: true });
  }
}

/* ---- 在画面上拖动调整位置 ---- */

/** 设置面板里那颗按钮跟着编辑态走 */
function refreshMaskAdjustBtn() {
  const b = $('#btnMaskAdjust');
  if (!b) return;
  b.classList.toggle('on', maskEditing);
  b.textContent = t(maskEditing ? 'set.mask.adjustDone' : 'set.mask.adjust');
}

/**
 * 进出「在画面上调整位置」。
 * 开启时会顺手把遮罩打开、把自动定位关掉 —— 手动摆过之后就别再被自动结果覆盖。
 */
function setMaskAdjust(on, { quiet = false } = {}) {
  const m = S.settings.mask;
  if (on && !S.file) { toast(t('toast.maskNoVideo')); return; }
  if (!!on === maskEditing) return;

  maskEditing = !!on;
  if (maskEditing) {
    m.enabled = true;
    m.auto = false;
    maskAutoDone = true;        // 手动定位优先，别再让采样结果盖掉
    stopMaskLiveDetect();
    applyMaskState();
    mask?.setEditing(true);
    mask?.setEditHint(t('set.mask.adjustHint'));
    mask?.setDoneLabel(t('set.mask.adjustDone'));
    mask?.reposition();
    closeDrawers();             // 设置面板的蒙层会挡住画面，必须让开
    if (!quiet) toast(t('toast.maskAdjustOn'));
  } else {
    mask?.setEditing(false);
    mask?.setChipText(maskChipText());
    saveSettings();
    if (!quiet) toast(t('toast.maskAdjusted'));
  }
  refreshMaskAdjustBtn();
}

/** 遮罩在画面上被拖动时回调：拖动中只更新滑杆，松手才落盘 */
function onMaskBand(ev) {
  if (!ev) return;
  if (ev.phase === 'done') { setMaskAdjust(false); return; }   // 画面上的「完成」按钮
  const m = S.settings.mask;
  m.topRatio = ev.topRatio;
  m.bottomRatio = ev.bottomRatio;
  if (ev.phase !== 'end') {
    const a = $('#setMaskTop'), b = $('#setMaskBottom');
    if (a) a.value = Math.round(m.topRatio * 100);
    if (b) b.value = Math.round(m.bottomRatio * 100);
    return;
  }
  m.auto = false;
  applyMaskState();
  mask?.setChipText(maskChipText());
}

function stopMaskLiveDetect() { maskLiveStop?.(); maskLiveStop = null; }

/** 播放中静默采样：不碰播放进度，攒够帧数再回填位置 */
function startMaskLiveDetect() {
  stopMaskLiveDetect();
  if (!mask || !maskDetector || maskAutoDone) return;
  const video = $('#player');
  if (!video || !video.videoWidth) return;

  maskDetector.reset();
  let stopped = false;
  let lastGrab = 0;
  const t0 = performance.now();

  const finish = () => {
    if (stopped) return;
    stopped = true;
    maskLiveStop = null;
    maskAutoDone = true;
    const r = maskDetector.result();
    if (r) applyDetectedBand(r, false);
    else mask.setChipText(t('mask.chipNoSub'));
  };

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    // 帧之间至少隔 200ms：字幕是几秒一换，采太密拿不到「会变化」这个特征
    if (now - lastGrab >= 200) {
      lastGrab = now;
      SUBMASK.grabGrayFrame(video, maskDetector, maskGrabCanvas);
    }
    const el = now - t0;
    if (maskDetector.frames >= 60) return finish();
    if (maskDetector.frames >= 24 && el > 6000) return finish();
    if (el > 30000) return finish();
    next();
  };

  const next = () => {
    if (stopped) return;
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };

  maskLiveStop = () => { stopped = true; };
  next();
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; video.removeEventListener('seeked', finish); resolve(); };
    video.addEventListener('seeked', finish);
    try { video.currentTime = time; } catch { finish(); }
    setTimeout(finish, 2500);   // 个别文件 seek 不回调，别把流程挂死
  });
}

/** 整片扫描：跳着抽帧，只按时间取，不看画面内容，最准但要动进度 */
async function runMaskSeekScan() {
  if (maskSeeking) { toast(t('toast.maskDetectBusy')); return; }
  const video = $('#player');
  if (!video || !video.videoWidth || !isFinite(video.duration) || !video.duration) {
    toast(t('toast.maskNoVideo'));
    return;
  }
  maskSeeking = true;
  const wasPaused = video.paused;
  const backTo = video.currentTime;
  const det = SUBMASK.createBandDetector({ maxFrames: 18 });
  const canvas = document.createElement('canvas');
  mask.setChipText(t('mask.chipDetecting'));
  try {
    video.pause();
    const N = 14;
    for (let i = 0; i < N; i++) {
      await seekTo(video, video.duration * ((i + 0.5) / N));
      SUBMASK.grabGrayFrame(video, det, canvas);
    }
  } finally {
    await seekTo(video, backTo);
    if (!wasPaused) video.play().catch(() => {});
    maskSeeking = false;
  }
  const r = det.result();
  if (r) applyDetectedBand(r, true);
  else { toast(t('toast.maskDetectNone')); mask.setChipText(maskChipText()); }
}

function applyDetectedBand(r, announce) {
  const m = S.settings.mask;
  // 检测出来的是**文字本身**占的行。遮罩要比它上下各宽一点，
  // 否则文字正好压在羽化边缘上，笔画糊不干净（会剩一排黑点）。
  const pad = Math.max(0.008, (r.bottomRatio - r.topRatio) * 0.3);
  m.topRatio = clamp(r.topRatio - pad, 0.05, 0.97);
  m.bottomRatio = clamp(r.bottomRatio + pad, 0.08, 1);
  applyMaskState();
  mask?.reposition();
  mask.setChipText(maskChipText());
  if (announce) {
    toast(t('toast.maskDetected', {
      top: Math.round(m.topRatio * 100), bottom: Math.round(m.bottomRatio * 100),
    }));
  }
}

function bindMaskSettingsUI() {
  const on = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };

  on('#chkMask', 'change', (e) => {
    S.settings.mask.enabled = e.target.checked;
    applyMaskState();
    if (!e.target.checked) {
      stopMaskLiveDetect();
      if (maskEditing) setMaskAdjust(false, { quiet: true });
      return;
    }
    if (!S.file) { toast(t('toast.maskNoVideo')); return; }
    if (S.settings.mask.auto) startMaskLiveDetect();
  });
  on('#setMaskStyle', 'change', (e) => { S.settings.mask.style = e.target.value; applyMaskState(); });
  on('#setMaskStrength', 'input', (e) => { S.settings.mask.strength = +e.target.value; applyMaskState(); });
  on('#chkMaskAuto', 'change', (e) => {
    S.settings.mask.auto = e.target.checked;
    saveSettings();
    if (e.target.checked) { maskAutoDone = false; startMaskLiveDetect(); }
  });
  // 手动拖边界就说明用户不信任自动定位了，顺手把自动关掉
  on('#setMaskTop', 'input', (e) => {
    const m = S.settings.mask;
    m.topRatio = clamp(+e.target.value / 100, 0.05, Math.min(0.97, m.bottomRatio - 0.02));
    m.auto = false;
    applyMaskState();
  });
  on('#setMaskBottom', 'input', (e) => {
    const m = S.settings.mask;
    m.bottomRatio = clamp(+e.target.value / 100, Math.max(0.08, m.topRatio + 0.02), 1);
    m.auto = false;
    applyMaskState();
  });
  on('#btnMaskAdjust', 'click', () => setMaskAdjust(!maskEditing));
  on('#btnMaskDetect', 'click', () => runMaskSeekScan());
  on('#btnMaskReset', 'click', () => {
    Object.assign(S.settings.mask, {
      topRatio: SUBMASK.MASK_DEFAULTS.topRatio,
      bottomRatio: SUBMASK.MASK_DEFAULTS.bottomRatio,
      auto: true,
    });
    maskAutoDone = false;
    applyMaskState();
    mask?.reposition();
  });
}

/** 换了素材：位置要重算，自动定位要重新来一遍 */
function resetMaskForNewVideo() {
  maskAutoDone = false;
  stopMaskLiveDetect();
  if (maskEditing) setMaskAdjust(false, { quiet: true });   // 换了视频就别停在编辑态
  maskDetector?.reset();
  mask?.reposition();
  if (!S.settings.mask.enabled || !S.settings.mask.auto) return;
  const video = $('#player');
  if (!video) return;
  const go = () => { mask?.reposition(); startMaskLiveDetect(); };
  if (video.readyState >= 2) go();
  else video.addEventListener('loadeddata', go, { once: true });
}

/* ============================ 视频载入 ============================ */

/** File System Access 导入：只在用户手势里调用；不支持/取消/报错都退回 input。 */
async function openViaPicker() {
  if (!hasFileHandleSupport()) return false;
  const types = [{
    description: 'Video or audio',
    accept: {
      'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v'],
      'audio/*': ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.opus', '.flac'],
    },
  }];
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types, excludeAcceptAllOption: false });
    if (!handle) return false;
    const file = await handle.getFile();
    await openVideoFile(file, { fileHandle: handle });
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return true;   // 用户取消：不要偷偷再开一个选择框
    console.warn('[continue] picker unavailable, falling back', e);
    return false;
  }
}

async function openVideoFile(file, opts = {}) {
  if (!LIC_ON && !needLicense()) return;
  // 换了素材：作废正在进行的识别与翻译，避免旧结果写进新视频
  S.asrRun++;
  ASR.cancel();
  if (S.transAbort) { S.transAbort.abort(); S.transAbort = null; }
  S.recog = false;
  S.lastFail = null;
  clearKaraoke();

  // 从句柄重开时沿用原 key（字幕属于哪个媒体由原 key 决定），
  // 但只有 openVideoFile 内部实际校验过的文件才会走到这里。
  const key = opts.sessionKey || sessionIdFor(file);
  const prev = loadSession(key);
  const restored = prev && prev.key === key && prev.cues.length ? prev : null;
  if (!restored && S.mediaPending && S.name && S.name !== file.name) {
    toast(t('media.fileMismatch'), 4000);
  }

  const isAudioOnly = /^audio\//.test(file.type) || /\.(mp3|m4a|wav|aac|flac|ogg|opus)$/i.test(file.name);
  const player = $('#player');
  const url = URL.createObjectURL(file);
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = url;
  player.load();
  S.name = file.name;
  S.file = file;
  S.sessionKey = key;
  S.mediaPending = false;
  S.pendingHandleKey = null;
  renderMediaNotice();
  // 只有 File System Access 用户手势导入才可能带句柄；普通 input/拖放没有
  if (opts.fileHandle && hasFileHandleSupport()) {
    saveHandle(key, opts.fileHandle).then(() => { refreshRecentEntries(); });
  }
  // 同一文件之前识别过：直接恢复字幕与译文，不重复跑识别
  // 原样恢复 words（真实逐词时间戳）；没有 words 才让 wordTimings 去估算
  S.cues = restored ? restored.cues.map((c, i) => ({ ...c, i })) : [];
  S.cues.forEach((c) => { delete c._wt; });
  S.recogLang = restored ? restored.recogLang : null;
  S.activeIdx = -1;
  S.resumeAt = restored ? restored.at : 0;
  S.lastStatus = restored ? restored.status : null;
  S.audioOnly = isAudioOnly;
  const wrap = $('#playerWrap');
  wrap.classList.toggle('audio-only', isAudioOnly);
  const badge = $('#audioBadge') || (() => {
    const b = el('div', { class: 'audio-badge', id: 'audioBadge' });
    wrap.appendChild(b);
    return b;
  })();
  badge.hidden = !isAudioOnly;
  if (isAudioOnly) badge.innerHTML = `<div class="ab-title">${escapeHtml(file.name)}</div><div class="ab-sub">${escapeHtml(t('audioOnly.sub'))}</div>`;
  // 纯音频没有画面，把下方的空间让给大字阅读区
  $('#bigScreen').hidden = !isAudioOnly;
  renderBigScreen();
  renderSubs();
  $('#dropzone').classList.add('hide');
  resetMaskForNewVideo();
  $('#playerBar').hidden = false;
  $('#btnTranscribe').disabled = false;
  setText('btnTranscribeLabel', t('top.start'));
  resetProgress();
  toast(t('toast.loaded', { name: file.name, size: (file.size / 1048576).toFixed(1) }));

  // 恢复的字幕直接显示在右侧；只有没有字幕时才自动识别
  if (restored && restored.cues.length) {
    renderSubs();
    toast(t('dz.recentStatus', { n: restored.cues.length, t: fmtTime(restored.at || 0) }), 4000);
    const missingZh = restored.cues.some((c) => !c.zh);
    if (missingZh && S.settings.transMode === 'local') translateAll({ retry: true });
  } else if (S.settings.autoRun) {
    autoRunAfterLoad(file);
  }
  persistSession({ status: restored?.status || 'processing' });
}

/** 等媒体元数据就绪拿到时长，再排队自动识别（若上一任务未结束会先等它让出） */
async function autoRunAfterLoad(file) {
  await waitMetadata($('#player'));
  if (S.file !== file) return;          // 期间又换了素材
  await waitIdle();
  if (S.file !== file) return;
  if (!S.settings.autoRun) return;
  if (S.cues.length && S.cues.some((c) => c.text)) return;  // 已有内容（例如刚导入过字幕）
  runTranscribe();
}

function waitMetadata(player) {
  return new Promise((resolve) => {
    if (player.readyState >= 1 && isFinite(player.duration)) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      player.removeEventListener('loadedmetadata', done);
      resolve();
    };
    player.addEventListener('loadedmetadata', done);
    // 元数据异常时不要卡住自动识别
    setTimeout(done, 6000);
  });
}

async function waitIdle(timeoutMs = 180000) {
  const t0 = Date.now();
  while (S.busy && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function loadDemo() {
  try {
    const res = await fetch('media/demo.m4a', { cache: 'force-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const file = new File([blob], 'demo-english.m4a', { type: 'audio/mp4' });
    await openVideoFile(file);
    if (!S.settings.autoRun) toast(t('toast.demoLoadedAutoOff'));
  } catch (e) {
    toast(t('toast.demoAudioFail', { msg: e.message }));
  }
}

function updateDuration() {
  const player = $('#player');
  setText('tDur', fmtTime(player.duration));
  const d = player.duration;
  if (d > 5400) toast(t('toast.longVideo'), 5000);
}

function togglePlay() {
  const p = $('#player');
  if (!p.src) return;
  if (p.paused) {
    S.wordCardPause && (S.wordCardPause.userPaused = false);
    p.play().catch(() => {});
  } else {
    markUserPaused();
    p.pause();
  }
}

function seekBy(d) {
  const p = $('#player');
  if (!p.src) return;
  S.stopAt = null;
  p.currentTime = clamp(p.currentTime + d, 0, p.duration || 0);
}

function syncPlayIcon() {
  $('#playIcon').innerHTML = $('#player').paused
    ? '<path d="M8 5l11 7-11 7z"/>'
    : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
}

/* ============================ 播放跟随 ============================ */

function startTick() {
  const loop = () => {
    S.rafId = requestAnimationFrame(loop);
    const p = $('#player');
    if (!p.src) return;

    if (p.duration) {
      const v = Math.round((p.currentTime / p.duration) * 1000);
      const seek = $('#seek');
      if (document.activeElement !== seek) seek.value = String(v);
      setText('tCur', fmtTime(p.currentTime));
    }

    // 逐词跟读：说到哪个词就把哪个词染成浅绿，依次推进
    updateKaraoke(p.currentTime);

    if (S.stopAt !== null && p.currentTime >= S.stopAt - 0.02) {
      const c = S.cues[S.activeIdx];
      if (S.loop && c) {
        p.currentTime = c.start;
      } else {
        S.stopAt = null;
        p.pause();
      }
    }
  };
  loop();
}

let lastPersist = 0;

function restorePositionOnLoad() {
  const player = $('#player');
  if (!S.resumeAt || !S.sessionKey) return;
  const at = Math.min(S.resumeAt, Math.max(0, (player.duration || S.resumeAt) - 0.5));
  if (at > 0.2) {
    player.currentTime = at;
    const i = findCue(at);
    if (i >= 0) setActive(i, true);
  }
  S.resumeAt = 0;
}

function onTimeUpdate() {
  // 每 4 秒把真实位置写一次；不写文件内容、不写路径
  if (!S.file || !S.sessionKey) return;
  const now = performance.now();
  if (now - lastPersist < 4000) return;
  lastPersist = now;
  persistSession({ status: S.recog ? 'processing' : (S.cues.length ? (S.lastStatus === 'failed' ? 'failed' : 'ready') : 'partial') });
}

function findCue(t) {
  const cues = S.cues;
  if (!cues.length) return -1;
  let lo = 0, hi = cues.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return -1;
  if (t <= cues[best].end + 0.4) return best;
  return -1;
}

setInterval(() => {
  const p = $('#player');
  if (!p.src || !S.cues.length) return;
  // 暂停时不重新判定当前句：用户手动点的句子应该一直留着高亮，
  // 也避免刚 seek 完媒体时钟还没跟上就把高亮清掉。
  if (p.paused) return;
  const idx = findCue(p.currentTime);
  if (idx >= 0 && idx !== S.activeIdx) setActive(idx, true);
}, 110);

/* ============================ 逐词跟读高亮 ============================ */

const K = { cueIdx: -1, groups: [], mark: -3, spoken: -1 };

function clearKaraoke() {
  for (const g of K.groups) for (const n of g) n.classList.remove('said', 'now');
  K.cueIdx = -1; K.groups = []; K.mark = -3; K.spoken = -1;
}

/**
 * 为当前句准备好按词索引对齐的 DOM 节点。
 * 右侧列表与大字区各是一组，两组同步推进。
 */
function prepareKaraoke(cueEl) {
  clearKaraoke();
  if (S.settings.karaoke === false) return;
  const idx = S.activeIdx;
  const cue = S.cues[idx];
  if (!cue || cue.noAudio) return;
  if (!cue._wt) cue._wt = SUB.wordTimings(cue);
  const wt = cue._wt;
  if (!wt || !wt.length) return;

  const groups = [];
  if (cueEl) {
    const nodes = Array.from(cueEl.querySelectorAll('.cue-en .w'));
    if (nodes.length === wt.length) groups.push(nodes);
  }
  const big = $('#bigScreen');
  if (big && !big.hidden) {
    const nodes = Array.from($('#bsEn').querySelectorAll('.w'));
    if (nodes.length === wt.length) groups.push(nodes);
  }
  K.cueIdx = idx;
  K.groups = groups;
  K.mark = -3; K.spoken = -1;
  updateKaraoke($('#player').currentTime || 0);
}

/**
 * @param {number} mark   正在说的那个词的序号，-1 表示此刻处在词间停顿
 * @param {number} spoken 已经完整说完的词数
 */
function paintKaraoke(mark, spoken) {
  if (mark === K.mark && spoken === K.spoken) return;
  const prevMark = K.mark, prevSpoken = K.spoken;
  K.mark = mark; K.spoken = spoken;
  // 跳转（拖动进度条、换句）或跨度较大时整段重刷，避免残留
  const jump = prevSpoken < 0 || spoken < prevSpoken || spoken - prevSpoken > 6;
  for (const g of K.groups) {
    if (jump) {
      for (let i = 0; i < g.length; i++) {
        g[i].classList.toggle('said', i < spoken);
        g[i].classList.toggle('now', i === mark);
      }
    } else {
      if (prevMark >= 0 && prevMark < g.length) g[prevMark].classList.remove('now');
      for (let i = prevSpoken; i < spoken && i < g.length; i++) g[i].classList.add('said');
      if (mark >= 0 && mark < g.length) g[mark].classList.add('now');
    }
  }
}

function updateKaraoke(time) {
  if (S.settings.karaoke === false) return;
  if (K.cueIdx !== S.activeIdx || !K.groups.length) return;
  const wt = S.cues[S.activeIdx]?._wt;
  if (!wt) return;
  let spoken = 0;
  while (spoken < wt.length && wt[spoken].e <= time) spoken++;
  const mark = (spoken < wt.length && time >= wt[spoken].s - 0.02) ? spoken : -1;
  paintKaraoke(mark, spoken);
}

/* ============================ 字幕渲染 ============================ */

/* ---------------- 右侧英文 / 中文的独立开关 ----------------

   为什么用「容器加 class」而不是改 cueInnerHTML 决定渲不渲染：
   识别过程中每 500ms 就要整块重排一次字幕，重建 DOM 已经不便宜了；
   开关只是眼睛想不想看的事，切一个 class 是零成本，而且不影响
   已经渲染出来的 DOM（点一下立刻生效，不用等重排）。
---------------------------------------------------------- */

/** 字幕里有没有「中间那行」（西语模式多出来的英文翻译）。

    判断依据带上「字幕自己有没有 mid」，而不是只看当前模式：用户答「先不重识别」
    的时候，模式已经切到英语、字幕却还是西语那套，那时中间那行还在（也还有用），
    开关就得留着 —— 否则就会出现「看得见英文翻译、却没有按钮关掉它」。
    反过来一旦按英语重新识别过，cue 里没有 mid 了，开关自然消失。 */
/** 当前字幕的**内容**语言 —— 就是识别时用的语言。
 *  不能直接用模式：用户对「要按西语重新识别吗」答了「先不重识别」时，
 *  模式已经切到英语、字幕却还是西语那一套，读出来当然还是西语。
 *  还没识别过任何东西时才退回模式。 */
function subLang() { return S.recogLang || getMode(); }

function subHasMidLine() {
  return subLang() === 'es' || S.cues.some((c) => c.mid);
}

function toggleLang(which) {
  if (which === 'mid') {
    // 英语模式没有中间那一行。按钮那时是藏起来的，这里再兜一道。
    if (!subHasMidLine()) return;
    S.settings.showMid = S.settings.showMid === false;   // 默认是 true，取反
  } else {
    const key = which === 'en' ? 'showEn' : 'showZh';
    S.settings[key] = S.settings[key] === false;   // 默认是 true，取反
  }
  applyLangView();
  saveSettings();
}

function applyLangView() {
  const srcEs = subHasMidLine();
  const en = S.settings.showEn !== false;                        // 原文那一行
  const mid = srcEs && S.settings.showMid !== false;             // 西语模式：英文翻译
  const zh = S.settings.showZh !== false;                        // 中文

  const subs = $('#subs');
  if (subs) {
    subs.classList.toggle('hide-en', !en);
    subs.classList.toggle('hide-mid', !mid);
    subs.classList.toggle('hide-zh', !zh);
    subs.classList.toggle('bare', !en && !mid && !zh);
  }
  const big = $('#bigScreen');
  if (big) {
    big.classList.toggle('hide-en', !en);
    big.classList.toggle('hide-mid', !mid);
    big.classList.toggle('hide-zh', !zh);
  }

  // 原文那个按钮的标签跟着识别语言走：英语模式叫「英文」，西语模式叫「西语」。
  // 它没有 data-i18n（写死会被 applyI18n 覆盖成「英文」），所以这里连界面语言
  // 变化的时候也要重新写一遍 —— 所以 applyLangView 挂在 onLangChange 上。
  const srcBtn = $('#langSeg button[data-lang="en"]');
  if (srcBtn) {
    srcBtn.textContent = t(srcEs ? 'lang.es' : 'lang.en');
    srcBtn.title = t(srcEs ? 'lang.esHint' : 'lang.enHint');
  }
  const midBtn = $('#langSeg button[data-lang="mid"]');
  if (midBtn) midBtn.hidden = !srcEs;

  $$('#langSeg button').forEach((b) => {
    const on = b.dataset.lang === 'mid' ? mid : (b.dataset.lang === 'zh' ? zh : en);
    b.classList.toggle('active', on);
  });
  const hint = $('#bareHint');
  if (hint) hint.hidden = en || mid || zh;
  // ⚠️ 这里**不**写存档：applyLangView 挂在 renderSubs 上（字幕一重排就跟着刷），
  //    识别过程中每 500ms 存一次 localStorage 是白费力气。谁改了设置谁自己存 ——
  //    见 toggleLang 末尾的 saveSettings()。
}

/* ---------------- 收起 / 展开整个右侧面板 ----------------

   左右那两个开关管的是「哪一列文字」，这个管的是「面板本身要不要在」。
   纯听力练习时右侧整块都不需要，收起来让视频占满屏；想核对时点一下把手。
   ⚠️ 面板宽度一变，视频可用区域跟着变（黑边比例也变），所以要把字幕遮罩
   重新定位一次。遮罩模块自己挂着 ResizeObserver，这里再显式补一次是为了
   让位置在同一帧就更新，别让用户看到遮罩短暂错位。
---------------------------------------------------------- */

function toggleReader() {
  S.settings.readerCollapsed = !S.settings.readerCollapsed;
  applyReaderCollapsed();
  saveSettings();
}

function applyReaderCollapsed() {
  const reader = $('.reader');
  if (!reader) return;
  const off = !!S.settings.readerCollapsed;
  reader.classList.toggle('collapsed', off);

  const rail = $('#readerRail');
  if (rail) {
    rail.textContent = off ? t('reader.open') : t('reader.collapse');
    rail.title = off ? t('reader.openHint') : t('reader.collapseHint');
  }
  mask?.reposition();
  requestAnimationFrame(() => mask?.reposition());
}

function initReaderRail() {
  const reader = $('.reader');
  if (!reader || $('#readerRail')) return;
  const rail = el('button', {
    class: 'reader-rail', id: 'readerRail', type: 'button',
    'aria-label': t('reader.collapseHint'),
  });
  rail.addEventListener('click', toggleReader);
  reader.appendChild(rail);
  onLangChange(() => applyReaderCollapsed());
  applyReaderCollapsed();
}

function setCues(cues, { translate = true } = {}) {
  S.cues = cues;
  S.activeIdx = -1;
  renderSubs();
  if (S.sessionKey && cues.length) persistSession({ status: 'processing' });
  // retry：若此刻识别任务还没让出，就等它结束后再翻译
  if (translate && cues.length) translateAll({ retry: true });
}

function renderSubs(filter = '') {
  // 字幕内容一变，「有没有中间那行」就可能跟着变（识别完 / 重新识别完 /
  // 切完模式把 cue 换掉），那一栏开关的标签和显隐得在同一帧校准。
  // 只动 class 与 textContent，不重排 DOM，放在这里当副作用是安全的。
  applyLangView();
  const box = $('#subs');
  const scrollTop = box.scrollTop;
  box.innerHTML = '';
  S.cueEls = [];
  if (!S.cues.length) {
    const empty = el('div', { class: 'empty' });
    if (S.recog) {
      empty.innerHTML = `<div class="recog-spin"></div><p>${escapeHtml(t('recog.running'))}</p>` +
        `<p class="muted">${t('recog.runningHint')}</p>`;
    } else {
      empty.innerHTML = `<p>${escapeHtml(t('empty.none'))}</p><p class="muted">${t('empty.hint')}</p>` +
        `<div class="empty-actions"><label class="btn btn-sm btn-primary" for="fileVideo">${escapeHtml(t('dz.choose'))}</label></div>`;
    }
    box.appendChild(empty);
    clearKaraoke();
    return;
  }
  const frag = document.createDocumentFragment();
  S.cues.forEach((c, i) => {
    const node = el('div', { class: 'cue' + (c.noAudio ? ' noaudio' : ''), 'data-i': String(i) });
    node.innerHTML = cueInnerHTML(c);
    frag.appendChild(node);
    S.cueEls.push(node);
  });
  box.appendChild(frag);
  if (S.recog) {
    box.appendChild(el('div', {
      class: 'recog-hint',
      html: `<span class="recog-dot"></span>${escapeHtml(t('recog.progress', { n: S.cues.length }))}`,
    }));
  }
  if (filter) applySearch(filter, true);
  // 重建 DOM 后恢复当前句高亮与滚动位置
  const active = S.cueEls[S.activeIdx];
  if (active) active.classList.add('active');
  if (S.recog && !filter && !S.followPaused) {
    // 识别过程中贴着底部看最新句子；用户一旦主动滚动就不再抢
    box.scrollTop = box.scrollHeight;
  } else if (filter) {
    box.scrollTop = 0;
  } else {
    box.scrollTop = scrollTop;
  }
  showFollowReturn(S.followPaused && S.cues.length > 0);
  renderBigScreen();
  prepareKaraoke(active);
}

function wordSpansHTML(text) {
  let en = '';
  for (const tok of SUB.tokenize(text)) {
    if (SUB.isWordToken(tok)) {
      const nw = DICT.normalizeWord(tok);
      const saved = S.favWords.has(favWordId(nw, favLang())) ? ' saved' : '';
      en += `<span class="w${saved}" data-w="${escapeHtml(nw)}">${escapeHtml(tok)}</span>`;
    } else {
      en += escapeHtml(tok);
    }
  }
  return en;
}

function cueInnerHTML(c) {
  const en = wordSpansHTML(c.text);
  // 中间那行只在源语言不是英语时才有（西语模式 = 西语原文的英文翻译）。
  // 英语模式下 c.mid 恒为空，这里就什么都不加 —— 版面跟以前完全一样。
  const midHTML = c.mid
    ? `<div class="cue-mid">${escapeHtml(c.mid)}</div>`
    : (S.busy === 'mt' && c._pendingMid
      ? `<div class="cue-mid pending">${escapeHtml(t('cue.translating'))}</div>`
      : '');
  const zh = c.zh
    ? `<div class="cue-zh">${escapeHtml(c.zh)}</div>`
    : (S.busy === 'mt' || c._pending
      ? `<div class="cue-zh pending">${escapeHtml(t('cue.translating'))}</div>`
      : `<div class="cue-zh pending">${escapeHtml(t('cue.noTranslation'))}</div>`);
  return `<div class="cue-time"><span>${fmtTime(c.start)}</span>` +
    `<span class="cue-actions">` +
    `<button data-act="speak" data-i18n-title="cue.speak" title="${escapeHtml(t('cue.speak'))}">${escapeHtml(t('cue.speak'))}</button>` +
    `<button data-act="play" data-i18n-title="cue.play" title="${escapeHtml(t('cue.play'))}">${escapeHtml(t('cue.play'))}</button>` +
    `<button data-act="fav" data-i18n-title="cue.fav" title="${escapeHtml(t('cue.fav'))}">${S.favSentences.has(sentId(c)) ? escapeHtml(t('cue.saved')) : escapeHtml(t('cue.fav'))}</button>` +
    `<button data-act="copy" data-i18n-title="cue.copy" title="${escapeHtml(t('cue.copy'))}">${escapeHtml(t('cue.copy'))}</button>` +
    `</span></div>` +
    `<div class="cue-en">${en}</div>${midHTML}${zh}`;
}

function showFollowReturn(on) {
  const b = $('#followReturn');
  if (!b) return;
  b.hidden = !on;
  b.title = t('follow.paused');
}

function setActive(idx, scroll, { force = false } = {}) {
  if (idx !== S.activeIdx) {
    const prev = S.cueEls[S.activeIdx];
    if (prev) prev.classList.remove('active');
    S.activeIdx = idx;
  }
  const node = S.cueEls[idx];
  if (!node) { clearKaraoke(); renderBigScreen(); return; }
  // 每次都重新打上标记：renderSubs 会重建 DOM，早退会丢掉高亮
  node.classList.add('active');
  // 只在用户没主动滚动、且仍开启跟随时才自动拉回；force 只给「回到当前句」用
  const followed = S.settings.autoScroll && (!S.followPaused || force);
  if (scroll && followed) {
    const box = $('#subs');
    const nr = node.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    if (nr.top < br.top + 24 || nr.bottom > br.bottom - 24) {
      box.scrollTop += nr.top - br.top - br.height / 2 + nr.height / 2;
    }
    showFollowReturn(false);
  }
  renderBigScreen();
  prepareKaraoke(node);
}

function renderBigScreen() {
  const box = $('#bigScreen');
  if (box.hidden) return;
  const cue = S.cues[S.activeIdx];
  if (!cue) {
    setText('bsTag', t('bs.tag'));
    $('#bsEn').innerHTML = `<span class="bs-empty">${escapeHtml(t('bs.placeholder'))}</span>`;
    $('#bsMid').textContent = '';
    $('#bsZh').textContent = '';
    return;
  }
  setText('bsTag', `${t('bs.tag')} · ${fmtTime(cue.start)}`);
  $('#bsEn').innerHTML = wordSpansHTML(cue.text);
  $('#bsMid').textContent = cue.mid || '';
  $('#bsZh').textContent = cue.zh || t('bs.noZh');
}

function onSubsClick(e) {
  const actBtn = e.target.closest('.cue-actions button');
  const cueEl = e.target.closest('.cue');
  if (!cueEl) return;
  const idx = parseInt(cueEl.dataset.i, 10);
  const cue = S.cues[idx];
  if (!cue) return;

  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.act;
    if (act === 'speak') speakIn(cue.text, subLang(), { rate: S.settings.ttsRate });
    else if (act === 'play') playCueAudio(idx);
    else if (act === 'fav') { toggleFavSentence(cue); renderSubs($('#subSearch').value.trim()); setActive(idx, false); }
    else if (act === 'copy') {
      navigator.clipboard?.writeText([cue.text, cue.mid, cue.zh].filter(Boolean).join('\n'))
        .then(() => toast(t('cue.copyDone'))).catch(() => toast(t('cue.copyFail')));
    }
    return;
  }

  const w = e.target.closest('.w');
  if (w) {
    const word = w.dataset.w;
    markWord(w);
    openWordCard(word, w, idx, { fromSentence: true });
    return;
  }

  if (!cue.noAudio) {
    $('#player').currentTime = cue.start;
    if (S.view === 'focus') $('#player').play().catch(() => {});
  }
  setActive(idx, true);
}

function markWord(node) {
  $$('#subs .w.sel').forEach((x) => x.classList.remove('sel'));
  node.classList.add('sel');
}

function playCueAudio(idx) {
  const cue = S.cues[idx];
  if (!cue || cue.noAudio) return;
  const p = $('#player');
  S.stopAt = cue.end;
  p.currentTime = cue.start;
  p.play().catch(() => {});
  setActive(idx, true);
}

function replayCurrent() {
  if (S.activeIdx < 0) { const i = findCue($('#player').currentTime); if (i < 0) return; return playCueAudio(i); }
  playCueAudio(S.activeIdx);
}

function toggleLoop() {
  S.loop = !S.loop;
  $('#btnLoopSent').classList.toggle('on', S.loop);
  toast(S.loop ? t('toast.loopOn') : t('toast.loopOff'));
}

function jumpCue(dir) {
  if (!S.cues.length) return;
  let i = S.activeIdx;
  if (i < 0) i = findCue($('#player').currentTime);
  if (i < 0) i = dir > 0 ? -1 : S.cues.length;
  const next = clamp(i + dir, 0, S.cues.length - 1);
  if (S.cues[next].noAudio) { setActive(next, true); return; }
  playCueAudio(next);
}

function applySearch(q, quiet) {
  const box = $('#subs');
  $$('#subs .w.hl').forEach((x) => x.classList.remove('hl'));
  $$('#subs .cue.hit').forEach((x) => x.classList.remove('hit'));
  if (!q) return;
  const needle = q.toLowerCase();
  let hits = 0;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.parentElement?.closest('.cue-actions')) continue;
    if (n.nodeValue.toLowerCase().includes(needle)) targets.push(n);
  }
  for (const n of targets) {
    const cueEl = n.parentElement.closest('.cue');
    cueEl?.classList.add('hit');
    hits++;
  }
  if (!quiet) toast(hits ? t('toast.found', { n: hits }) : t('toast.notFound'));
}

/* ---------------- 朗读音色：按语言分槽 ----------------
   英语模式和西语模式用两套音色，各记各的（voiceEn / voiceEs），
   切换模式时下拉列表与默认音色一起换。 */

/** 当前模式该读哪个槽位。 */
const voiceKey = (lang = getMode()) => (lang === 'es' ? 'voiceEs' : 'voiceEn');

/** 当前模式选中的音色名（空串 = 自动挑一个）。 */
function currentVoiceName(lang) { return S.settings[voiceKey(lang)] || ''; }

/** 用指定的语言朗读一段文本（音色取该语言自己的槽位）。
 *  收藏里的句子英语西语混在一起，读哪条就得用哪条的语言，跟当前模式无关。 */
function speakIn(text, lang, extra = {}) {
  TTS.speak(text, { voiceName: currentVoiceName(lang), lang: lang || getMode(), ...extra });
}

/* ============================ 单词卡片 ============================ */

/** 打开单词卡。
 *  cueIdx 可以省 —— 收藏抽屉里点词时，那条记录可能来自另一个视频、甚至当前
 *  根本没导入视频，压根没有「第几句」这个概念。省掉时例句改用收藏时存下的
 *  sample，卡片其余部分完全一样。
 *  langOverride：收藏里的词可能跟当前模式不同语言（英语模式下也能翻西语收藏），
 *  这时必须按记录自己的语言查，不能跟着当前模式走。 */
async function openWordCard(word, anchor, cueIdx, opts = {}) {
  const card = $('#wordcard');
  // 只在从字幕/大字区打开时接管播放；收藏抽屉里查词不打扰当前播放
  const fromSentence = cueIdx >= 0 || opts.fromSentence;
  const player = $('#player');
  if (fromSentence && card.hidden && S.settings.pauseOnLookup !== false) {
    // 只记录「打开前是否在播」；用户暂停由真实的播放控件操作标记，
    // 不靠 pause 事件时序猜测（媒体加载/系统打断也会触发 pause）。
    S.wordCardPause = { wasPlaying: !player.paused, userPaused: false };
    if (!player.paused) player.pause();
  } else if (card.hidden) {
    S.wordCardPause = null;
  }
  S.wordCardFor = null;
  card.hidden = false;
  setText('wcWord', word);
  setText('wcPhon', t('wc.loading'));
  $('#wcBody').innerHTML = '';
  $('#wcFoot').textContent = '';
  positionCard(card, anchor);

  const lang = opts.lang || subLang();
  const es = lang === 'es';

  // ── 西语模式：先把这个词翻成英文，再拿英文去查那本 ECDICT ──
  // 手边只有英语词典（ECDICT，几十万词条），没有西语词典。es→en 这一跳
  // 已经是必然要跑的模型（字幕翻译就用它），借它查出英文对译词，就能拿到
  // 同一份中文释义 —— 不用再塞一份上百 MB 的西语词典进安装包。
  // 代价：西语模式点一个词要多等一次推理；换来的是「释义跟英语模式一模一样」。
  let entryWord = word;
  let viaEn = '';
  if (es) {
    try {
      const r = await MT.translateMany([word], { from: 'es' });
      viaEn = String((r && r[0] && r[0].mid) || '').trim();
      if (viaEn) entryWord = viaEn;
    } catch (e) {
      console.warn('[wordcard] 西语词转英文失败，直接按原词查', e);
    }
  }

  const entry = await DICT.lookup(entryWord);
  const cue = cueIdx >= 0 ? S.cues[cueIdx] : null;
  // 没有 cue（收藏抽屉进来）就退回收藏时留下的例句，别让「例句」那一栏空掉
  const inSentence = cue?.text || opts.sample || '';
  const cueZh = cue?.zh || opts.sampleZh || '';
  S.wordCardFor = {
    // 卡片和收藏都留用户点下去的那个词。西语模式尤其重要：查到的 entry 是
    // 那本**英语**词典里的对译词（práctica → practice），拿 entry.word 当主键
    // 的话西语收藏里会显示成英语单词，还会跟英语模式收藏的 practice 撞车。
    word: es ? word : (entry?.word || word),
    query: word,
    lang,
    viaEn,
    phonetic: entry?.phonetic || '',
    trans: entry?.trans || '',
    pos: entry?.pos || '',
    engdef: entry?.engdef || '',
    exch: entry?.exch || '',
    inflected: !!entry?.inflected,
    sample: inSentence,
    sampleZh: cueZh,
    video: S.name || opts.video || '',
    at: cue?.start ?? opts.at ?? null,
  };

  // 当前句只作为「上下文线索」原样展示；没有上下文义项就明确说明，不编造
  const ctxWords = inSentence ? highlightWord(inSentence, word) : '';
  const ctx = inSentence
    ? `<div class="wc-context"><b>${escapeHtml(t('wc.context'))}</b>${escapeHtml(ctxWords)}` +
      (cueZh ? `<span class="wc-ctx-zh">${escapeHtml(cueZh)}</span>` : '') + '</div>'
    : '';
  if (!entry) {
    setText('wcPhon', '');
    $('#wcBody').innerHTML = ctx + `<div class="sense"><div class="txt">${escapeHtml(t('wc.missing'))}</div></div>` +
      `<div class="wc-context">${escapeHtml(t('wc.contextMissing'))}</div>`;
  } else {
    // 西语模式卡片标题保持西语原词（那才是用户点的），英语模式照旧用词形还原后的词
    setText('wcWord', es ? word : entry.word);
    // 音标是英语的，贴在西语词头上会误导 —— 西语模式把对译词放到脚注里说明
    setText('wcPhon', es ? '' : (entry.phonetic || ''));
    const senses = splitSenses(entry.trans, entry.pos);
    $('#wcBody').innerHTML = ctx + senses.map((s) =>
      `<div class="sense">${s.pos ? `<span class="pos">${escapeHtml(s.pos)}</span>` : ''}<span class="txt">${escapeHtml(s.txt)}</span></div>`
    ).join('') + (entry.engdef
      ? `<div class="wc-def"><b>${escapeHtml(t('wc.engDef'))}</b>${escapeHtml(entry.engdef)}</div>` : '');
  }

  const via = es && viaEn
    ? `<div class="via">${escapeHtml(t('wc.viaEn', { word: viaEn }))}${
      entry?.phonetic ? ` <code>${escapeHtml(entry.phonetic)}</code>` : ''}</div>` : '';
  const inf = entry?.inflected ? escapeHtml(t('wc.inflected', { word: entryWord })) : '';
  const ex = inSentence && inSentence.toLowerCase().includes(word.toLowerCase().slice(0, 4))
    ? `<div class="ex">${escapeHtml(t('wc.example'))}<em>${escapeHtml(highlightWord(inSentence, word))}</em></div>` : '';
  $('#wcFoot').innerHTML = ex + via + inf + `<div style="margin-top:4px">${escapeHtml(t('wc.source'))}</div>`;
  syncFavButton();
}

function splitSenses(trans, pos) {
  if (!trans) return [];
  const parts = trans.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
  const posList = (pos || '').split('/').filter(Boolean);
  return parts.map((tx, i) => {
    // 释义常以 "n. 苹果" 这类词性前缀开头
    const m = tx.match(/^([a-z]{1,6}\.)\s*(.+)$/i);
    if (m) return { pos: m[1].replace('.', ''), txt: m[2] };
    return { pos: parts.length > 1 && posList[i] ? posList[i] : (posList[0] || ''), txt: tx };
  });
}

function highlightWord(sentence, word) {
  const stem = word.replace(/(ies|es|s|ed|ing)$/i, '').slice(0, Math.max(3, word.length - 2));
  return sentence.replace(new RegExp(`\\b(${stem}\\w*)`, 'i'), '[$1]');
}

function positionCard(card, anchor) {
  const r = anchor.getBoundingClientRect();
  const W = card.offsetWidth || 342;
  const H = card.offsetHeight || 280;
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 12;

  // 锚点在右侧字幕栏里时，把卡片放到字幕栏左侧（盖住视频而不是盖住字幕）
  const reader = $('.reader');
  const readerLeft = reader ? reader.getBoundingClientRect().left : vw;
  let left;
  if (r.left >= readerLeft) {
    left = readerLeft - W - gap;
  } else {
    left = r.left - W - gap;
    if (left < gap) left = r.right + gap;
  }
  left = clamp(left, gap, Math.max(gap, vw - W - gap));

  let top = r.bottom + 8;
  if (top + H > vh - gap) top = Math.max(gap, r.top - H - 8);
  top = clamp(top, gap, Math.max(gap, vh - H - gap));

  card.style.left = left + 'px';
  card.style.top = top + 'px';
}

function markUserPaused() {
  if (!S.wordCardPause) return;
  S.wordCardPause.userPaused = true;
}

function closeWordCard() {
  const wasOpen = !$('#wordcard').hidden;
  $('#wordcard').hidden = true;
  S.wordCardFor = null;
  $$('#subs .w.sel').forEach((x) => x.classList.remove('sel'));
  // 只有「打开前确实在播放」且「用户没有在中途自己暂停」才续播
  if (wasOpen && S.wordCardPause) {
    const { wasPlaying, userPaused } = S.wordCardPause;
    const player = $('#player');
    if (wasPlaying && !userPaused && player.paused) {
      player.play().catch((e) => console.warn('[wordcard] 恢复播放失败', e));
    }
  }
  S.wordCardPause = null;
}

function syncFavButton() {
  const btn = $('#wcFav');
  const on = S.wordCardFor && S.favWords.has(favWordId(S.wordCardFor.word, favLang()));
  btn.classList.toggle('on', !!on);
  btn.title = on ? t('wc.unfav') : t('wc.fav');
}

/* ============================ 复习 · 三选一 ============================
   用户当前要求：每题三个选项，一个正确、两个来自**真实收藏库**的不同错误项；
   不靠自评「记住了/没记住」，答题结果直接交给 SRS。
   固定队列在打开时定好，答题不会追加；语言列与自动朗读可独立开关。
   题目/选项只用真实收藏数据；池子不足两个不同错误项时明确说明，不造假。
========================================================================= */

function reviewPool(lang = favLang()) {
  const out = [];
  for (const w of S.favWords.values()) {
    if (recLang(w) === lang) out.push({ kind: 'word', rec: w });
  }
  for (const s of S.favSentences.values()) {
    if (recLang(s) === lang) out.push({ kind: 'sent', rec: s });
  }
  return out;
}

/** 到期的排前面；同一时刻句子优先。固定队列，不在答题时追加。 */
function reviewQueue(lang = favLang(), now = Date.now()) {
  const pool = reviewPool(lang);
  return pool
    .filter((it) => SRS.isDue(it.rec, now))
    .sort((a, b) => {
      const d = SRS.ensureSrs(a.rec, now).dueAt - SRS.ensureSrs(b.rec, now).dueAt;
      if (d !== 0) return d;
      return (a.kind === 'sent' ? 0 : 1) - (b.kind === 'sent' ? 0 : 1);
    });
}

function refreshReviewBadge() {
  const btn = $('#btnReview');
  const badge = $('#reviewCount');
  if (!btn || !badge) return;
  const n = reviewQueue().length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
  btn.classList.toggle('has-due', n > 0);
}

/* ---------- 题目与干扰项 ---------- */

/** 一条收藏在测验里“被问什么、正确答案是什么”。 */
function quizPayload(item, lang) {
  if (item.kind === 'word') {
    const w = item.rec;
    // 单词题：给词，问意思。中文义项优先；没有中文时退回英文释义。
    const correct = (w.trans || '').trim() || (w.engdef || '').trim();
    return {
      kind: 'word', lang,
      prompt: w.word,
      phonetic: w.phonetic || '',
      correct,
      correctZh: (w.trans || '').trim(),
      correctEn: (w.engdef || '').trim(),
      contextEn: w.sample || '',
      contextZh: w.sampleZh || '',
    };
  }
  const s2 = item.rec;
  // 句子题：给原文，问真实译文。中文优先；没有中文时用英文翻译（西语模式）。
  const correct = (s2.zh || '').trim() || (s2.mid || '').trim();
  return {
    kind: 'sent', lang,
    prompt: s2.en || '',
    phonetic: '',
    correct,
    correctZh: (s2.zh || '').trim(),
    correctEn: (s2.mid || '').trim(),
    contextEn: '',
    contextZh: '',
  };
}

/** 同一题目的所有可读答案（用于从真实收藏里挑不同干扰项）。 */
function answerOf(item) {
  if (item.kind === 'word') {
    return ((item.rec.trans || '') + ' ' + (item.rec.engdef || '')).trim();
  }
  return ((item.rec.zh || '') + ' ' + (item.rec.mid || '')).trim();
}

/** 从同语言、同类型的真实收藏里选两个不同错误答案。
 *  不跨语言、不跨类型、不用示例数据；不足时返回 null，由 UI 解释。 */
function buildQuiz(item, lang = favLang()) {
  const payload = quizPayload(item, lang);
  if (!payload.correct) return null;
  const pool = reviewPool(lang)
    .filter((it) => it !== item && it.kind === item.kind)
    .map((it) => quizPayload(it, lang))
    .filter((p) => p.correct && p.correct !== payload.correct);
  // 同一答案文案只保留一条（不同收藏可能撞同一译文）
  const seen = new Set([payload.correct]);
  const distractors = [];
  for (const p of pool.sort(() => Math.random() - 0.5)) {
    if (seen.has(p.correct)) continue;
    seen.add(p.correct);
    distractors.push(p.correct);
    if (distractors.length === 2) break;
  }
  if (distractors.length < 2) return null;
  const options = [
    { text: payload.correct, correct: true },
    ...distractors.map((text) => ({ text, correct: false })),
  ];
  // 位置随机，但每题只洗一次；渲染/切换语言/重播不会重排
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { ...payload, options };
}

/** 准备整个固定队列的题目。题目不足时返回 {items, skipped, reason}。 */
function prepareReviewQuiz(queue, lang) {
  const items = [];
  const skipped = [];
  for (const it of queue) {
    const q = buildQuiz(it, lang);
    if (q) {
      // 选项位置在入队时定死；渲染、切语言、重播都不会重排
      items.push({ ...it, quiz: q, stableOptions: q.options.slice() });
    } else skipped.push(it);
  }
  return { items, skipped };
}

function openReview() {
  const lang = favLang();
  const q = reviewQueue(lang);
  if (!q.length) {
    toast(t('rv.none'));
    return;
  }
  const prep = prepareReviewQuiz(q, lang);
  if (!prep.items.length) {
    toast(t('rv.needPool'), 6000);
    return;
  }
  S.review = {
    queue: prep.items, skipped: prep.skipped.length, idx: 0, ok: 0, bad: 0,
    lang, answered: false, choice: null, revealed: false,
    autoSpeak: S.settings.reviewAutoSpeak !== false,
    showZh: S.settings.reviewShowZh !== false,
    showEn: S.settings.reviewShowEn !== false,
  };
  $('#reviewOverlay').hidden = false;
  renderReview();
}

function closeReview() {
  S.review = null;
  $('#reviewOverlay').hidden = true;
  TTS.stopSpeak();
  refreshReviewBadge();
}

const reviewCur = () => {
  const r = S.review;
  if (!r || r.idx >= r.queue.length) return null;
  return r.queue[r.idx];
};

function renderReview() {
  const r = S.review;
  if (!r) return;
  const box = $('#rvBody');
  const foot = $('#rvFoot');
  const cur = reviewCur();
  $('#rvFinish').hidden = true;

  if (!cur) { renderReviewDone(); return; }

  $('#rvProgress').textContent = t('rv.progress', { i: r.idx + 1, n: r.queue.length });
  $('#rvZhToggle').setAttribute('aria-pressed', String(r.showZh));
  $('#rvEnToggle').setAttribute('aria-pressed', String(r.showEn));
  $('#rvAutoToggle').setAttribute('aria-pressed', String(r.autoSpeak));
  $('#rvZhToggle').classList.toggle('on', r.showZh);
  $('#rvEnToggle').classList.toggle('on', r.showEn);
  $('#rvAutoToggle').classList.toggle('on', r.autoSpeak);

  const q = cur.quiz;
  const options = cur.stableOptions || q.options;
  box.innerHTML = '';
  foot.textContent = '';
  box.appendChild(el('div', { class: 'rv-quiz-kind', text: t(cur.kind === 'word' ? 'rv.kindWord' : 'rv.kindSent') }));

  // 题干：原文列与中文列各自独立显隐；答案选项永远可见。
  const prompt = el('div', { class: 'rv-prompt' });
  if (r.showEn) prompt.appendChild(el('div', { class: 'rv-src', text: q.prompt }));
  if (q.phonetic && r.showEn) prompt.appendChild(el('div', { class: 'rv-phon', text: q.phonetic }));
  if (r.showZh && q.contextZh) prompt.appendChild(el('div', { class: 'rv-context', text: q.contextZh }));
  if (r.showEn && q.contextEn && q.contextEn !== q.prompt) prompt.appendChild(el('div', { class: 'rv-context en', text: q.contextEn }));
  if (!r.showEn && !r.showZh) {
    prompt.appendChild(el('div', { class: 'rv-all-hidden', text: t('rv.allHidden') }));
  }
  box.appendChild(prompt);

  const choices = el('div', { class: 'rv-choices', role: 'group', 'aria-label': t('rv.choices') });
  options.forEach((o, i) => {
    const b = el('button', {
      class: 'rv-choice' + (r.answered && o.correct ? ' correct' : '') +
        (r.answered && r.choice === i && !o.correct ? ' wrong' : ''),
      type: 'button', 'data-choice': String(i),
      'aria-pressed': String(r.choice === i),
      disabled: r.answered,
    });
    b.innerHTML = `<span class="rv-choice-key">${i + 1}</span><span class="rv-choice-text">${escapeHtml(o.text)}</span>`;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); answerReview(i); });
    choices.appendChild(b);
  });
  box.appendChild(choices);

  if (r.answered) {
    const correct = options.find((o) => o.correct);
    const ok = r.choice != null && options[r.choice]?.correct;
    foot.className = 'rv-foot ' + (ok ? 'ok' : 'bad');
    foot.textContent = ok ? t('rv.correct') : t('rv.wrong', { answer: correct?.text || '' });
    $('#rvFinish').hidden = false;
    $('#rvFinish').textContent = r.idx + 1 >= r.queue.length ? t('rv.finish') : t('rv.next');
  } else {
    foot.className = 'rv-foot';
    foot.textContent = r.showZh || r.showEn ? '' : t('rv.answerStillVisible');
  }

  // 只在题目切换时自动读一次；手动重播随时可用。关闭自动朗读则绝不主动出声。
  if (r.autoSpeak && !r.spoken) {
    r.spoken = true;
    speakReview();
  }
}

function speakReview() {
  const cur = reviewCur();
  if (!cur) return;
  TTS.stopSpeak();
  const text = cur.quiz.prompt;
  speakIn(text, recLang(cur.rec), { rate: S.settings.ttsRate });
}

function answerReview(choice) {
  const r = S.review;
  const cur = reviewCur();
  if (!r || !cur || r.answered) return;
  r.answered = true;
  r.choice = choice;
  const ok = !!(cur.stableOptions || cur.quiz.options)[choice]?.correct;
  const store = cur.kind === 'word' ? 'words' : 'sentences';
  const updated = SRS.grade(cur.rec, ok);
  if (cur.kind === 'word') S.favWords.set(updated.id, updated);
  else S.favSentences.set(updated.id, updated);
  idbPut(S.db, store, updated).catch(() => {});
  if (ok) r.ok++; else r.bad++;
  renderReview();
  refreshReviewBadge();
  if (!$('#favDrawer').hidden) renderFavs();
}

function nextReview() {
  const r = S.review;
  if (!r) return;
  if (r.idx + 1 >= r.queue.length) { r.idx = r.queue.length; renderReview(); return; }
  r.idx++;
  r.answered = false;
  r.choice = null;
  r.spoken = false;
  renderReview();
}

function renderReviewDone() {
  const r = S.review;
  $('#rvProgress').textContent = t('rv.doneTitle');
  $('#rvFoot').textContent = '';
  $('#rvFoot').className = 'rv-foot';
  $('#rvFinish').hidden = false;
  $('#rvFinish').textContent = t('rv.finish');

  const box = $('#rvBody');
  const total = r ? r.ok + r.bad : 0;
  const pool = reviewPool(r?.lang);
  const nextAt = SRS.nextDueAt(pool.map((it) => it.rec));
  const nextTxt = nextAt ? t('rv.nextRound', { when: humanUntil(nextAt) }) : t('rv.allClear');
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'rv-done' }, [
    el('h3', { text: t('rv.doneTitle') }),
    el('div', { class: 'rv-stats' }, [
      el('div', { class: 'rv-stat ok' }, [
        el('b', { text: String(r ? r.ok : 0) }), el('span', { text: t('rv.correctShort') }),
      ]),
      el('div', { class: 'rv-stat bad' }, [
        el('b', { text: String(r ? r.bad : 0) }), el('span', { text: t('rv.wrongShort') }),
      ]),
    ]),
    el('p', { text: total ? t('rv.doneBody', { n: total }) : t('rv.none') }),
    r?.skipped ? el('p', { class: 'rv-meta', text: t('rv.skipped', { n: r.skipped }) }) : null,
    el('p', { class: 'rv-meta', text: nextTxt }),
  ].filter(Boolean)));
}

/** 「还有多久」的人话说法。 */
function humanUntil(when, now = Date.now()) {
  const d = when - now;
  if (d <= 0) return t('rv.now');
  const mins = d / 6e4;
  if (mins < 60) return t('rv.min', { n: Math.round(mins) });
  const days = d / 864e5;
  if (days < 1) return t('rv.hours', { n: Math.round(d / 36e5) });
  return t('rv.day', { n: Math.round(days) });
}

/* ============================ 收藏 ============================ */

async function toggleFavWord(w) {
  const lang = favLang();
  const id = favWordId(w.word, lang);
  if (S.favWords.has(id)) {
    S.favWords.delete(id);
    await idbDelete(S.db, 'words', id).catch(() => {});
    toast(t('wc.unfavDone', { word: w.word }));
  } else {
    const rec = { ...w, id, lang, addedAt: Date.now(), count: 1 };
    // 新收藏立刻进复习队列（dueAt = 现在，box 0 = 20 分钟后）。
    // 不这么做的话，用户收藏完去看复习页会是空的，以为功能没生效。
    Object.assign(rec, SRS.ensureSrs({}, rec.addedAt));
    S.favWords.set(id, rec);
    await idbPut(S.db, 'words', rec).catch(() => {});
    toast(t('wc.favDone', { word: w.word }));
  }
  syncFavButton();
  await refreshFavCounts();
  refreshReviewBadge();
  const q = $('#subSearch').value.trim();
  const keep = S.activeIdx;
  renderSubs(q);
  if (keep >= 0) setActive(keep, false);
  if (!$('#wordcard').hidden && S.wordCardFor) {
    // 保持卡片锚点上的选中态。这里要用**原始词**去选 —— 字幕里的
    // data-w 存的是裸词，收藏主键可能带着 es: 前缀。
    const el2 = S.cueEls[S.activeIdx]?.querySelector(`.w[data-w="${CSS.escape(w.word)}"]`);
    el2?.classList.add('sel');
  }
  if (!$('#favDrawer').hidden) renderFavs();
}

function sentId(cue) {
  return hashStr(`${S.name}|${cue.text}`).slice(0, 12);
}

async function toggleFavSentence(cue) {
  const id = sentId(cue);
  if (S.favSentences.has(id)) {
    S.favSentences.delete(id);
    await idbDelete(S.db, 'sentences', id).catch(() => {});
    toast(t('fav.unsavedSent'));
  } else {
    const rec = {
      id, en: cue.text, zh: cue.zh || '', mid: cue.mid || '', video: S.name,
      lang: favLang(),
      start: cue.start, end: cue.end, addedAt: Date.now(),
    };
    Object.assign(rec, SRS.ensureSrs({}, rec.addedAt));
    S.favSentences.set(id, rec);
    await idbPut(S.db, 'sentences', rec).catch(() => {});
    toast(t('fav.savedSent'));
  }
  await refreshFavCounts();
  refreshReviewBadge();
  if (!$('#favDrawer').hidden) renderFavs();
}

/** 抽屉顶部那行分区说明：这一档是哪种语言、多少条，另一档还有多少条。
 *  没有这行的话，用户在英语模式里找不到刚存的西语词，只会以为收藏丢了。 */
function renderFavScope() {
  const box = $('#favScope');
  if (!box) return;
  const mine = favLang();
  const other = mine === 'es' ? 'en' : 'es';
  const countOf = (l) => Array.from(S.favWords.values()).filter((w) => recLang(w) === l).length
    + Array.from(S.favSentences.values()).filter((s) => recLang(s) === l).length;
  const n = countOf(mine);
  const nOther = countOf(other);
  const nameOf = (l) => t(l === 'es' ? 'fav.langEs' : 'fav.langEn');
  box.textContent = t('fav.scope', { lang: nameOf(mine), n })
    + (nOther ? ' · ' + t('fav.other', { lang: nameOf(other), n: nOther }) : '');
}

function renderFavs() {
  const box = $('#favBody');
  const q = ($('#favSearch').value || '').trim().toLowerCase();
  const mine = favLang();
  box.innerHTML = '';
  renderFavScope();
  if (S.favTab === 'words') {
    let list = Array.from(S.favWords.values()).filter((w) => recLang(w) === mine);
    if (q) list = list.filter((w) => (w.word + w.trans).toLowerCase().includes(q));
    list.sort((a, b) => b.addedAt - a.addedAt);
    if (!list.length) {
      box.innerHTML = `<div class="empty"><p>${escapeHtml(t('fav.emptyWords'))}</p><p class="muted">${escapeHtml(t('fav.emptyWordsHint'))}</p></div>`;
      return;
    }
    for (const w of list) {
      // data-wid 让条目正文可点（点了弹词卡）。没有它，收藏夹只能看不能查。
      box.appendChild(el('div', { class: 'fav-item clickable', 'data-wid': w.id }, [
        el('div', { class: 'tools', html:
          `<button class="icon-btn" data-act="speak" data-id="${escapeHtml(w.id)}" title="${escapeHtml(t('wc.speak'))}">🔊</button>` +
          `<button class="icon-btn" data-act="del-word" data-id="${escapeHtml(w.id)}" title="${escapeHtml(t('common.close'))}">✕</button>` }),
        el('div', { class: 't', text: w.word }),
        el('div', { class: 'p', text: w.phonetic || '' }),
        el('div', { class: 'd', text: w.trans || t('fav.noDef') }),
        el('div', { class: 'meta', html:
          `${w.pos ? `<span>${escapeHtml(w.pos)}</span>` : ''}` +
          `${w.sample ? `<span>${escapeHtml(t('fav.from'))}${escapeHtml((w.sample || '').slice(0, 60))}…</span>` : ''}` +
          `<span>${new Date(w.addedAt).toLocaleDateString()}</span>` }),
      ]));
    }
  } else {
    let list = Array.from(S.favSentences.values()).filter((s) => recLang(s) === mine);
    if (q) list = list.filter((s) => (s.en + s.zh + (s.mid || '')).toLowerCase().includes(q));
    list.sort((a, b) => b.addedAt - a.addedAt);
    if (!list.length) {
      box.innerHTML = `<div class="empty"><p>${escapeHtml(t('fav.emptySents'))}</p><p class="muted">${escapeHtml(t('fav.emptySentsHint'))}</p></div>`;
      return;
    }
    for (const s of list) {
      box.appendChild(el('div', { class: 'fav-item' }, [
        el('div', { class: 'tools', html:
          `<button class="icon-btn" data-act="speak-sent" data-id="${escapeHtml(s.id)}" title="${escapeHtml(t('cue.speak'))}">🔊</button>` +
          `<button class="icon-btn" data-act="del-sent" data-id="${escapeHtml(s.id)}" title="${escapeHtml(t('common.close'))}">✕</button>` }),
        el('div', { class: 'en', text: s.en }),
        // 西语收藏多一行英文对译，跟字幕面板一样
        ...(s.mid ? [el('div', { class: 'mid', text: s.mid })] : []),
        el('div', { class: 'zh', text: s.zh || t('fav.noZh') }),
        el('div', { class: 'meta', html:
          `<span>${escapeHtml(s.video || t('fav.unknownVideo'))}</span><span>${fmtTime(s.start)}</span><span>${new Date(s.addedAt).toLocaleDateString()}</span>` }),
      ]));
    }
  }
}

async function onFavBodyClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) {
    // 没点到按钮：可能是点了收藏条目的正文。
    // 生词条目点一下要能重新翻出释义 —— 收藏之后想再看一眼意思是很自然的动作，
    // 以前这里直接 return，等于收藏夹只能看不能查。
    const item = e.target.closest('.fav-item');
    const wid = item?.dataset.wid;
    if (wid) {
      const w = S.favWords.get(wid);
      if (w) {
        const anchor = item.querySelector('.t') || item;
        // 按这条收藏自己的语言查，不跟当前模式走：
        // 英语模式下翻到一条西语收藏，也得按西语去查才有释义。
        openWordCard(w.word, anchor, -1, {
          lang: recLang(w),
          sample: w.sample || '',
          sampleZh: w.sampleZh || '',
          video: w.video || '',
          at: w.at ?? null,
        });
      }
    }
    return;
  }
  const { act, id } = btn.dataset;
  if (act === 'speak') {
    const w = S.favWords.get(id);
    if (w) speakIn(w.word, w.lang || 'en', { rate: S.settings.ttsRate });
  } else if (act === 'speak-sent') {
    const s = S.favSentences.get(id);
    if (s) speakIn(s.en, s.lang || 'en', { rate: S.settings.ttsRate });
  } else if (act === 'del-word') {
    S.favWords.delete(id);
    await idbDelete(S.db, 'words', id).catch(() => {});
    await refreshFavCounts(); renderFavs();
    const keep = S.activeIdx; renderSubs($('#subSearch').value.trim()); if (keep >= 0) setActive(keep, false);
  } else if (act === 'del-sent') {
    S.favSentences.delete(id);
    await idbDelete(S.db, 'sentences', id).catch(() => {});
    await refreshFavCounts(); renderFavs();
  }
}

function exportFavs() {
  const payload = {
    app: 'EchoLingo', version: 1, exportedAt: new Date().toISOString(),
    words: Array.from(S.favWords.values()),
    sentences: Array.from(S.favSentences.values()),
  };
  download(`echolingo-saved-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 1));
  toast(t('fav.exported'));
}

async function importFavs(file) {
  try {
    const data = JSON.parse(await file.text());
    let n = 0;
    for (const w of data.words || []) {
      if (!w?.id && !w?.word) continue;
      const rec = { ...w, id: w.id || w.word };
      S.favWords.set(rec.id, rec); await idbPut(S.db, 'words', rec); n++;
    }
    for (const s of data.sentences || []) {
      if (!s?.id) continue;
      S.favSentences.set(s.id, s); await idbPut(S.db, 'sentences', s); n++;
    }
    await refreshFavCounts(); renderFavs();
    toast(t('fav.imported', { n }));
  } catch (e) {
    toast(t('fav.importFail', { msg: e.message }));
  }
}

function exportSRT() {
  if (!S.cues.length) return toast(t('toast.noSubExport'));
  const name = (S.name || 'subtitle').replace(/\.[^.]+$/, '');
  download(`${name}.bilingual.srt`, SUB.toSRT(S.cues), 'text/plain');
}

/* ============================ 抽屉 ============================ */

function toggleDrawer(id) {
  const d = document.getElementById(id);
  const willOpen = d.hidden;
  closeDrawers();
  if (willOpen) {
    d.hidden = false;
    $('#scrim').hidden = false;
    if (id === 'favDrawer') renderFavs();
    fillSettings();
  }
}

function closeDrawers() {
  $('#favDrawer').hidden = true;
  $('#setDrawer').hidden = true;
  $('#scrim').hidden = true;
}

function fillSettings() {
  // 音色列表跟着模式走（英语一套、西语一套），所以不能像以前那样
  // 「options 非空就不重建」—— 切完模式再打开设置会看到上一种语言的音色。
  fillVoiceSelect(TTS.getVoices());
  ttsVoiceReminder();
  renderStatus();
  applyTheme();
}

function fillVoiceSelect(voices) {
  const sel = $('#setVoice');
  if (!sel) return;
  const want = currentVoiceName();
  const prev = sel.value;
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '', text: t('status.voiceAuto') }));
  for (const v of voices) {
    sel.appendChild(el('option', { value: v.name, text: `${v.name} · ${v.lang}${v.localService ? ` · ${t('common.local')}` : ''}` }));
  }
  // 只认「本语言音色池里有这个名字」：切模式后原来选的音色属于另一种语言，
  // 这时下拉退回「自动」。存档里那个名字留着不动 —— 切回去还要用它。
  sel.value = voices.some((v) => v.name === want) ? want
    : (voices.some((v) => v.name === prev) ? prev : '');
  ttsVoiceReminder();
}

function ttsVoiceReminder() {
  const voices = TTS.getVoices();
  const local = voices.filter((v) => v.localService);
  MS.tts = voices.length
    ? { state: local.length ? 'ok' : 'warn', text: t('status.ttsCount', { n: voices.length, local: local.length }) }
    : { state: 'bad', text: TTS.hasTTS() ? t('status.ttsNoVoice') : t('status.ttsUnsupported') };
  renderStatus();
}

/* ============================ 状态显示 ============================ */

const MS = {
  asr: { state: 'pending', name: '', note: '' },   // pending | loading | ready | bad
  mt: { state: 'pending', note: '' },
  dict: { state: 'pending', text: '' },
  tts: { state: 'pending', text: '' },
  net: null,                                        // null 尚未检测 | true | false
};

function renderStatus() {
  // —— 语音识别 ——
  const a = MS.asr;
  const modelName = modelMeta(a.model || S.asrModel)?.label || (a.model || S.asrModel || DEFAULT_ASR_MODEL);
  if (a.state === 'ready') {
    dot('dotAsr', 'ok');
    setText('txtAsr', a.name ? t('st.asrReadyName', { name: a.name }) : t('st.asrReady'));
    setText('setAsr', t('status.modelLoaded', { model: modelName, state: t('status.loaded') }));
    state('setAsr', 'ok');
  } else if (a.state === 'loading') {
    dot('dotAsr', 'busy');
    setText('txtAsr', t('st.asrPending'));
    setText('setAsr', a.note || t('status.warmingAsr'));
    state('setAsr', 'warn');
  } else if (a.state === 'bad') {
    dot('dotAsr', 'bad');
    setText('txtAsr', t('st.asrBad'));
    setText('setAsr', a.note || '');
    state('setAsr', 'bad');
  } else {
    dot('dotAsr', '');
    setText('txtAsr', t('st.asrPending'));
    setText('setAsr', t('status.modelLoaded', { model: modelName, state: t('status.ready') }));
    state('setAsr', '');
  }
  // —— 翻译 ——
  const m = MS.mt;
  if (m.state === 'ready') {
    dot('dotMt', 'ok');
    setText('txtMt', t('st.mtReady'));
    setText('setMt', t('status.mtLoaded'));
    state('setMt', 'ok');
  } else if (m.state === 'bad') {
    dot('dotMt', 'bad');
    setText('txtMt', t('st.mtBad'));
    setText('setMt', m.note || '');
    state('setMt', 'bad');
  } else {
    dot('dotMt', '');
    setText('txtMt', t('st.mtPending'));
    setText('setMt', t('status.modelLoaded', { model: 'opus-mt-en-zh', state: t('status.ready') }));
    state('setMt', '');
  }
  // —— 词典 / 语音合成 ——
  if (MS.dict.text) { setText('setDict', MS.dict.text); state('setDict', MS.dict.state === 'ready' ? 'ok' : MS.dict.state === 'bad' ? 'bad' : 'warn'); }
  if (MS.tts.text) { setText('setTts', MS.tts.text); state('setTts', MS.tts.state); }
}

async function probeModels() {
  try {
    const name = await ASR.probeASR(S.asrModel);
    if (MS.asr.state !== 'loading' && MS.asr.state !== 'ready') {
      MS.asr = { state: 'pending', name: String(name || ''), model: S.asrModel };
    }
  } catch (e) {
    MS.asr = { state: 'bad', note: e.message, model: S.asrModel };
  }
  try {
    await MT.probeMT();
    if (MS.mt.state !== 'ready') MS.mt = { state: 'pending' };
  } catch (e) {
    MS.mt = { state: 'bad', note: e.message };
  }
  renderStatus();
}

function updateNetStatus() {
  MS.net = navigator.onLine;
  setText('txtNet', MS.net ? t('st.netOnline') : t('st.netOffline'));
  dot('dotNet', MS.net ? 'warn' : 'ok');

  if (location.protocol === 'file:') {
    setText('setSw', t('status.fileProto'));
    state('setSw', 'warn');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    setText('setSw', t('status.noSW'));
    state('setSw', 'bad');
    return;
  }
  if (navigator.serviceWorker.controller) {
    setText('setSw', t('status.swOk'));
    state('setSw', 'ok');
  } else if (swReg?.active || swReg?.installing || swReg?.waiting) {
    setText('setSw', t('status.swPending'));
    state('setSw', 'warn');
  } else {
    setText('setSw', t('status.swNone'));
    state('setSw', 'warn');
  }
}

const shortFile = (p) => String(p).split('/').pop();
const setText = (id, txt) => { const n = document.getElementById(id); if (n) n.textContent = txt; };
const dot = (id, cls) => { const n = document.getElementById(id); if (n) n.className = 'dot ' + cls; };
// 设置面板里的状态单元格：用 data-state 加一个彩色圆点，避免破坏排版
const state = (id, cls) => { const n = document.getElementById(id); if (n) n.dataset.state = cls; };

/* ============================ 识别流程 ============================ */

async function runTranscribe() {
  if (!LIC_ON && !needLicense()) return;
  if (S.busy) { toast(t('toast.busy')); return; }
  const file = S.file;
  if (!file) { toast(t('toast.needFile')); return; }

  const run = ++S.asrRun;
  const cancelled = () => S.asrRun !== run;

  S.busy = 'asr';
  S.recog = true;
  S.lastFail = null;
  S.lastStatus = 'processing';
  persistSession({ status: 'processing' });
  S.recogLang = modelLang(S.asrModel);   // 记下这一轮用的是什么语言，切模式时好判断要不要问
  let needTranslate = false;
  const btn = $('#btnTranscribe');
  btn.disabled = true;
  setText('btnTranscribeLabel', t('top.running'));
  dot('dotAsr', 'busy');
  showFineProgress('asr', 0, t('prog.decode'));
  renderSubs($('#subSearch').value.trim());   // 立刻把右侧切到「识别中」状态

  // 边识别边刷新右侧：累计词 → 拼句 → 渲染
  // 字幕越长，单次重建 DOM 越贵，刷新间隔随之放宽，避免边识别边卡顿
  let painted = -1;
  let lastPaint = 0;
  const paintInterval = () => Math.max(500, S.cues.length * 1.2);
  const paint = (words, force) => {
    if (cancelled()) return;
    const sentences = SUB.groupWordsIntoSentences(words);
    if (!force && sentences.length === painted) return;
    painted = sentences.length;
    S.cues = sentences.map((s, i) => ({ ...s, i }));
    S.activeIdx = -1;
    renderSubs($('#subSearch').value.trim());
  };

  try {
    showProgress(1, t('prog.decode'));
    const pcm = await ASR.decodeAudio(file, $('#player').duration, () => showProgress(2, t('prog.decode')));
    if (cancelled()) return;

    // 只有显式选「关闭」才不要逐词时间戳。
    // 原来还有一条「auto 且时长 ≥25 分钟就关掉」的降级：那是为一个并不存在的
    // 性能问题让路 —— 实测逐词只比不要时间戳贵约 13%，而 vendor 里
    // return_timestamps:true 对「从中间切出的段」会返回空文本，
    // 于是长视频直接变成「一个字幕都没有」。既然要的是句子边界，就别降级。
    const useWordTs = S.settings.wordTs !== 'off';

    showProgress(3, t('prog.loadAsr'));
    const { words, cancelled: wasCancelled } = await ASR.transcribe(pcm, {
      wordTimestamps: useWordTs,
      file,
      durationHint: $('#player').duration,
      shouldCancel: cancelled,
      modelId: S.asrModel,
      onWords: (all) => {
        const now = performance.now();
        if (now - lastPaint > paintInterval()) { lastPaint = now; paint(all); }
      },
      onProgress: (p) => {
        if (p.phase === 'load') {
          showFineProgress('asr', p.pct ?? 0, loadProgressText(p) + paceEta(p));
        } else if (p.phase === 'transcribe') {
          // 优先显示按实测速度推算的剩余时间；还没测出速度才退回「约剩 N 段」
          const eta = p.etaSec != null && p.etaSec >= 1
            ? t('prog.etaTime', { t: fmtTime(p.etaSec) })
            : (p.seg < p.total ? t('prog.eta', { n: p.total - p.seg }) : '');
          showFineProgress('asr', p.pct, t('prog.seg', { seg: p.seg, total: p.total, words: p.words, eta }));
        }
      },
    });
    if (cancelled() || wasCancelled) {
      if (S.cues.length) {
        S.lastStatus = 'partial';
        persistSession({ status: 'partial' });
      }
      return;
    }

    if (!words.length) {
      hideProgress();
      S.recog = false;
      renderSubs();
      toast(t('toast.recogEmpty'), 5000);
      return;
    }

    paint(words, true);
    showFineProgress('asr', 100, t('prog.stageReady'));
    hideProgress();
    toast(t('toast.recogDone', { n: S.cues.length }));
    needTranslate = S.settings.transMode === 'local';
  } catch (e) {
    if (cancelled()) {
      toast(t('prog.cancelledHint'));
    } else {
      console.error(e);
      S.lastFail = { kind: 'asr', msg: e?.message || String(e) };
      S.lastStatus = S.cues.length ? 'partial' : 'failed';
      persistSession({ status: S.lastStatus });
      renderFailNote();
      toast(t('toast.recogFail', { msg: e?.message || e }), 5000);
    }
    hideProgress();
  } finally {
    S.busy = null;
    S.recog = false;
    btn.disabled = false;
    setText('btnTranscribeLabel', t('top.redo'));
    if (MS.asr.state !== 'ready') { MS.asr = { state: 'ready', name: MS.asr.name || '', model: S.asrModel }; }
    renderStatus();
    hideProgress();
    renderSubs($('#subSearch').value.trim());
  }
  if (S.cues.length) {
    S.lastStatus = needTranslate ? 'partial' : 'ready';
    persistSession({ status: S.lastStatus });
  }
  // 识别任务已释放，翻译作为独立任务接着跑
  if (needTranslate) translateAll();
}

/* ============================ 翻译流程 ============================ */

async function translateAll({ force = false, retry = false } = {}) {
  if (S.busy) {
    if (!retry) return;
    await waitIdle();
    if (S.busy) return;
  }
  if (!force && S.settings.transMode === 'off') return;
  if (!S.cues.length) return;

  // 源语言就是识别模型的语言。整条链只跑一趟，链上每一跳的输出都留下来：
  //   西语原文 --(opus-mt-es-en)--> 英文（存 c.mid）--(opus-mt-en-zh)--> 中文（存 c.zh）
  // 英语模式链只有一跳：英文原文 --(opus-mt-en-zh)--> 中文，mid 天然为空字符串。
  // ⚠️ 早先这里分两趟跑（先 es→en 填 mid，再拿 mid 跑 en→zh 填 zh）。两个毛病：
  //    ① 等于把链跑两遍，时间翻倍；② 第二趟拿到的其实是第一趟的**最终**输出，
  //    于是「英文翻译」那一行被填成了中文。现在由 MT 一趟带回 out + mid。
  const src = modelLang(S.asrModel);
  const wantMid = src !== 'en';

  const todo = S.cues.filter((c) => !c.zh || (wantMid && !c.mid));
  if (!todo.length) return;
  todo.forEach((c) => { c._pending = true; c._pendingMid = wantMid; });

  const refresh = () => {
    renderSubs($('#subSearch').value.trim());
    if (S.activeIdx >= 0) setActive(S.activeIdx, false);
  };
  refresh();

  S.busy = 'mt';
  S.lastFail = null;
  dot('dotMt', 'busy');
  showFineProgress('mt', 0, t('prog.loadMt'));
  const ctrl = new AbortController();
  S.transAbort = ctrl;

  const onProgress = (p) => {
    if (p.phase === 'load') {
      showFineProgress('mt', p.pct ?? 0, p.file
        ? t(hasCached(LS_MT_CACHED) ? 'prog.loadMtFile' : 'prog.loadMtFileFirst', { file: shortFile(p.file) })
        : t('prog.loadMt'));
    } else {
      showFineProgress('mt', p.pct, t(wantMid ? 'prog.translatingMid' : 'prog.translating', { done: p.done, total: p.total }));
      // 每若干句刷新一次，让用户看到译文逐步出现
      if (p.done % 8 === 0) refresh();
    }
  };

  try {
    showProgress(0, t('prog.loadMt'));
    // 显式带上源语言：翻译链是按语言选的，依赖「之前调用过 setLang」
    // 太脆 —— 万一顺序变了就会拿英语链去翻西语，而且不报错、只是译文很怪。
    const results = await MT.translateMany(todo.map((c) => c.text), {
      signal: ctrl.signal, from: src, onProgress,
    });
    markCached(LS_MT_CACHED);   // 走完一轮就说明模型已在缓存里了
    todo.forEach((c, i) => {
      const r = results[i] || {};
      if (wantMid) c.mid = r.mid || '';
      if (r.out) c.zh = r.out;
      c._pending = false;
      c._pendingMid = false;
    });

    refresh();
    hideProgress();
    S.lastStatus = 'ready';
    persistSession({ status: 'ready' });
    toast(t('toast.transDone'));
  } catch (e) {
    if (ctrl.signal.aborted) {
      toast(t('prog.cancelledHint'));
    } else {
      console.error(e);
      S.lastFail = { kind: 'mt', msg: e?.message || String(e) };
      S.lastStatus = S.cues.length ? 'partial' : 'failed';
      persistSession({ status: S.lastStatus });
      renderFailNote();
      toast(t('toast.transFail', { msg: e?.message || e }), 5000);
    }
    hideProgress();
  } finally {
    S.busy = null;
    S.transAbort = null;
    S.cues.forEach((c) => { c._pending = false; c._pendingMid = false; });
    dot('dotMt', 'ok');
    renderStatus();
  }
}

/* ============================ 字幕导入 ============================ */

async function importSubtitle(file) {
  try {
    // 已有更可靠的人工字幕：停掉自动识别，避免结果互相覆盖
    S.asrRun++;
    ASR.cancel();
    S.recog = false;
    if (S.transAbort) { S.transAbort.abort(); S.transAbort = null; }

    const text = await file.text();
    let cues;
    if (file.name.toLowerCase().endsWith('.json')) {
      const data = JSON.parse(text);
      cues = (data.cues || data.subtitles || data).map((c, i) => ({
        i, start: c.start ?? i, end: c.end ?? i + 1,
        text: c.text || c.en || '', zh: c.zh || c.translation || '',
      }));
    } else {
      cues = SUB.parseCues(text);
    }
    if (!cues.length) return toast(t('toast.subEmpty'));
    const merged = SUB.mergeCues(cues.filter((c) => c.text || c.zh));
    const zhCount = merged.filter((c) => c.zh).length;
    setCues(merged, { translate: zhCount < merged.length * 0.5 && S.settings.transMode === 'local' });
    toast(zhCount
      ? t('toast.subLoadedZh', { n: merged.length, zh: zhCount })
      : t('toast.subLoaded', { n: merged.length }));
  } catch (e) {
    toast(t('toast.subFail', { msg: e.message }));
  }
}

/* ============================ 进度条 ============================ */

let hideTimer = 0;

function showProgress(pct, text) {
  clearTimeout(hideTimer);   // 新任务开始时取消上一次的延迟隐藏
  $('#progressWrap').hidden = false;
  $('#progressBar').style.width = clamp(pct, 0, 100) + '%';
  setText('progressText', text || '');
}

/** 真实阶段：识别 / 翻译 / 就绪。进度值来自实际解码或模型回调，不伪造。 */
function showFineProgress(stage, pct, text) {
  S.jobStage = stage;
  $('#progressWrap').hidden = false;
  setText('progressStage', t(stage === 'asr' ? 'prog.stageRecognize'
    : stage === 'mt' ? 'prog.stageTranslate' : 'prog.stageReady'));
  const cancel = $('#btnCancelJob');
  const retry = $('#btnRetryJob');
  if (cancel) cancel.hidden = !(stage === 'asr' || stage === 'mt');
  if (retry) retry.hidden = true;
  showProgress(pct, text);
}

/** 失败不是一个一闪而过的 toast：留下可重试的真实错误。 */
function renderFailNote() {
  const foot = $('.stage-foot');
  let n = $('#failNote');
  if (!S.lastFail) { n?.remove(); return; }
  if (!n) {
    n = el('div', { class: 'fail-note', id: 'failNote' });
    foot.appendChild(n);
  }
  const isAsr = S.lastFail.kind === 'asr';
  n.innerHTML = `<span>${escapeHtml(t(isAsr ? 'prog.retryAsr' : 'prog.retryMt'))}</span>` +
    `<span class="muted" style="flex:1 1 100%">${escapeHtml(String(S.lastFail.msg || '').slice(0, 200))}</span>` +
    `<button class="btn" id="btnFailRetry"></button>` +
    (!isAsr && S.cues.length ? `<button class="btn" id="btnFailTranslate"></button>` : '');
  const retry = n.querySelector('#btnFailRetry');
  retry.textContent = t('prog.retry');
  retry.addEventListener('click', () => {
    n.remove();
    if (isAsr) runTranscribe(); else translateAll({ retry: true });
  });
  const tr = n.querySelector('#btnFailTranslate');
  if (tr) {
    tr.textContent = t('prog.doTranslate');
    tr.addEventListener('click', () => { n.remove(); translateAll({ retry: true }); });
  }
}

function hideProgress() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    $('#progressWrap').hidden = true;
    $('#progressBar').style.width = '0%';
  }, 700);
}

/** 取消当前真实任务：作废识别代号 / 中止翻译请求；已产生的字幕保留。 */
function cancelCurrentJob() {
  if (!S.busy) return;
  if (S.busy === 'asr') {
    S.asrRun++;
    ASR.cancel();
  } else if (S.busy === 'mt' && S.transAbort) {
    S.transAbort.abort();
  }
  toast(t('prog.cancelledHint'));
}

function retryLastJob() {
  if (!S.lastFail) return;
  if (S.lastFail.kind === 'asr') runTranscribe();
  else translateAll({ retry: true });
}

function resetProgress() {
  S.lastFail = null;
  $('#failNote')?.remove();
  hideProgress();
}

/* ============================ Service Worker ============================ */

let swReg = null;

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  try {
    // 页面打开时是否已经有 SW 在控制？有 → 说明这是「升级」而不是「首次安装」。
    const hadController = !!navigator.serviceWorker.controller;
    swReg = await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      updateNetStatus();
      // 新版本 SW 接管了本页：但本次导航的文档还是旧 SW 给的，依旧是旧版页面。
      // 自动补一次刷新，用户就不必自己「刷两遍」。首次安装不刷（本来就没有 controller）。
      if (!hadController) return;
      let tried = null;
      try { tried = sessionStorage.getItem('echolingo.swReload'); } catch { /* 隐私模式 */ }
      if (tried) return;
      try { sessionStorage.setItem('echolingo.swReload', '1'); } catch { /* 忽略 */ }
      location.reload();
    });
    updateNetStatus();
    // 主动查一次更新：老用户不必等到浏览器自己的下一次巡检才拿到新版本。
    // sw.js 只有几 KB，且内容没变时不会重新安装，代价可以忽略。
    swReg.update().catch(() => {});
  } catch (e) {
    setText('setSw', t('status.swFail', { msg: e.message }));
  }
}

async function cacheEverything() {
  if (!swReg?.active) return toast(t('set.cacheUnavailable'));
  const base = location.href.replace(/[^/]*$/, '');
  const urls = [    base, base + 'index.html', base + 'css/styles.css', base + 'manifest.webmanifest',
    base + 'js/app.js', base + 'js/i18n.js', base + 'js/models.js', base + 'js/asr.js', base + 'js/asr-engine.js',
    base + 'js/asr-worker.js', base + 'js/mt.js', base + 'js/dict.js',
    base + 'js/subtitle.js', base + 'js/tts.js', base + 'js/util.js',
    base + 'vendor/transformers.min.js',
    base + 'vendor/ort-wasm-simd-threaded.jsep.wasm',
    base + 'vendor/ort-wasm-simd-threaded.jsep.mjs',
    base + 'models/opus-mt-en-zh/config.json',
    base + 'models/opus-mt-en-zh/generation_config.json',
    base + 'models/opus-mt-en-zh/tokenizer.json',
    base + 'models/opus-mt-en-zh/tokenizer_config.json',
    base + 'models/opus-mt-en-zh/vocab.json',
    base + 'models/opus-mt-en-zh/source.spm',
    base + 'models/opus-mt-en-zh/target.spm',
    base + 'models/opus-mt-en-zh/onnx/encoder_model_quantized.onnx',
    base + 'models/opus-mt-en-zh/onnx/decoder_model_merged_quantized.onnx',
    base + 'dict/core.json', base + 'dict/lemma.json', base + 'dict/meta.json',
    base + 'media/demo.m4a',
  ];
  // 识别模型：本机存在的全部缓存，这样切换模型之后离线也照样能用
  for (const id of (S.asrModels.length ? S.asrModels : [DEFAULT_ASR_MODEL])) {
    for (const f of MODEL_FILES) urls.push(base + 'models/' + id + '/' + f);
  }
  for (const c of 'abcdefghijklmnopqrstuvwxyz') urls.push(base + 'dict/' + c + '.json');

  let done = 0;
  // 写进 Service Worker 正在用的那个缓存名字里，否则 SW 的 match 看不到这些条目。
  // activate 阶段会清掉除当前版本以外的 echolingo-* 缓存，所以这里取到的那一个就是它。
  const keys = await caches.keys();
  const mine = keys.filter((k) => /^echolingo-v\d+$/.test(k));
  const cacheName = mine.sort((a, b) => (+b.split('v')[1]) - (+a.split('v')[1]))[0] || 'echolingo-v5';
  const cache = await caches.open(cacheName);

  showProgress(0, t('set.caching', { done: 0, total: urls.length }));
  for (const u of urls) {
    try {
      const res = await fetch(u, { cache: 'force-cache' });
      if (res.ok) await cache.put(u, res.clone());
    } catch {}
    done++;
    if (done % 3 === 0 || done === urls.length) {
      showProgress((done / urls.length) * 100, t('set.caching', { done, total: urls.length }));
    }
  }
  hideProgress();
  toast(t('set.cacheAllOk'));
  updateNetStatus();
}

async function clearCaches() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('echolingo')).map((k) => caches.delete(k)));
    toast(t('set.cacheCleared'));
  } catch (e) { toast(t('set.cacheClearFail', { msg: e.message })); }
}

/* ============================ 快捷键 ============================ */

function onKeyDown(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  // 空格在聚焦按钮上默认会「激活按钮」。精读时它应始终是播放/暂停，
  // 否则点过某个按钮之后空格就不管用了。
  if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey
      && !['input', 'select', 'textarea'].includes(tag)) {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.target.isContentEditable) return;
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (e.key === 'Escape') {
      if (!$('#urlOverlay').hidden) { e.preventDefault(); closeUrlImport(); return; }
      e.target.blur();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#urlOverlay').hidden) { e.preventDefault(); closeUrlImport(); return; }
    if (!$('#continuePop').hidden) { e.preventDefault(); closeContinuePop(); return; }
    closeWordCard(); closeDrawers(); return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'arrowleft': e.preventDefault(); jumpCue(-1); break;
    case 'arrowright': e.preventDefault(); jumpCue(1); break;
    case 'r': replayCurrent(); break;
    case 'l': toggleLoop(); break;
    case 'e': toggleLang('en'); break;
    case 'c': toggleLang('zh'); break;
    case 'h': toggleReader(); break;
    case 's': {
      const c = S.cues[S.activeIdx];
      if (c) speakIn(c.text, subLang(), { rate: S.settings.ttsRate });
      break;
    }
    case 'd': {
      const c = S.cues[S.activeIdx];
      if (c) toggleFavSentence(c).then(() => {
        const keep = S.activeIdx; renderSubs($('#subSearch').value.trim()); if (keep >= 0) setActive(keep, false);
      });
      break;
    }
    default: break;
  }
}

/* ============================ 链接导入 ============================ */
/* 浏览器直连 YouTube / 哔哩哔哩 会被同源策略和签名校验拦住，所以取流交给本机的
   Node 服务（server.js 里的 /api/url/*），拿到 Blob 后转成 File 交给 openVideoFile，
   后面整条识别 / 翻译 / 跟读流程和本地选文件完全一致。
   静态部署（没跑 server.js）时 /api/url/health 返回网页而非 JSON，这里自动降级成提示。 */

const URL_API = '/api/url/';
// 本地取流助手（桌面版）固定端口；网页版跨域去敲它，敲到哪个算哪个
const HELPER_PORT = 9871;
const HELPER_TRIES = 10;

// 站点根：桌面版把站点铺在 /，网页版铺在 /app/ 下，静态托管也可能铺在根
function siteRoot() {
  const p = location.pathname;
  const i = p.indexOf('/app/');
  if (i >= 0) return location.origin + p.slice(0, i) + '/';
  return location.href.replace(/[^/]*$/, '');
}
// 没装助手时给的下载地址：跟着站点走，换域名也不用改代码
const HELPER_DOWNLOAD = siteRoot() + 'download/helper/';
const UL = {
  ready: null,     // null 未探测 / true 可用 / false 不可用
  base: '',        // '' = 同源；否则是 http://127.0.0.1:87xx
  helper: false,   // 是否走的本机助手
  why: '',
  info: null,      // inspect 结果
  mode: 'video',   // 自动决定的取流方式：video / subtitle
  drm: false,      // 付费 / DRM 内容，官方不给流
  subLangs: [],    // 要抓的字幕语言
  timer: 0,
  busy: false,
};

const apiUrl = (path) => (UL.base || '') + URL_API + path;
// 助手返回的媒体地址是 /api/url/... 这种绝对路径，跨域时要补上 base
const absUrl = (u) => (UL.base && u && u.charAt(0) === '/' ? UL.base + u : u);

async function apiGet(path) {
  const r = await fetch(apiUrl(path), { cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(t('url.needLocal'));
  const data = await r.json();
  if (!r.ok || data.ok === false) throw apiError(data);
  return data;
}

/** 后端已经把人话写好了，这里只把 code 一起带出来给界面判断 */
function apiError(data) {
  const err = new Error(data && data.error ? data.error : t('url.fail'));
  err.code = (data && data.code) || '';
  return err;
}

async function apiPost(path, body) {
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(t('url.needLocal'));
  const data = await r.json();
  if (!r.ok || data.ok === false) throw apiError(data);
  return data;
}

async function probeHealth(base) {
  try {
    const r = await fetch(base + URL_API + 'health', { cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    const data = await r.json();
    return data && typeof data.ok === 'boolean' ? data : null;
  } catch {
    return null;
  }
}

async function probeUrl() {
  if (UL.ready !== null) return UL.ready;

  // 1) 同源：自己开着 server.js（本地开发 / 自建）
  let data = await probeHealth('');
  let base = '';

  // 2) 本机助手：装了桌面版并打开着，网页版直接跨域用它的取流能力
  if (!data || !data.ok) {
    for (let i = 0; i < HELPER_TRIES; i++) {
      const b = `http://127.0.0.1:${HELPER_PORT + i}`;
      const d = await probeHealth(b);
      if (d && d.ok) { data = d; base = b; break; }
    }
  }

  if (data && data.ok) {
    UL.ready = true;
    UL.base = base;
    UL.helper = Boolean(base);
    UL.why = '';
  } else {
    UL.ready = false;
    UL.base = '';
    UL.helper = false;
    UL.why = (data && data.reason) || t('url.needLocal');
  }
  return UL.ready;
}

function setUrlBusy(on) {
  UL.busy = on;
  const go = $('#urlGo');
  if (go) go.disabled = on || !UL.info;
  const lk = $('#urlLookup');
  if (lk) lk.disabled = on;
}

async function openUrlImport() {
  $('#urlOverlay').hidden = false;
  $('#btnUrlImport').setAttribute('aria-expanded', 'true');
  const pop = $('#urlPop');
  pop.classList.remove('in');
  void pop.offsetWidth;
  pop.classList.add('in');
  setUrlBusy(false);
  resetUrlLookup();
  setText('urlNote', t('url.probing'));
  const ok = await probeUrl();
  $('#urlLookup').disabled = !ok;
  setText('urlNote', urlHint());
  syncHelperLink();
  setTimeout(() => $('#urlField').focus(), 60);
}

function stopUrlPoll() {
  if (UL.timer) { clearInterval(UL.timer); UL.timer = 0; }
}

function closeUrlImport() {
  stopUrlPoll();
  $('#urlOverlay').hidden = true;
  $('#btnUrlImport').setAttribute('aria-expanded', 'false');
  setUrlBusy(false);
}

// 底部提示文案：本机接口不可用时始终显示原因，不被普通提示覆盖
function urlHint() {
  return UL.ready === false ? (UL.why || t('url.needLocal')) : t('url.note');
}

// 链接改动后丢掉上一次的解析结果，避免拿旧卡片去导入旧视频
/** 没装助手时，把「下载取流助手」露出来 */
function syncHelperLink() {
  const a = $('#urlGetHelper');
  if (!a) return;
  const need = UL.ready === false;
  a.hidden = !need;
  if (need) a.href = HELPER_DOWNLOAD;
}

function resetUrlLookup() {
  if (UL.info) {
    UL.info = null;
    UL.subLangs = [];
    $('#urlCard').hidden = true;
  }
  $('#urlProgress').hidden = true;
  $('#urlGo').disabled = true;
  setText('urlNote', urlHint());
  syncHelperLink();
}

function renderUrlInfo(info) {
  UL.info = info;
  const card = $('#urlCard');
  card.hidden = false;
  const thumb = $('#urlThumb');
  if (info.thumbnail) { thumb.src = info.thumbnail; thumb.hidden = false; }
  else { thumb.removeAttribute('src'); thumb.hidden = true; }
  setText('urlName', info.title || t('url.untitled'));
  const bits = [];
  if (info.uploader) bits.push(info.uploader);
  if (info.duration) bits.push(fmtTime(info.duration));
  bits.push(info.site === 'bilibili' ? '哔哩哔哩' : 'YouTube');
  setText('urlBy', bits.join(' · '));

  const subOnly = info.subOnly === true;   // 连字幕表都被拦住，只能试着抓一次
  const noMedia = info.mediaAvailable === false;
  // 不让用户选：有画面就「画面 + 声音」整段取回来，取不到就自动退成字幕
  UL.mode = (noMedia || subOnly) ? 'subtitle' : 'video';
  UL.drm = info.drm === true;
  const badge = $('#urlSubBadge');
  if (info.hasSubtitle || subOnly) {
    badge.hidden = false;
    badge.textContent = subOnly ? t('url.subTry') : t('url.hasSub', { lang: info.bestSubLang || '' });
  } else {
    badge.hidden = true;
  }
  $('#urlGo').disabled = false;
  setText('urlNote',
    subOnly ? t('url.subTryNote')
      : noMedia ? (UL.drm ? t('url.drmNote') : t('url.subOnly'))
        : info.hasSubtitle ? t('url.noteSub') : t('url.noteNoSub'));
}

async function lookupUrl() {
  if (UL.busy) return;
  const raw = ($('#urlField').value || '').trim();
  if (!raw) { setText('urlNote', t('url.needUrl')); $('#urlField').focus(); return; }
  setUrlBusy(true);
  $('#urlCard').hidden = true;
  $('#urlProgress').hidden = true;
  setText('urlNote', t('url.looking'));
  try {
    const info = await apiPost('inspect', { url: raw });
    UL.subLangs = info.bestSubLang ? [info.bestSubLang] : [];
    renderUrlInfo(info);
  } catch (e) {
    UL.info = null;
    $('#urlGo').disabled = true;
    const fromApi = Object.prototype.hasOwnProperty.call(e, 'code');
    const msg = fromApi ? e.message : t('url.lookupFail', { msg: e.message });
    setText('urlNote', msg);
    toast(msg, 5200);
  } finally {
    setUrlBusy(false);
  }
}

const URL_STAGE_KEY = {
  prepare: 'url.stagePrepare',
  download: 'url.stageDownload',
  merge: 'url.stageMerge',
  subs: 'url.stageSubs',
  done: 'url.stageDone',
};

function paintProgress(job) {
  const pct = Math.max(0, Math.min(100, job.pct || 0));
  $('#urlProgress').hidden = false;
  $('#urlBar').style.width = pct + '%';
  const stageKey = URL_STAGE_KEY[job.stage];
  let label = stageKey ? t(stageKey) : (job.detail || '');
  if (job.state === 'running' && job.pct > 0 && job.pct < 100) {
    label += ' ' + Math.round(job.pct) + '%';
    if (job.speed) label += ' · ' + job.speed;
    if (job.eta) label += ' · ' + t('url.left', { t: job.eta });
  } else if (job.detail && job.stage !== 'prepare' && job.state === 'running') {
    label = job.detail;
  }
  setText('urlStage', label);
}

async function startUrlImport() {
  if (!LIC_ON && !needLicense()) return;
  if (UL.busy || !UL.info) return;
  const mode = UL.mode || 'video';

  setUrlBusy(true);
  $('#urlProgress').hidden = false;
  $('#urlBar').style.width = '0%';
  setText('urlStage', t('url.stagePrepare'));
  const go = $('#urlGo');
  go.textContent = t('url.working');

  let job;
  try {
    job = await apiPost('open', {
      url: UL.info.url,
      mode,
      subLangs: UL.subLangs.join(','),
      title: UL.info.title,
    });
  } catch (e) {
    setText('urlStage', e.message);
    setText('urlNote', e.message);
    go.textContent = t('url.go');
    setUrlBusy(false);
    return;
  }

  stopUrlPoll();
  UL.timer = setInterval(async () => {
    let cur;
    try {
      cur = await apiGet('job/' + encodeURIComponent(job.jobId));
    } catch (e) {
      stopUrlPoll();
      setText('urlStage', e.message);
      go.textContent = t('url.go');
      setUrlBusy(false);
      return;
    }
    paintProgress(cur);
    if (cur.state === 'running') return;
    stopUrlPoll();
    if (cur.state === 'error') {
      setText('urlStage', cur.error || t('url.fail'));
      setText('urlNote', cur.error || t('url.fail'));
      go.textContent = t('url.go');
      setUrlBusy(false);
      return;
    }
    go.textContent = t('url.go');
    setUrlBusy(false);
    await finishUrlImport(cur.result, mode, cur.degraded);
  }, 700);
}

async function finishUrlImport(res, mode, degraded) {
  if (!res) { setText('urlStage', t('url.fail')); return; }

  // 有官方字幕就先抓下来喂给 importSubtitle，省掉一整轮语音识别
  let subFile = null;
  if (res.subtitleUrl) {
    try {
      const r = await fetch(absUrl(res.subtitleUrl), { cache: 'no-store' });
      if (r.ok) {
        const text = await r.text();
        if (text && text.trim()) {
          subFile = new File([text], res.subtitleName || 'subtitle.srt', { type: 'text/plain' });
        }
      }
    } catch { /* 抓不到就退回自动识别 */ }
  }

  // 只要字幕：不动播放器，直接把字幕灌进当前画面
  if (!res.mediaUrl || mode === 'subtitle') {
    closeUrlImport();
    if (UL.drm) toast(t('url.drmDegraded'), 9000);
    else if (degraded) toast(t('url.degraded'), 9000);
    if (subFile) { await importSubtitle(subFile); return; }
    toast(t('url.noSubtitle'), 5200);
    return;
  }

  setText('urlStage', t('url.stageLoad'));
  let file;
  try {
    const r = await fetch(absUrl(res.mediaUrl), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    file = new File([blob], res.mediaName || 'video.mp4', {
      type: res.mediaType || blob.type || 'video/mp4',
    });
  } catch (e) {
    setText('urlStage', t('url.loadFail', { msg: e.message }));
    return;
  }

  closeUrlImport();

  // 有现成字幕就别让 openVideoFile 顺手再跑一遍自动识别
  const auto = S.settings.autoRun;
  if (subFile) S.settings.autoRun = false;
  try {
    await openVideoFile(file);
  } finally {
    S.settings.autoRun = auto;
  }
  if (subFile) {
    await importSubtitle(subFile);
    toast(t('url.doneSub'), 3600);
  } else {
    toast(t('url.done'), 3600);
  }
}

/* ============================ 入口 ============================
   必须在所有 const/let 声明之后调用：boot() 会同步走到 applyTheme /
   bindUI / registerSW，它们引用了 darkMedia、MS、swReg 等后面才初始化的绑定，
   放在文件顶部会因为暂时性死区（TDZ）直接抛 ReferenceError。
============================================================= */

/* ============================ 版本一致性保险 ============================
   Service Worker 在升级窗口里可能给出「新 JS + 旧 HTML」。此时新脚本引用的
   元素不存在，启动会半途中断，表现为按钮全失效、状态栏停在「待检测」。
   这里主动比对版本标记，不一致就重载一次拿最新页面（用 sessionStorage
   打标记，避免离线时反复刷新）。
====================================================================== */

function guardVersion() {
  const htmlVer = window.__ECHOLINGO_VER__;
  if (!htmlVer || htmlVer === APP_VER) return false;
  let tried = null;
  try { tried = sessionStorage.getItem('echolingo.verReload'); } catch { /* 隐私模式 */ }
  if (tried !== APP_VER) {
    try { sessionStorage.setItem('echolingo.verReload', APP_VER); } catch { /* 忽略 */ }
    console.warn('[EchoLingo] HTML 版本 ' + htmlVer + ' 与脚本版本 ' + APP_VER + ' 不一致，重新加载');
    location.reload();
    return true;
  }
  console.error('[EchoLingo] 版本仍不一致（HTML ' + htmlVer + ' / JS ' + APP_VER + '），已放弃重试');
  return false;
}

if (!guardVersion()) {
  boot().catch((e) => {
    console.error('[EchoLingo] 启动失败', e);
    toast('启动失败：' + ((e && e.message) || e), 6000);
  });
}


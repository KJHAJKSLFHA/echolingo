// 离线语音合成：使用操作系统自带的本地语音，不依赖网络
//
// ── 音色按语言分池 ──
// 以前这里写死 `filter((v) => /^en/i.test(v.lang))`，只认英语音色。系统里明明
// 装着西语音色（macOS 自带 Mónica / Paulina 等 19 个）也被整批滤掉 —— 而且因为
// 滤完还有剩，下面那句「一个都没有就退回全部」的兜底永远不触发，于是西语模式
// 下点朗读要么念英文腔、要么干脆不出声。现在按当前语言建池子，西语模式下
// 音色下拉里就是西语音色。
//
// ⚠️ 这里的「语言」跟随左上角的**模式**（识别语言），不是界面语言。

let voices = [];        // 当前语言的音色池
let allVoices = [];     // 系统里所有音色
let lang = 'en';        // 当前朗读语言：'en' | 'es'
let ready = false;
const listeners = new Set();

// 各语言的偏好音色（按优先级，名字里包含即命中）。
const PREFERRED = {
  en: [
    'Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Serena', 'Fiona',
    'Google US English', 'Microsoft Aria Online (Natural) - English (United States)',
    'Microsoft Jenny Online (Natural) - English (United States)',
    'Microsoft David - English (United States)',
  ],
  // macOS 自带：Mónica（es-ES）、Paulina（es-MX）；后面几条覆盖 Windows/Chrome。
  es: [
    'Mónica', 'Monica', 'Paulina', 'Marisol', 'Diego', 'Jorge', 'Juan',
    'Google español', 'Microsoft Sabina', 'Microsoft Helena', 'Microsoft Laura', 'Microsoft Pablo',
  ],
};

// 找不到任何音色时给 utterance 的兜底 lang
const LANG_TAG = { en: 'en-US', es: 'es-ES' };

/** 这个音色是不是属于语言 l（'es-ES' / 'es-MX' / 'es' 都算 es） */
const isLang = (v, l) => new RegExp('^' + l + '([-_]|$)', 'i').test(String(v.lang || ''));

function rebuild() {
  voices = poolFor(lang);
  ready = voices.length > 0;
  listeners.forEach((fn) => fn(voices));
}

/** 语言 l 的音色池。该语言一个音色都没有时退回全部：
 *  宁可念得口音不对，也别点下去没反应。 */
function poolFor(l) {
  const mine = allVoices.filter((v) => isLang(v, l));
  return mine.length ? mine : allVoices;
}

export function initTTS() {
  if (!('speechSynthesis' in window)) return;
  const load = () => {
    allVoices = speechSynthesis.getVoices();
    rebuild();
  };
  load();
  speechSynthesis.addEventListener('voiceschanged', load);
  setTimeout(load, 400);
}

/** 切换朗读语言（由 applySourceLang 跟着识别模型调用）。返回生效的语言。 */
export function setTTSLang(l) {
  const next = l === 'es' ? 'es' : 'en';
  if (next === lang && voices.length) return lang;
  lang = next;
  rebuild();
  return lang;
}

export function getTTSLang() { return lang; }

export function onVoices(fn) { listeners.add(fn); if (ready) fn(voices); return () => listeners.delete(fn); }

/** 当前语言的候选音色（设置抽屉里的下拉就用这个）。 */
export function getVoices() { return voices; }

/** 系统里所有音色，不分语言。 */
export function getAllVoices() { return allVoices; }

export function hasTTS() { return 'speechSynthesis' in window; }

/** 挑一个音色。useLang 用来临时借另一种语言的音色池
 *  （收藏里混着英语句和西语句，读哪条就用哪条的语言，跟当前模式无关）。 */
export function pickVoice(name, useLang = lang) {
  const pool = useLang === lang ? voices : poolFor(useLang);
  if (name) {
    const found = allVoices.find((v) => v.name === name) || pool.find((v) => v.name === name);
    if (found) return found;
  }
  for (const p of (PREFERRED[useLang] || [])) {
    const v = pool.find((x) => x.name.includes(p));
    if (v) return v;
  }
  return pool.find((v) => v.localService) || pool[0] || null;
}

let current = null;

export function stopSpeak() {
  if (!hasTTS()) return;
  try { speechSynthesis.cancel(); } catch {}
  current = null;
}

export function speak(text, { voiceName, rate = 0.95, pitch = 1, onEnd, lang: useLang = lang } = {}) {
  if (!hasTTS() || !text) return false;
  try { speechSynthesis.cancel(); } catch {}
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(voiceName, useLang);
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = LANG_TAG[useLang] || 'en-US'; }
  u.rate = rate;
  u.pitch = pitch;
  if (onEnd) u.onend = onEnd;
  current = u;
  // 部分浏览器需要短暂延迟才能稳定发声
  speechSynthesis.speak(u);
  return true;
}

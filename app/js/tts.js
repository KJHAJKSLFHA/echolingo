// 离线语音合成：使用操作系统自带的本地语音，不依赖网络

let voices = [];
let ready = false;
const listeners = new Set();

const PREFERRED = [
  'Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Serena', 'Fiona',
  'Google US English', 'Microsoft Aria Online (Natural) - English (United States)',
  'Microsoft Jenny Online (Natural) - English (United States)',
  'Microsoft David - English (United States)',
];

export function initTTS() {
  if (!('speechSynthesis' in window)) return;
  const load = () => {
    voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    if (!voices.length) voices = speechSynthesis.getVoices();
    ready = voices.length > 0;
    listeners.forEach((fn) => fn(voices));
  };
  load();
  speechSynthesis.addEventListener('voiceschanged', load);
  setTimeout(load, 400);
}

export function onVoices(fn) { listeners.add(fn); if (ready) fn(voices); return () => listeners.delete(fn); }
export function getVoices() { return voices; }
export function hasTTS() { return 'speechSynthesis' in window; }

export function pickVoice(name) {
  if (name) {
    const found = voices.find((v) => v.name === name);
    if (found) return found;
  }
  for (const p of PREFERRED) {
    const v = voices.find((x) => x.name.includes(p));
    if (v) return v;
  }
  return voices.find((v) => v.localService) || voices[0] || null;
}

let current = null;

export function stopSpeak() {
  if (!hasTTS()) return;
  try { speechSynthesis.cancel(); } catch {}
  current = null;
}

export function speak(text, { voiceName, rate = 0.95, pitch = 1, onEnd } = {}) {
  if (!hasTTS() || !text) return false;
  try { speechSynthesis.cancel(); } catch {}
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(voiceName);
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
  u.rate = rate;
  u.pitch = pitch;
  if (onEnd) u.onend = onEnd;
  current = u;
  // 部分浏览器需要短暂延迟才能稳定发声
  speechSynthesis.speak(u);
  return true;
}

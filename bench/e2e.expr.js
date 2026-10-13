const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const btn = document.getElementById('btnTranscribe');

const out = {
  env: {
    hc: navigator.hardwareConcurrency,
    iso: self.crossOriginIsolated,
    mem: navigator.deviceMemory || 0,
    chrome: (navigator.userAgent.match(/Chrome\/[\d.]+/) || [])[0],
  },
};
const fi = document.getElementById('fileVideo');
out.file = fi?.files?.[0] ? { name: fi.files[0].name, mb: +(fi.files[0].size / 1048576).toFixed(1) } : null;

// 等应用接收文件、按钮亮起
let t = performance.now();
while (performance.now() - t < 60000 && btn.disabled) await sleep(200);
out.waitFileMs = Math.round(performance.now() - t);
out.fileReady = !btn.disabled;

const dur = $('#player')?.duration;
out.videoSec = isFinite(dur) && dur ? +dur.toFixed(1) : null;

// 点「开始识别」，一路采样到全部结束
const t1 = performance.now();
btn.click();
let asrMs = null, totalMs = null;
let lastN = -1, stable = 0, lastText = '';
const marks = [];

while (performance.now() - t1 < 1200000) {
  await sleep(250);
  const el = Math.round(performance.now() - t1);
  const n = document.querySelectorAll('.cue-zh').length;
  const text = (document.getElementById('progressText')?.textContent || '').trim();
  const hidden = !!document.getElementById('progressWrap')?.hidden;
  if (text !== lastText) { marks.push({ t: el, text }); lastText = text; }
  if (n === lastN) stable++; else stable = 0;
  lastN = n;
  // 进入翻译阶段 = 识别已经跑完
  if (asrMs === null && /翻译|Translating/.test(text)) asrMs = el;
  if (hidden && n > 0 && stable >= 8) { totalMs = el; break; }
}
out.asrMs = asrMs;
out.totalMs = totalMs;
out.cues = lastN;
out.enNodes = document.querySelectorAll('.cue-en').length;
out.进度节点 = marks.length;
out.前段 = marks.slice(0, 14);
out.尾段 = marks.slice(-6);
out.设置面板说明 = (document.getElementById('asrModelNote')?.textContent || '').slice(0, 260);
return JSON.stringify(out, null, 1);

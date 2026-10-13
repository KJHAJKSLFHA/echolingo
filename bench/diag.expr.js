const out = {
  ready: window.__ready,
  state: document.readyState,
  url: location.href,
  keys: Object.keys(window).filter((k) => /env|infer|decode|load|runSeg/i.test(k)),
};
try {
  const m = await import('/vendor/transformers.min.js');
  out.import = 'ok pipeline=' + typeof m.pipeline + ' env=' + typeof m.env;
} catch (e) { out.import = 'FAIL ' + (e && e.message); }
try {
  const h = await fetch('/bench/bench.html');
  const t = await h.text();
  out.html = { status: h.status, len: t.length, hasEnv: t.includes('window.env$'), head: t.slice(0, 120) };
} catch (e) { out.htmlErr = String(e); }
return JSON.stringify(out, null, 1);

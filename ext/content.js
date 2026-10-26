/* EchoLingo 取流助手 · 页面桥
   网页跑在自己的源里，拿不到 chrome.runtime，所以走三段式：
     EchoLingo 页面  --window.postMessage-->  content.js  --chrome.runtime.sendMessage-->  background
   只对 EchoLingo 自己的页面回应，其它站点一律不理。

   注意：content script 跑在隔离世界，读不到页面里 window.__ECHOLINGO_VER__ 这种页面变量，
   认亲只能看 DOM（meta / link[rel=manifest] / documentElement 标记），这些是两边共享的。 */
(function () {
  'use strict';

  const CH = 'echolingo-ext';
  const VERSION = '1.0.0';

  function isEchoLingo() {
    try {
      const root = document.documentElement;
      if (root && root.dataset && root.dataset.echolingo) return true;
      if (document.querySelector('meta[name="echolingo"]')) return true;
      if (document.querySelector('meta[name="application-name"][content="EchoLingo"]')) return true;
      const l = document.querySelector('link[rel="manifest"]');
      if (l && /manifest\.webmanifest/.test(l.getAttribute('href') || '')) return true;
    } catch {
      /* 读不到就当不是 */
    }
    return false;
  }

  function hello() {
    window.postMessage({ channel: CH, type: 'hello', version: VERSION }, location.origin || '*');
  }

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.channel !== CH) return;
    if (ev.source !== window) return;
    if (!isEchoLingo()) return;

    // 页面来问「你在不在」——直接答，避免双方等对方先开口
    if (d.type === 'ping') {
      hello();
      return;
    }
    if (d.type !== 'call') return;

    const id = d.id;
    const reply = (payload) => {
      window.postMessage({ channel: CH, type: 'reply', id, payload }, location.origin || '*');
    };

    try {
      const res = await chrome.runtime.sendMessage({
        channel: CH,
        action: d.action,
        url: d.url,
        mode: d.mode,
        jobId: d.jobId,
        mediaUrl: d.mediaUrl,
        offset: d.offset,
        total: d.total,
        length: d.length,
      });
      reply(res);
    } catch (e) {
      reply({
        ok: false,
        error: (e && e.message) || '扩展没有响应，请在扩展管理页确认它已启用。',
        code: 'noext',
      });
    }
  }, false);

  // DOM 一就绪就主动报个到；页面若比我们晚，会自己 ping 过来
  const say = () => { if (isEchoLingo()) hello(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', say, { once: true });
  } else {
    say();
  }
})();

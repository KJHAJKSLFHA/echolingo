/* EchoLingo 取流助手 · 弹窗：自查四件事有没有到位 */
(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'v' + (cls ? ' ' + cls : '');
  };

  const manifest = chrome.runtime.getManifest();
  $('ver').textContent = `版本 ${manifest.version} · MV${manifest.manifest_version}`;
  set('sExt', '已启用', 'ok');
  $('dot').className = 'dot on';

  // 1) background 能不能自答 health
  try {
    const h = await chrome.runtime.sendMessage({ channel: 'echolingo-ext', action: 'health' });
    if (h && h.ok) {
      $('ver').textContent = `版本 ${manifest.version} · 引擎 ${h.engine || 'extension'}`;
    } else {
      set('sExt', '后台无响应', 'bad');
      $('dot').className = 'dot bad';
    }
  } catch {
    set('sExt', '后台无响应', 'bad');
    $('dot').className = 'dot bad';
  }

  // 2) 两家站点分别探一次，看网络与接口是否通
  async function probeSite(site, url) {
    try {
      const r = await chrome.runtime.sendMessage({ channel: 'echolingo-ext', action: 'inspect', url });
      if (r && r.ok) return { ok: true, title: r.title || '' };
      return { ok: false, why: (r && r.error) || '解析失败' };
    } catch (e) {
      return { ok: false, why: (e && e.message) || '请求失败' };
    }
  }

  const [yt, bili] = await Promise.all([
    probeSite('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    probeSite('bilibili', 'https://www.bilibili.com/video/BV1GJ411x7h7'),
  ]);

  if (yt.ok) set('sYt', '接口通', 'ok');
  else set('sYt', yt.why.slice(0, 22), 'bad');

  if (bili.ok) set('sBili', '接口通', 'ok');
  else set('sBili', bili.why.slice(0, 22), 'bad');

  // 3) DNR 规则数
  try {
    const rules = await chrome.declarativeNetRequest.getEnabledRulesets();
    const dyn = await chrome.declarativeNetRequest.getDynamicRules();
    const n = (rules ? rules.length : 0) + (dyn ? dyn.length : 0);
    set('sRule', n ? `${n} 组已启用` : '未启用', n ? 'ok' : 'bad');
  } catch {
    set('sRule', '无法读取', 'bad');
  }

  if (!yt.ok && !bili.ok) {
    $('dot').className = 'dot bad';
    $('tip').textContent = '两家站点都不通：先确认这台机器能正常打开 YouTube 和哔哩哔哩，再回来重试。';
  }
})();

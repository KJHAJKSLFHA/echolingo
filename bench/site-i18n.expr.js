// 官网首页三语实测：在真实 Chrome 里把三种语言各渲染一遍，检查
//   1) <html lang> 是否正确
//   2) 是否还有「没被翻译」的元素（textContent 与字典不符 / 残留中文）
//   3) 语言切换按钮是否工作、是否记住选择
// 本文件被包进 `(async () => { ... })()` 里执行，所以最后一行必须写成 `return`：
// 尾部的裸表达式会被当成表达式语句而丢掉值（实测返回 undefined，很容易白查一轮）。
const out = { ok: true, problems: [], langs: {} };

const btn = (l) => document.querySelector(`[data-lang-btn="${l}"]`);
const waitFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

if (!window.SITE_I18N) {
  out.ok = false;
  out.problems.push('SITE_I18N 未定义（首页脚本没跑起来）');
} else {
  const bn = btn('zh');
  if (!bn) { out.ok = false; out.problems.push('缺少中文切换按钮'); }

  for (const l of ['zh', 'en', 'es']) {
    const b = btn(l);
    if (!b) { out.problems.push(`缺少 ${l} 切换按钮`); out.ok = false; continue; }
    b.click();
    await waitFrame();

    const d = window.SITE_I18N[l];
    const problems = [];
    if (!d) { problems.push(`字典里没有 ${l}`); }

    // 1. <html lang>
    const expectLang = l === 'zh' ? 'zh-CN' : l;
    if (document.documentElement.lang !== expectLang) {
      problems.push(`html lang = ${document.documentElement.lang}，应为 ${expectLang}`);
    }

    // 2. 逐个元素核对渲染结果
    let checked = 0;
    document.querySelectorAll('[data-i18n]').forEach((n) => {
      const k = n.dataset.i18n;
      checked++;
      if (!d || !d[k]) { problems.push(`字典 ${l} 缺 key ${k}`); return; }
      if (n.textContent !== d[k]) {
        problems.push(`[${k}] 渲染 "${n.textContent.slice(0, 40)}" ≠ 字典 "${String(d[k]).slice(0, 40)}"`);
      }
    });
    document.querySelectorAll('[data-i18n-html]').forEach((n) => {
      const k = n.dataset.i18nHtml;
      checked++;
      if (!d || !d[k]) { problems.push(`字典 ${l} 缺 key ${k}`); return; }
      if (n.innerHTML !== d[k]) problems.push(`[${k}] innerHTML 与字典不符`);
    });

    // 3. 非中文页面上不该再有成片汉字（「中文」按钮本身除外）
    let hanCount = 0;
    if (l !== 'zh') {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        const t = n.textContent.trim();
        if (!t) continue;
        const p = n.parentElement;
        if (!p || p.closest('.lang-seg')) continue;
        if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE') continue;
        if (/[\u4e00-\u9fff]/.test(t)) {
          hanCount++;
          problems.push(`残留中文：<${p.tagName.toLowerCase()}> "${t.slice(0, 50)}"`);
        }
      }
    }

    let saved = null;
    try { saved = localStorage.getItem('echolingo.site.lang'); } catch (e) {}

    const descEl = document.querySelector('meta[name="description"]');
    out.langs[l] = {
      htmlLang: document.documentElement.lang,
      title: document.title,
      desc: descEl ? descEl.content.slice(0, 60) : '',
      checked,
      hanResidue: hanCount,
      saved,
      problems,
    };
    if (problems.length) out.ok = false;
    out.problems.push(...problems.map((p) => `[${l}] ${p}`));
  }

  // 切回中文，确认选择被记住
  if (bn) { bn.click(); await waitFrame(); }
  try { out.remembered = localStorage.getItem('echolingo.site.lang'); } catch (e) {}
}

return JSON.stringify(out, null, 2);

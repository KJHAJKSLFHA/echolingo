// EchoLingo 取流助手 · 后台
// 职责：扮演网页版里 server.js 的 /api/url/* 四个接口，把「取流」这件事在浏览器里做完。
//   GET  health        能力探测
//   POST inspect       解析链接，返回标题/封面/时长/来源/有没有字幕
//   POST open          建任务，返回 jobId
//   GET  job/:id       查进度；done 时 result 里带 mediaUrl（浏览器能直连下载的地址）
// 页面拿到 mediaUrl 后自己 fetch 成 Blob 再转 File，字节不走消息通道，避免大文件卡死。

const YT_CLIENT = {
  clientName: 'ANDROID_VR',
  clientVersion: '1.62.27',
  androidSdkVersion: 30,
  osName: 'Android',
  osVersion: '12',
  hl: 'en',
  gl: 'US',
};

const YT_UA = 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US) gzip';
const YT_API = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const JOBS = new Map();

/* ---------------------------- 工具 ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJobId() {
  return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fail(code, error) {
  const err = new Error(error);
  err.code = code;
  return err;
}

function cleanTitle(s, fallback) {
  const t = String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[\\/:*?"<>|]/g, '_').trim();
  return t.slice(0, 90) || fallback;
}

/** 从各种形态的链接里认出站点与 id */
function parseLink(raw) {
  const url = String(raw || '').trim();
  if (!url) throw fail('badurl', '请先粘贴一个视频链接。');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw fail('badurl', '这不像一个链接，请复制完整的视频网址。');
  }
  const host = u.hostname.toLowerCase();

  // 哔哩哔哩
  if (host === 'b23.tv' || host.endsWith('bilibili.com')) {
    let bvid = '';
    let aid = '';
    let page = 1;
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{8,12})/);
    if (m) bvid = m[1];
    const ma = u.pathname.match(/\/video\/av(\d+)/i);
    if (ma) aid = ma[1];
    const pv = u.searchParams.get('p');
    if (pv && /^\d+$/.test(pv)) page = Math.max(1, parseInt(pv, 10));
    return { site: 'bilibili', kind: bvid || aid ? 'video' : 'short', url, bvid, aid, page };
  }

  // YouTube
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\/+/, '').split('/')[0];
    return { site: 'youtube', kind: id ? 'video' : 'short', url, vid: id };
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (u.pathname === '/watch') {
      return { site: 'youtube', kind: 'video', url, vid: u.searchParams.get('v') || '' };
    }
    const shorts = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (shorts) return { site: 'youtube', kind: 'video', url, vid: shorts[1] };
    const em = u.pathname.match(/^\/embed\/([\w-]{6,})/);
    if (em) return { site: 'youtube', kind: 'video', url, vid: em[1] };
    return { site: 'youtube', kind: 'short', url, vid: '' };
  }
  throw fail('badsite', '目前只支持 YouTube 和哔哩哔哩的链接。');
}

/* ------------------------ YouTube ------------------------ */

async function ytPlayer(videoId) {
  const body = {
    context: { client: YT_CLIENT },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const r = await fetch(YT_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': YT_UA,
      'x-youtube-client-name': '28',
      'x-youtube-client-version': YT_CLIENT.clientVersion,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw fail('yt-http', `YouTube 接口返回 ${r.status}，稍后再试。`);
  return r.json();
}

function ytPickAudio(adaptive) {
  // 优先 m4a（容器兼容性最好），码率高的在前
  const m4a = adaptive.filter((f) => /^audio\/mp4/.test(f.mimeType || '') && f.url);
  if (m4a.length) {
    m4a.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    return m4a[0];
  }
  const anyAudio = adaptive.filter((f) => /^audio\//.test(f.mimeType || '') && f.url);
  if (anyAudio.length) {
    anyAudio.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    return anyAudio[0];
  }
  return null;
}

function ytPickProgressive(formats) {
  const mp4 = formats.filter((f) => /^video\/mp4/.test(f.mimeType || '') && f.url);
  if (!mp4.length) return null;
  const withAudio = mp4.filter((f) => /mp4a/.test(f.mimeType || ''));
  const pool = withAudio.length ? withAudio : mp4;
  pool.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
  return pool[0];
}

/** 万一只拿回 XML timedtext，就地转成 WebVTT（页面的解析器只认 VTT/SRT） */
function timedTextToVtt(xml) {
  const out = ['WEBVTT', ''];
  const re = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const st = Number(m[1]) || 0;
    const du = Number(m[2]) || 2;
    out.push(`${vttTime(st)} --> ${vttTime(st + du)}`);
    out.push(
      m[3]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim(),
    );
    out.push('');
  }
  return out.join('\n');
}

function vttTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}

function ytCaptions(player) {
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return tracks
    .filter((c) => c && c.baseUrl)
    .map((c) => ({
      lang: c.languageCode || '',
      name: (c.name && (c.name.simpleText || c.name.runs?.[0]?.text)) || c.languageCode || '',
      auto: c.kind === 'asr',
      url: c.baseUrl,
    }));
}

async function ytInspect(link) {
  if (!link.vid) throw fail('badurl', '这条 YouTube 链接里没有视频 id。');
  const player = await ytPlayer(link.vid);
  const status = player?.playabilityStatus?.status || '';
  const details = player?.videoDetails || {};
  const sd = player?.streamingData || {};
  const formats = sd.formats || [];
  const adaptive = sd.adaptiveFormats || [];
  const progressive = ytPickProgressive(formats);
  const audio = ytPickAudio(adaptive);
  const tracks = ytCaptions(player);
  const drm =
    status === 'UNPLAYABLE' && /DRM|premium|paid|members/i.test(
      player?.playabilityStatus?.reason || '',
    );

  if (status && status !== 'OK' && !progressive && !audio) {
    const reason = player?.playabilityStatus?.reason || status;
    throw fail(drm ? 'drm' : 'unplayable', `这条视频取不到流：${reason}`);
  }

  const best = tracks.find((c) => !c.auto && /^en/i.test(c.lang)) || tracks.find((c) => !c.auto) || tracks[0];
  return {
    ok: true,
    url: link.url,
    site: 'youtube',
    siteName: 'YouTube',
    id: link.vid,
    title: details.title || '',
    uploader: details.author || '',
    duration: Number(details.lengthSeconds) || 0,
    thumbnail: details.thumbnail?.thumbnails?.slice(-1)[0]?.url || '',
    hasSubtitle: tracks.length > 0,
    bestSubLang: best ? best.lang : '',
    mediaAvailable: Boolean(progressive || audio),
    subOnly: !(progressive || audio) && tracks.length > 0,
    drm,
  };
}

/* ------------------------ 哔哩哔哩 ------------------------ */

async function biliJson(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent': BILI_UA,
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
    },
  });
  if (!r.ok) throw fail('bili-http', `哔哩哔哩接口返回 ${r.status}，稍后再试。`);
  const data = await r.json();
  if (data.code !== 0) {
    throw fail(String(data.code), data.message || `哔哩哔哩返回错误 ${data.code}`);
  }
  return data.data;
}

/** b23.tv 短链先跳一次拿到真地址 */
async function biliResolve(link) {
  if (!/^https?:\/\/b23\.tv\//i.test(link.url)) return link;
  const r = await fetch(link.url, { redirect: 'follow', headers: { 'user-agent': BILI_UA } });
  const finalUrl = r.url || link.url;
  return parseLink(finalUrl);
}

async function biliView(link) {
  const q = link.bvid
    ? `bvid=${encodeURIComponent(link.bvid)}`
    : `aid=${encodeURIComponent(link.aid)}`;
  return biliJson(`https://api.bilibili.com/x/web-interface/view?${q}`);
}

/* 取流接口的选择（都实测过，别改回去）：
   · fnval=1 默认给 PCDN 地址（*.edge.mountaintoys.cn:4483）：不带 Referer → 403，带 Referer → 206。
     而 Chrome 的 DNR 不允许修改 Referer 这种受限请求头，扩展改不动。
   · fnval=16 的 dash.audio（mcdn.bilivideo.cn:8082）：主流节点实测 503，备用串 403，不可靠。
   · platform=html5&high_quality=1&qn=16 给的是普通 CDN（cn-*.bilivideo.com）：
     **不带 Referer 也回 206 video/mp4**，带不带都行——这才是扩展能直接用的一条。
   代价是最多 720P，对精听场景足够；音轨本来也不需要更高。 */
async function biliPlayurl(bvid, cid) {
  const q =
    `bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}` +
    '&fnval=0&fnver=0&qn=16&platform=html5&high_quality=1';
  return biliJson(`https://api.bilibili.com/x/player/playurl?${q}`);
}

/** 从 durl 里取出第一个可用分片（html5 接口通常只有一段） */
function biliPickSegment(play) {
  const durl = play?.durl || [];
  const seg = durl.find((d) => d && d.url);
  if (!seg) return null;
  const host = (() => {
    try {
      return new URL(seg.url).host;
    } catch {
      return '';
    }
  })();
  return {
    url: seg.url,
    mime: 'video/mp4',
    size: Number(seg.size) || Number(play?.timelength) / 1000 || 0,
    backup: Array.isArray(seg.backup_url) ? seg.backup_url.filter(Boolean) : [],
    host,
  };
}

async function biliInspect(link) {
  const l = await biliResolve(link);
  if (l.kind === 'short') throw fail('badurl', '这是哔哩哔哩的短链或番剧页，请打开视频后复制地址栏里的 /video/BV… 链接。');
  const view = await biliView(l);
  const page = Math.min(Math.max(1, l.page || 1), (view.pages || []).length || 1);
  const pg = (view.pages || [])[page - 1] || {};
  return {
    ok: true,
    url: l.url,
    site: 'bilibili',
    siteName: '哔哩哔哩',
    id: view.bvid,
    cid: pg.cid || view.cid || 0,
    title: page > 1 ? `${view.title || ''} P${page}` : view.title || '',
    uploader: view.owner?.name || '',
    duration: Number(pg.duration || view.duration) || 0,
    thumbnail: view.pic || '',
    hasSubtitle: false, // 普通投稿大多没有 CC 字幕，直接走识别
    bestSubLang: '',
    mediaAvailable: true,
    subOnly: false,
    drm: false,
  };
}

/* ------------------------ 任务执行 ------------------------ */

function setJob(id, patch) {
  const cur = JOBS.get(id);
  if (!cur) return;
  Object.assign(cur, patch, { at: Date.now() });
}

async function runYoutubeJob(id, link, mode) {
  setJob(id, { stage: 'prepare', pct: 4, detail: '正在向 YouTube 询问可用流…' });
  const player = await ytPlayer(link.vid);
  const details = player?.videoDetails || {};
  const sd = player?.streamingData || {};
  const progressive = ytPickProgressive(sd.formats || []);
  const audio = ytPickAudio(sd.adaptiveFormats || []);
  const tracks = ytCaptions(player);

  /* 一律优先音轨：googlevideo 的响应只发 `vary: Origin` 不发 Access-Control-Allow-Origin，
     页面 fetch 必被 CORS 拦（实测 corsError: MissingAllowOriginHeader），
     DNR 改响应头对页面请求不生效（用 example.com 对照验证过）。
     所以两条路都不通页面直连，统一让扩展后台代取字节，页面只要音轨即可。 */
  const pick = audio || progressive;
  if (!pick || !pick.url) {
    throw fail('noformat', '这条视频没有可以直接下载的流（可能是直播或会员内容）。');
  }

  setJob(id, {
    stage: 'download',
    pct: 12,
    detail: '已找到音轨，准备下载',
  });

  const isAudio = /^audio\//.test(pick.mimeType || '');
  const ext = isAudio ? (pick.mimeType.includes('webm') ? 'webm' : 'm4a') : 'mp4';
  const base = cleanTitle(details.title, 'youtube-' + link.vid);
  const mediaName = `${base}.${ext}`;

  let subtitleUrl = '';
  let subtitleName = '';
  const bestSub = tracks.find((c) => !c.auto && /^en/i.test(c.lang)) || tracks[0];
  if (bestSub && bestSub.url) {
    try {
      /* baseUrl 里已经带了 fmt=srv3，再往后拼 &fmt=vtt 会被忽略，拿回来的是
         XML timedtext（实测 200 / 3877 字节 / `<timedtext format="3">`），
         而页面的判断和解析都按 WebVTT 来，所以必须用 URL API 把 fmt 换掉。 */
      const u = new URL(bestSub.url);
      u.searchParams.set('fmt', 'vtt');
      const subR = await fetch(u.toString(), { credentials: 'omit' });
      if (subR.ok) {
        let text = await subR.text();
        if (text && !/^WEBVTT/i.test(text.trim()) && /<timedtext/i.test(text)) {
          text = timedTextToVtt(text);
        }
        if (text && /-->/.test(text)) {
          subtitleUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
          subtitleName = `${base}.${bestSub.lang || 'en'}.vtt`;
        }
      }
    } catch {
      /* 字幕拿不到不影响主流程 */
    }
  }

  setJob(id, {
    state: 'done',
    pct: 100,
    stage: 'done',
    detail: subtitleUrl ? '音轨已就绪（另带官方字幕）' : '音轨已就绪',
    result: {
      ok: true,
      mediaUrl: pick.url,
      mediaName,
      mediaType: String(pick.mimeType || 'audio/mp4').split(';')[0].trim(),
      mediaSize: Number(pick.contentLength) || 0,
      proxy: true, // 页面直连会被 CORS 拦，走扩展分块代取
      subtitleUrl,
      subtitleName,
      title: details.title || '',
      site: 'youtube',
      duration: Number(details.lengthSeconds) || 0,
    },
  });
}

async function runBilibiliJob(id, link, mode) {
  setJob(id, { stage: 'prepare', pct: 4, detail: '正在向哔哩哔哩询问可用流…' });
  const l = await biliResolve(link);
  const view = await biliView(l);
  const page = Math.min(Math.max(1, l.page || 1), (view.pages || []).length || 1);
  const pg = (view.pages || [])[page - 1] || {};
  const cid = pg.cid || view.cid;
  if (!cid) throw fail('nocid', '这条视频没拿到分 P 编号，换一个链接试试。');

  const play = await biliPlayurl(view.bvid, cid);
  const seg = biliPickSegment(play);
  if (!seg) {
    throw fail('noformat', '哔哩哔哩没有返回可用流（可能是番剧、付费内容或需要登录）。');
  }

  const base = cleanTitle(page > 1 ? `${view.title} P${page}` : view.title, 'bili-' + view.bvid);
  setJob(id, {
    stage: 'download',
    pct: 12,
    detail: `已找到流，约 ${(seg.size / 1048576 || 0).toFixed(1)} MB`,
  });

  setJob(id, {
    state: 'done',
    pct: 100,
    stage: 'done',
    detail: '流已就绪',
    result: {
      ok: true,
      mediaUrl: seg.url,
      mediaBackups: seg.backup,
      mediaName: `${base}.mp4`,
      mediaType: 'video/mp4',
      mediaSize: seg.size,
      proxy: true, // 页面直连会被防盗链/CORS 拦，走扩展分块代取
      subtitleUrl: '',
      subtitleName: '',
      title: view.title || '',
      site: 'bilibili',
      duration: Number(pg.duration || view.duration) || 0,
    },
  });
}

async function runJob(id) {
  const job = JOBS.get(id);
  if (!job) return;
  try {
    if (job.site === 'youtube') await runYoutubeJob(id, job.link, job.mode);
    else await runBilibiliJob(id, job.link, job.mode);
  } catch (e) {
    setJob(id, {
      state: 'error',
      pct: 100,
      stage: 'error',
      detail: '',
      error: e && e.message ? e.message : '取流失效',
      code: (e && e.code) || 'fail',
    });
  }
  // 半小时后自己清掉，免得 service worker 里越攒越多
  setTimeout(() => JOBS.delete(id), 30 * 60 * 1000);
}

/* ------------------------ 消息入口 ------------------------ */

async function handle(msg) {
  const action = msg && msg.action;
  if (action === 'health') {
    return {
      ok: true,
      app: 'echolingo-ext',
      version: chrome.runtime.getManifest().version,
      ytdlp: 'browser',
      ffmpeg: 'browser',
      engine: 'extension',
      msg: '取流扩展已就绪',
    };
  }

  if (action === 'inspect') {
    const link = parseLink(msg.url);
    if (link.site === 'youtube') return ytInspect(link);
    return biliInspect(link);
  }

  if (action === 'open') {
    const link = parseLink(msg.url);
    const id = newJobId();
    JOBS.set(id, {
      id,
      state: 'running',
      stage: 'prepare',
      pct: 2,
      detail: '准备中',
      site: link.site,
      link,
      mode: msg.mode === 'audio' ? 'audio' : 'video',
      at: Date.now(),
    });
    runJob(id);
    return { ok: true, jobId: id };
  }

  if (action === 'job') {
    const job = JOBS.get(msg.jobId);
    if (!job) return { ok: false, error: '任务不存在或已过期，请重新导入。', code: 'nojob' };
    return { ok: true, ...job };
  }

  /* 分块代取媒体字节。
     媒体主机（googlevideo / bilivideo 分片）要么不发 ACAO、要么只对特定 Referer 放行，
     页面的 fetch 一定失败；而扩展后台发起同样的请求能拿到 206。
     所以由后台拉一段字节，base64 后经消息通道交回页面，页面拼成 Blob 再用。
     块大小 1 MB：base64 后约 1.37 MB，远低于单条消息上限。 */
  if (action === 'mediaChunk') {
    return mediaChunk(msg);
  }

  throw fail('unknown', '扩展不认识这个操作。');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.channel !== 'echolingo-ext') return false;
  handle(msg)
    .then((data) => sendResponse(data))
    .catch((e) =>
      sendResponse({
        ok: false,
        error: e && e.message ? e.message : '取流失效',
        code: (e && e.code) || 'fail',
      }),
    );
  return true; // 异步回包
});

// 装好后在支持的站点上给个角标，提示扩展在位
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' }).catch?.(() => {});
});

/* ==== YouTube 接口请求头修正 ====
   浏览器从扩展后台发出的请求会自动带上 Origin: chrome-extension://<id>，
   YouTube 的 youtubei 接口看到陌生 Origin 直接回 403（实测：
   带 Origin → 403；用 DNR 去掉 Origin/Referer 并把 UA 换成 ANDROID_VR → 200 / OK）。
   这条规则必须**只作用于扩展自己发起的请求**（initiatorDomains = 本扩展 id），
   否则会把用户正常浏览 YouTube 的请求也一起改掉。
   id 只有运行时才知道，因此用 session 规则注册，而不是写进静态 rules.json。 */
const YT_HEADER_RULE_ID = 901;

async function syncYtHeaderRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [YT_HEADER_RULE_ID],
      addRules: [
        {
          id: YT_HEADER_RULE_ID,
          priority: 9,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'user-agent', operation: 'set', value: YT_UA },
              { header: 'origin', operation: 'remove' },
              { header: 'referer', operation: 'remove' },
            ],
          },
          condition: {
            urlFilter: 'youtube.com/youtubei/',
            resourceTypes: ['xmlhttprequest', 'other'],
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    });
  } catch (e) {
    console.warn('[echolingo-ext] 注册 YouTube 请求头规则失败', e);
  }
}

syncYtHeaderRule();
chrome.runtime.onInstalled.addListener(syncYtHeaderRule);
chrome.runtime.onStartup.addListener(syncYtHeaderRule);

/* ------------------------ 分块代取 ------------------------ */

const CHUNK_SIZE = 1024 * 1024;

function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

async function mediaChunk(msg) {
  const url = msg.mediaUrl;
  if (!url) throw fail('badurl', '缺少媒体地址。');
  const total = Math.max(0, Number(msg.total) || 0);
  const offset = Math.max(0, Number(msg.offset) || 0);
  const want = Math.max(1, Math.min(CHUNK_SIZE, Number(msg.length) || CHUNK_SIZE));

  const headers = {};
  const end = total ? Math.min(offset + want, total) - 1 : offset + want - 1;
  if (total || offset) headers.range = `bytes=${offset}-${end}`;

  const r = await fetch(url, { headers, cache: 'no-store' });
  if (!(r.ok || r.status === 206)) {
    throw fail('chunk-http', `媒体服务器返回 ${r.status}`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  const cr = r.headers.get('content-range') || '';
  const m = /\/(\d+)$/.exec(cr);
  const size = m ? Number(m[1]) : total || (offset + buf.length);
  return {
    ok: true,
    offset,
    data: bytesToBase64(buf),
    n: buf.length,
    size,
    done: offset + buf.length >= size,
  };
}

// 把站点 + Electron 主程序打成一个自包含的 EchoLingo.app
//
//   node build.mjs                        # 打当前架构（Apple Silicon 上是 arm64）
//   ARCH=x64 node build.mjs               # 需要 Intel 版时
//   ELECTRON_VERSION=44.7.0 node build.mjs
//
// 产物：../dist/EchoLingo.app
//
// ── 为什么不用 @electron/packager ──
//
// packager 依赖 @electron/get + @electron-internal/extract-zip，后者是个
// napi-rs 原生模块。在 macOS 27 上加载它会直接被库校验拒掉：
//
//   dlopen(...index.darwin-universal.node): code signature ...
//   not valid for use in process: mapping process and mapped file
//   (non-platform) have different Team IDs
//
// 也就是说 Node 进程和那个 .node 的 Team ID 不一致，系统不允许加载。
// 这条链（electron/install.js 解压、packager 解压）在本机会全部失败。
//
// 而 zip 本身的下载是好的。所以这里干脆不依赖任何 npm 包：
//   · 自己用 fetch 下 Electron 的 zip（带镜像回退）
//   · 用系统的 ditto 解压（macOS 原生，处理签名/扩展属性最稳）
//   · 手工组装 bundle（改名、改 Info.plist、放 app 与图标）
//   · 最后 ad-hoc 重新签名 —— Apple Silicon 上不签名根本起不来，
//     而且往 bundle 里塞东西后 Electron 官方签名必然失效。
//
// 结果是 build.mjs 零依赖，只要系统有 node 和 macOS 自带的 ditto/plutil/codesign。

import { createWriteStream } from 'node:fs';
import { cp, mkdir, rm, writeFile, readFile, access, stat, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const STAGE = path.join(__dirname, '.stage');
const CACHE = path.join(__dirname, '.electron-cache');
const DIST = path.join(PROJECT, 'dist');
const APP = path.join(DIST, 'EchoLingo.app');

const ARCH = process.env.ARCH || process.arch;
const ELECTRON_VERSION = process.env.ELECTRON_VERSION || '44.7.0';
const APP_ID = 'com.echolingo.desktop';
const PRODUCT = 'EchoLingo';

// 镜像优先（国内快），失败再回官方 GitHub
const ZIP_URLS = [
  `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip`,
];

// 工具本体在 app/ 下（仓库根目录留给了产品官网首页）。
// 桌面版直接把 app/ 的内容铺成 bundle 的站点根目录，所以窗口打开的是工具本身，
// 不是官网首页 —— 装了 App 的人不该先看一遍介绍页。
const SITE_SRC = path.join(PROJECT, 'app');

// 站点真正需要的东西。bench/（测试脚本）、tools/、desktop/、shots/ 一律不进包。
const SITE_ENTRIES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'vendor',
  'models',
  'dict',
  'media',
];

const human = (b) => (b / 1048576).toFixed(0) + ' MB';

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function pathSize(p) {
  const { stdout } = await run('du', ['-sk', p]);
  return Number(stdout.split(/\s+/)[0]) * 1024;
}

async function appVersion() {
  const src = await readFile(path.join(PROJECT, 'js', 'app.js'), 'utf8');
  const m = src.match(/APP_VER\s*=\s*'([^']+)'/);
  return m ? m[1] : '1.0.0';
}

/** 下载 Electron zip；已缓存就直接用 */
async function ensureZip() {
  await mkdir(CACHE, { recursive: true });
  const zip = path.join(CACHE, `electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip`);
  if (await exists(zip)) {
    console.log(`  Electron zip 已缓存 ${human((await stat(zip)).size)}`);
    return zip;
  }

  const tmp = zip + '.part';
  let lastErr;
  for (const url of ZIP_URLS) {
    try {
      console.log(`  下载 ${url}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      let lastPct = -1;
      const body = Readable.fromWeb(res.body);
      body.on('data', (c) => {
        got += c.length;
        if (!total) return;
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`    ${pct}%\r`); }
      });
      await pipeline(body, createWriteStream(tmp));
      process.stdout.write('    ');
      if (total && got !== total) throw new Error(`大小不符：收到 ${got} / 期望 ${total}`);
      await rename(tmp, zip);
      console.log(`  下载完成 ${human(got)}`);
      return zip;
    } catch (e) {
      lastErr = e;
      console.warn(`  失败：${e.message}，换下一个源`);
      await rm(tmp, { force: true });
    }
  }
  throw new Error(`Electron 下载失败：${lastErr && lastErr.message}`);
}

/** 改 Info.plist：存在就 replace，不存在就 insert */
async function plistSet(plist, key, value) {
  const type = typeof value === 'number' ? 'integer' : 'string';
  try {
    await run('plutil', ['-replace', key, '-' + type, String(value), plist]);
  } catch {
    await run('plutil', ['-insert', key, '-' + type, String(value), plist]);
  }
}

async function main() {
  const version = await appVersion();
  console.log(`打包 ${PRODUCT} ${version}  electron ${ELECTRON_VERSION}  arch ${ARCH}`);

  // 1) 拿 Electron 并解压
  const zip = await ensureZip();
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  console.log('  解压 …');
  await run('ditto', ['-x', '-k', zip, STAGE], { maxBuffer: 1 << 26 });

  const srcApp = path.join(STAGE, 'Electron.app');
  if (!(await exists(srcApp))) throw new Error('解压后找不到 Electron.app');

  // 2) 拷成我们的 app
  await rm(APP, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  console.log('  拷贝 Electron.app → EchoLingo.app');
  await run('ditto', [srcApp, APP], { maxBuffer: 1 << 26 });

  const contents = path.join(APP, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const plist = path.join(contents, 'Info.plist');

  // 3) 改成自己的可执行文件名（Info.plist 里的 CFBundleExecutable 必须与之一致）
  if (await exists(path.join(macos, 'Electron'))) {
    await rename(path.join(macos, 'Electron'), path.join(macos, PRODUCT));
  }

  // 4) Info.plist
  await plistSet(plist, 'CFBundleExecutable', PRODUCT);
  await plistSet(plist, 'CFBundleName', PRODUCT);
  await plistSet(plist, 'CFBundleDisplayName', PRODUCT);
  await plistSet(plist, 'CFBundleIdentifier', APP_ID);
  await plistSet(plist, 'CFBundleShortVersionString', version);
  await plistSet(plist, 'CFBundleVersion', version);
  await plistSet(plist, 'CFBundleIconFile', 'electron.icns');
  await plistSet(plist, 'NSHumanReadableCopyright', `Copyright © ${new Date().getFullYear()} EchoLingo`);

  // 5) 图标：直接覆盖默认的 electron.icns，省得再动 plist 的取值
  const icon = path.join(__dirname, 'icon.icns');
  if (await exists(icon)) {
    await cp(icon, path.join(resources, 'electron.icns'));
  } else {
    console.warn('  没有 icon.icns，用 Electron 默认图标');
  }

  // 默认的欢迎页 app 不再需要；留着反而可能在被误调用时抢戏
  await rm(path.join(resources, 'default_app.asar'), { force: true });

  // 6) 应用本体：Resources/app/{package.json,main.js,site-server.js,site/}
  const appDir = path.join(resources, 'app');
  await mkdir(appDir, { recursive: true });
  for (const f of ['main.js', 'site-server.js']) {
    await cp(path.join(__dirname, f), path.join(appDir, f));
  }
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'echolingo',
    productName: PRODUCT,
    version,
    description: 'EchoLingo 回声英语 — 纯离线英语视频精读',
    main: 'main.js',
    license: 'MIT',
  }, null, 2) + '\n');

  const siteDir = path.join(appDir, 'site');
  await mkdir(siteDir, { recursive: true });
  for (const entry of SITE_ENTRIES) {
    const from = path.join(SITE_SRC, entry);
    if (!(await exists(from))) { console.warn(`  跳过不存在的条目: ${entry}`); continue; }
    await cp(from, path.join(siteDir, entry), { recursive: true });
  }
  console.log(`  站点已就位 ${human(await pathSize(siteDir))}`);

  // 7) ad-hoc 重签名。
  //    往 bundle 里塞了东西，Electron 官方那份签名已经失效；
  //    而 Apple Silicon 上签名无效的 arm64 应用会被系统直接拒绝启动。
  console.log('  重新签名（ad-hoc）…');
  await run('codesign', ['--force', '--deep', '--sign', '-', APP], { maxBuffer: 1 << 26 });
  await run('codesign', ['--verify', '--deep', APP], { maxBuffer: 1 << 26 });
  console.log('  签名校验通过');

  // 清掉解压出来的临时副本，别白占 300MB
  await rm(STAGE, { recursive: true, force: true });

  console.log(`\n完成: ${APP}`);
  console.log(`体积: ${human(await pathSize(APP))}`);
  console.log(`打开: open "${APP}"`);
}

main().catch((e) => {
  console.error('打包失败:', e && e.message || e);
  process.exit(1);
});

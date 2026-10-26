/* EchoLingo 激活码校验 —— 浏览器与 Node 共用的同一份实现。
 *
 * 码的构成（12 字节 → 20 个字符，分组显示 4-4-4-4-4）：
 *   [1 字节 版本=1][3 字节 序列号][8 字节 HMAC-SHA256(密钥, 前 4 字节)]
 *
 * 校验在本机完成，不联网、不上报任何东西；一个码永久有效，
 * 换浏览器/换电脑重新输入同一个码即可。
 */
(function (root) {
  'use strict';

  // 打包密钥：分三段存放，避免明文一眼可见（本地校验必然可逆，这里只提高门槛）
  var K1 = [0x3a, 0x7c, 0x91, 0x2e, 0x55, 0xb8, 0x0d, 0x64];
  var K2 = [0xf1, 0x4a, 0x27, 0x9c, 0x63, 0x0e, 0xbd, 0x58];
  var K3 = [0x72, 0xc9, 0x1f, 0x86, 0x4d, 0xe3, 0x0a, 0x95];
  function keyBytes() {
    return K1.concat(K2, K3);
  }

  // ---- SHA-256（纯 JS，不依赖 crypto.subtle，file:// 下也能用）----
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function ror(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var bitLen = len * 8;
    var withPad = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    withPad.set(bytes);
    withPad[len] = 0x80;
    // 末尾 8 字节写比特长度（这里只用到 < 2^32 的部分，够用）
    var hi = Math.floor(bitLen / 0x100000000);
    withPad[withPad.length - 8] = (hi >>> 24) & 0xff;
    withPad[withPad.length - 7] = (hi >>> 16) & 0xff;
    withPad[withPad.length - 6] = (hi >>> 8) & 0xff;
    withPad[withPad.length - 5] = hi & 0xff;
    withPad[withPad.length - 4] = (bitLen >>> 24) & 0xff;
    withPad[withPad.length - 3] = (bitLen >>> 16) & 0xff;
    withPad[withPad.length - 2] = (bitLen >>> 8) & 0xff;
    withPad[withPad.length - 1] = bitLen & 0xff;

    var W = new Uint32Array(64);
    for (var off = 0; off < withPad.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        var j = off + (i << 2);
        W[i] = (withPad[j] << 24) | (withPad[j + 1] << 16) | (withPad[j + 2] << 8) | withPad[j + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        var s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
        var S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
      out[i * 4 + 3] = H[i] & 0xff;
    }
    return out;
  }

  function hmac(key, msg) {
    var block = 64;
    var k = key.length > block ? sha256(key) : Uint8Array.from(key);
    var ipad = new Uint8Array(block + msg.length);
    var opad = new Uint8Array(block + 32);
    for (var i = 0; i < block; i++) {
      var b = i < k.length ? k[i] : 0;
      ipad[i] = b ^ 0x36;
      opad[i] = b ^ 0x5c;
    }
    ipad.set(msg, block);
    opad.set(sha256(ipad), block);
    return sha256(opad);
  }

  // ---- Crockford base32（去掉 I L O U，避免看错）----
  var ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function b32encode(bytes) {
    var out = '';
    var bits = 0;
    var val = 0;
    for (var i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += ALPHA[(val >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
    return out;
  }

  function b32decode(str) {
    var out = [];
    var bits = 0;
    var val = 0;
    for (var i = 0; i < str.length; i++) {
      var idx = ALPHA.indexOf(str[i]);
      if (idx < 0) return null;
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((val >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Uint8Array.from(out);
  }

  // ---- 归一化 / 校验 ----
  function normalize(code) {
    return String(code || '')
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      // 用户常把 0/O、1/I/L 打错，统一按 Crockford 的规则纠正
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/U/g, 'V');
  }

  function group(code) {
    var s = normalize(code);
    var parts = [];
    for (var i = 0; i < s.length; i += 4) parts.push(s.slice(i, i + 4));
    return parts.join('-');
  }

  var VERSION = 1;

  /** 校验一个码；返回 { ok, serial }，ok 为 false 时 serial 无意义 */
  function check(code) {
    var s = normalize(code);
    if (s.length !== 20) return { ok: false, serial: 0 };
    var raw = b32decode(s);
    if (!raw || raw.length < 12) return { ok: false, serial: 0 };
    // 尾字符里带 4 个填充位：解出来一样但原串不同，一律按无效处理，避免「改最后一位也能过」
    if (b32encode(raw) !== s) return { ok: false, serial: 0 };
    var body = raw.subarray(0, 4);
    var mac = raw.subarray(4, 12);
    if (body[0] !== VERSION) return { ok: false, serial: 0 };
    var want = hmac(Uint8Array.from(keyBytes()), body).subarray(0, 8);
    var diff = 0;
    for (var i = 0; i < 8; i++) diff |= want[i] ^ mac[i];
    var serial = (body[1] << 16) | (body[2] << 8) | body[3];
    return { ok: diff === 0, serial: serial };
  }

  /** 反过来：给序列号造一个码（只有打包密钥持有者能造，工具在 licgen/） */
  function make(serial) {
    var body = Uint8Array.from([VERSION, (serial >>> 16) & 0xff, (serial >>> 8) & 0xff, serial & 0xff]);
    var mac = hmac(Uint8Array.from(keyBytes()), body).subarray(0, 8);
    var all = new Uint8Array(12);
    all.set(body, 0);
    all.set(mac, 4);
    return group(b32encode(all));
  }

  var STORE_KEY = 'echolingo.license.code';

  function readStored() {
    try { return localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; }
  }

  function saveStored(code) {
    try { localStorage.setItem(STORE_KEY, normalize(code)); return true; } catch (e) { return false; }
  }

  var API = {
    check: check,
    make: make,
    group: group,
    normalize: normalize,
    VERSION: VERSION,
    /** 当前是否已激活 */
    state: function () {
      var code = readStored();
      var r = check(code);
      return { active: r.ok, code: r.ok ? group(code) : '', serial: r.serial };
    },
    /** 输入一个码并激活；返回 { ok, reason } */
    activate: function (input) {
      var r = check(input);
      if (!r.ok) return { ok: false, reason: 'invalid' };
      if (!saveStored(input)) return { ok: false, reason: 'storage' };
      return { ok: true, serial: r.serial };
    },
    deactivate: function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    },
  };

  root.ECLicense = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

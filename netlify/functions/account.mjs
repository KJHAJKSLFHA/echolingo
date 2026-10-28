/* 账号与每日配额（Netlify 适配层）。
 *
 * 判定逻辑全在 account-core.mjs，与 server.js 的本地实现共用同一份。
 *
 * 数据布局（store 'acct'）：
 *   u/<id>            → 用户档案（含 PBKDF2 盐与摘要）
 *   e/<emailLower>    → 邮箱到 id 的索引
 *   d/<id>/<dayKey>   → 当日已用秒数
 *   lic:used/<serial> → 激活码核销标记（含绑定的账号 id）
 *
 * 密钥：ECHOLINGO_SECRET 必须由环境变量提供。仓库是公开的，
 * 密钥写进代码等于人人可伪造登录凭据，所以缺变量时直接抛错。
 */
import { getStore } from '@netlify/blobs';
import { handleAccount } from './account-core.mjs';
import LIC from '../../app/js/license.js';

const STORE = 'acct';

function blobsDb() {
  // consistency 必须在**创建 store 时**声明；写在 get/list 的调用参数里不生效，
  // 实测表现就是 list 永远只返回第一条用量键（读缓存）。
  const store = getStore({ name: STORE, consistency: 'strong' });
  return {
    async get(key) {
      try {
        // consistency:'strong' 不能省。默认是最终一致（读缓存），
        // 表现为刚写入的用量读回来还是旧值 —— 之前配额不累加就是它。
        return await store.get(key, { type: 'json', consistency: 'strong' });
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      await store.setJSON(key, value);
      return true;
    },
    async setIfNew(key, value) {
      try {
        const r = await store.setJSON(key, value, { onlyIfNew: true });
        // onlyIfNew 在键已存在时不抛异常，而是返回 { modified: false }。
        // 只按「抛错 = 被占用」判断会静默放行重复写入（以前踩过这个坑）。
        return !!(r && r.modified !== false);
      } catch (e) {
        return false;
      }
    },
    /* 用量改成「只追加」日志。
     *
     * 先前用读-改-写（读旧值 → 加 → 写回）在线上大幅漏计：16 次上报只记到 2400 秒。
     * 原因是 Blobs 跨实例读后写不保证一致，读到的常常是旧副本，增量被互相覆盖。
     *
     * 现在每次上报写一个**独立键**，键名第二段就是本次秒数：
     *   d/<id>/<day>/<sec>-<rand>
     * 统计时只 list 前缀、从键名求和，既不读值也不覆盖，
     * 因此永远不会互相覆盖；极端情况下只是暂时少算，稍后重新 list 即可补齐。 */
    async addUsage(prefix, sec) {
      const n = Math.max(0, Math.floor(Number(sec) || 0));
      if (!n) return;
      const rand = Math.random().toString(36).slice(2, 8);
      const key = `${prefix}${n}-${rand}`;
      await store.setJSON(key, { sec: n });
      return key;
    },
    async listKeys(prefix) {
      const keys = [];
      try {
        const it = store.list({ prefix, paginate: true, consistency: 'strong' });
        for await (const page of it) {
          const blobs = Array.isArray(page) ? page : (page && page.blobs) || [];
          for (const b of blobs) keys.push(String(b.key || ''));
        }
      } catch (e) {
        keys.push('ERR:' + (e && e.message));
      }
      return keys;
    },
    async sumUsage(prefix) {
      let total = 0;
      let pages = 0;
      const it = store.list({ prefix, paginate: true, consistency: 'strong' });
      for await (const page of it) {
        const blobs = Array.isArray(page) ? page : (page && page.blobs) || [];
        for (const b of blobs) {
          // 键名前缀之后是「秒数-随机串」，直接从键名取秒数，省掉逐条读取
          const tail = String(b.key || '').slice(prefix.length);
          const n = Math.floor(Number(tail.split('-')[0]) || 0);
          if (n > 0) total += n;
        }
        if (++pages > 200) break; // 安全阀：单日 2 小时最多几百条
      }
      return total;
    },
  };
}

export default async (req) => {
  let body = null;
  if (String(req.method).toUpperCase() === 'POST') {
    try {
      body = await req.json();
    } catch (e) {
      body = null;
    }
  }
  return handleAccount(
    { method: req.method, body },
    blobsDb(),
    { secret: process.env.ECHOLINGO_SECRET || '', verifyCode: LIC.check },
  );
};

export const config = { path: '/api/account' };

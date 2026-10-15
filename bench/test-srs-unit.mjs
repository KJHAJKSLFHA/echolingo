// SRS 排期单元测试（纯逻辑，不开浏览器）
//   node bench/test-srs-unit.mjs
// 这几条是复习功能的「心脏」：间隔阶梯、升降档、lapse、到期判定、老记录迁移。
import {
  STEPS, GROWTH, MAX_INTERVAL, LAPSE_BOX, intervalFor,
  ensureSrs, grade, isDue, dueList, humanDue, buildQueue, nextDueAt,
} from '../app/js/srs.js';

let pass = 0, fail = 0;
const DAY = 864e5, MIN = 6e4, HOUR = 36e5;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, got, want) =>
  check(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);

console.log('=== 1. 间隔阶梯 ===');
eq('第 0 档 = 20 分钟', STEPS[0], 20 * MIN);
eq('第 1 档 = 1 天', STEPS[1], 1 * DAY);
eq('第 2 档 = 3 天', STEPS[2], 3 * DAY);
eq('第 3 档 = 7 天', STEPS[3], 7 * DAY);
eq('第 4 档 = 16 天', STEPS[4], 16 * DAY);
eq('第 5 档 = 35 天', STEPS[5], 35 * DAY);
check('阶梯严格递增', STEPS.every((v, i) => i === 0 || v > STEPS[i - 1]));
eq('intervalFor(0)', intervalFor(0), 20 * MIN);
eq('intervalFor(1)', intervalFor(1), 1 * DAY);
eq('intervalFor(5)', intervalFor(5), 35 * DAY);
eq('intervalFor(6) ≈ 35×2.2 天', intervalFor(6), Math.min(35 * DAY * GROWTH, MAX_INTERVAL));
check('intervalFor(6) 比第 5 档长', intervalFor(6) > intervalFor(5));
check('间隔单调不减到最后', (() => {
  let prev = 0;
  for (let b = 0; b <= 30; b++) { const v = intervalFor(b); if (v < prev) return false; prev = v; }
  return true;
})());
check('封顶在 MAX_INTERVAL（半年）', intervalFor(100) === MAX_INTERVAL);
eq('负数当第 0 档', intervalFor(-5), 20 * MIN);
eq('小数被向下取整', intervalFor(1.9), 1 * DAY);
eq('undefined 当第 0 档', intervalFor(undefined), 20 * MIN);
eq('答错档位常量 = 1（1 天）', LAPSE_BOX, 1);

console.log('\n=== 2. 老记录迁移（ensureSrs）===');
const now0 = Date.now();
const legacy = { id: 'old', word: 'legacy', addedAt: 1700000000000 };
const mig = ensureSrs(legacy, now0);
eq('补出 box=0', mig.box, 0);
eq('补出 reps=0', mig.reps, 0);
eq('补出 lapses=0', mig.lapses, 0);
eq('老记录 dueAt = now（当成马上要复习）', mig.dueAt, now0);
check('老字段原样保留', mig.word === 'legacy' && mig.addedAt === 1700000000000);
const mig2 = ensureSrs(mig, now0 + 999);
check('重复迁移是幂等的（不覆盖已有 dueAt）', mig2.dueAt === mig.dueAt && mig2.box === 0);
check('undefined 输入也能活', ensureSrs(undefined, now0).box === 0);
eq('空对象补出 dueAt', ensureSrs({}, now0).dueAt, now0);
const weird = ensureSrs({ box: -3, reps: -1, lapses: -9 }, now0);
check('负数被纠正', weird.box === 0 && weird.reps === 0 && weird.lapses === 0);
check('非数字 box 被纠正', ensureSrs({ box: 'x' }, now0).box === 0);

console.log('\n=== 3. 到期判定 ===');
check('dueAt 在过去 → 到期', isDue({ dueAt: now0 - 1000 }, now0) === true);
check('dueAt 是现在 → 到期', isDue({ dueAt: now0 }, now0) === true);
check('dueAt 在未来 → 没到期', isDue({ dueAt: now0 + DAY }, now0) === false);
check('无 dueAt 的老记录 → 当成到期', isDue({ id: 'x' }, now0) === true);

console.log('\n=== 4. 答对：升档、间隔变长 ===');
let r = ensureSrs({}, now0);
eq('初始 box', r.box, 0);
r = grade(r, true, now0);
eq('答对一次 box=1', r.box, 1);
eq('reps=1', r.reps, 1);
eq('lapses 不变', r.lapses, 0);
eq('dueAt = now + 1 天', r.dueAt, now0 + DAY);
eq('lastAt 记下', r.lastAt, now0);
r = grade(r, true, now0);
eq('再答对 box=2', r.box, 2);
eq('间隔到 3 天', r.dueAt, now0 + 3 * DAY);

let rr = ensureSrs({}, now0);
let prev = 0, mono = true;
for (let i = 1; i <= 6; i++) {
  rr = grade(rr, true, now0);
  const gap = rr.dueAt - now0;
  if (gap <= prev) mono = false;
  prev = gap;
}
check('连续答对间隔单调变长', mono, `末次间隔 ${prev / DAY} 天`);
check('reps 累加到 6', rr.reps === 6, `实际 ${rr.reps}`);
check('box 越过阶梯后不报错', rr.box === 6);

let far = ensureSrs({}, now0);
for (let i = 0; i < 40; i++) far = grade(far, true, now0);
check('40 次后 dueAt 是有限数', Number.isFinite(far.dueAt));
check('40 次后间隔仍封顶在半年内', (far.dueAt - now0) <= MAX_INTERVAL);

console.log('\n=== 5. 答错：打回第 1 档、lapse +1、reps 归零 ===');
let b = ensureSrs({}, now0);
b = grade(b, true, now0); b = grade(b, true, now0); b = grade(b, true, now0);
eq('先升到 box=3', b.box, 3);
const okDue = b.dueAt;
const okReps = b.reps;
b = grade(b, false, now0);
eq('答错回到第 1 档（box=1）', b.box, LAPSE_BOX);
eq('lapses=1', b.lapses, 1);
eq('reps 归零（连续答对断掉了）', b.reps, 0);
eq('dueAt = now + 1 天', b.dueAt, now0 + DAY);
check('间隔从 7 天缩回 1 天', b.dueAt < okDue, `之前 ${(okDue - now0) / DAY} 天`);
check('reps 确实被清零过', okReps === 3 && b.reps === 0);

console.log('\n=== 6. 答错后重新爬 ===');
let c = ensureSrs({}, now0);
c = grade(c, true, now0); c = grade(c, true, now0); c = grade(c, false, now0);
eq('答错后 box=1', c.box, 1);
eq('累计 lapse = 1', c.lapses, 1);
c = grade(c, true, now0);
eq('再答对 box=2', c.box, 2);
eq('累计 lapse 仍为 1', c.lapses, 1);

console.log('\n=== 7. dueList / buildQueue ===');
const mk = (dueAt) => ({ dueAt });
const pool = [mk(now0 - DAY), mk(now0 - 1000), mk(now0 + DAY), mk(now0 + 3 * DAY)];
eq('dueList 挑出 2 条', dueList(pool, now0).length, 2);
const q = buildQueue(pool, now0);
eq('buildQueue 也是 2 条', q.length, 2);
check('buildQueue 按到期时间升序（早到期的先考）', q[0].dueAt <= q[1].dueAt);
eq('buildQueue 里最早的是 now-DAY', q[0].dueAt, now0 - DAY);
eq('空数组 dueList=0', dueList([], now0).length, 0);
eq('buildQueue 把老记录也算进队列', buildQueue([{ id: 'x' }], now0).length, 1);

console.log('\n=== 8. nextDueAt（只看未来，用于「下一轮何时」）===');
eq('取未来最近的一个', nextDueAt([mk(now0 + 3 * DAY), mk(now0 + DAY)], now0), now0 + DAY);
eq('全是过期 → null', nextDueAt([mk(now0 - DAY), mk(now0 - 1000)], now0), null);
eq('空数组 → null', nextDueAt([], now0), null);
check('无 dueAt 的老记录被跳过（它已到期，不算「下一轮」）', nextDueAt([{ id: 'x' }], now0) === null);
eq('恰好等于 now 的不算未来', nextDueAt([mk(now0)], now0), null);

console.log('\n=== 9. humanDue 文案 key ===');
eq('已过期 → now', humanDue(now0 - 1, now0), 'now');
eq('2 小时后 → today', humanDue(now0 + 2 * HOUR, now0), 'today');
eq('10 小时后 → today', humanDue(now0 + 10 * HOUR, now0), 'today');
eq('3 天后 → days:3', humanDue(now0 + 3 * DAY, now0), 'days:3');
eq('1 天后 → days:1', humanDue(now0 + DAY, now0), 'days:1');

console.log('\n=== 10. grade 不修改入参（纯函数）===');
const orig = ensureSrs({ word: 'keep' }, now0);
const snapshot = JSON.stringify(orig);
const out = grade(orig, true, now0);
eq('原对象没被改', JSON.stringify(orig), snapshot);
check('返回的是新对象', out !== orig);

console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) process.exitCode = 1;

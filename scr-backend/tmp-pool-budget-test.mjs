// 临时单测：computePoolLimits 纯函数用例（多实例连接预算）
import { computePoolLimits } from './src/config/poolBudget.js';

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✅ ${name}: ${a}`); }
  else { fail++; console.log(`  ❌ ${name}: 期望 ${e}，实际 ${a}`); }
}

const base = { maxConnections: 500, reserve: 50, workerCount: 1 };

console.log('用例1: N=1（单实例，维持现状 150+8）');
assertEq('N=1 main', computePoolLimits({ ...base, instances: 1 }).mainPoolLimit, 150);
assertEq('N=1 worker', computePoolLimits({ ...base, instances: 1 }).workerPoolLimit, 8);
assertEq('N=1 clamped', [computePoolLimits({ ...base, instances: 1 }).clampedMain, computePoolLimits({ ...base, instances: 1 }).clampedWorker], [false, false]);

console.log('用例2: N=2（每实例预算 floor(450/2)=225 → worker=min(8,⌊8·225/158⌋)=8, main=217）');
const n2 = computePoolLimits({ ...base, instances: 2 });
assertEq('N=2 main', n2.mainPoolLimit, 217);
assertEq('N=2 worker', n2.workerPoolLimit, 8);
assertEq('N=2 perInstance', n2.perInstanceBudget, 225);
assertEq('N=2 总占用≤预算', (n2.mainPoolLimit + n2.workerPoolLimit) * 2 <= 450, true);

console.log('用例3: N=3（每实例预算 150 → worker=⌊8·150/158⌋=7, main=143）');
const n3 = computePoolLimits({ ...base, instances: 3 });
assertEq('N=3 main', n3.mainPoolLimit, 143);
assertEq('N=3 worker', n3.workerPoolLimit, 7);
assertEq('N=3 总占用≤预算', (n3.mainPoolLimit + n3.workerPoolLimit) * 3 <= 450, true);

console.log('用例4: N=10（每实例预算 45 → worker=⌊8·45/158⌋=2, main=43）');
const n10 = computePoolLimits({ ...base, instances: 10 });
assertEq('N=10 main', n10.mainPoolLimit, 43);
assertEq('N=10 worker', n10.workerPoolLimit, 2);

console.log('用例5: 显式 env clamp（N=3，用户设 DB_CONNECTION_LIMIT=150 → clamp 到 143 并告警）');
const c3 = computePoolLimits({ ...base, instances: 3, userMainLimit: 150 });
assertEq('clamp main', c3.mainPoolLimit, 143);
assertEq('clamp flag', c3.clampedMain, true);
const cw = computePoolLimits({ ...base, instances: 3, userWorkerLimit: 8 });
assertEq('clamp worker 值', cw.workerPoolLimit, 7);
assertEq('clamp worker flag', cw.clampedWorker, true);

console.log('用例6: 显式 env 未超预算时尊重（N=3，用户设主池 100 → 生效 100，不 clamp）');
const ok3 = computePoolLimits({ ...base, instances: 3, userMainLimit: 100 });
assertEq('尊重 main', ok3.mainPoolLimit, 100);
assertEq('不 clamp', ok3.clampedMain, false);

console.log('用例7: worker线程=2（N=3，每实例预算 150 → workerTotal=min(16,⌊16·150/166⌋)=14 → 每线程7, main=136）');
const w2 = computePoolLimits({ ...base, instances: 3, workerCount: 2 });
assertEq('worker线程2 每线程池', w2.workerPoolLimit, 7);
assertEq('worker线程2 main', w2.mainPoolLimit, 136);

console.log('用例8: 极小预算（maxConn=100, reserve=50, N=3 → 每实例 16，触发下限：main=20, worker=2, overBudget）');
const tiny = computePoolLimits({ maxConnections: 100, reserve: 50, instances: 3 });
assertEq('tiny main', tiny.mainPoolLimit, 20);
assertEq('tiny worker', tiny.workerPoolLimit, 2);
assertEq('tiny overBudget', tiny.overBudget, true);

console.log('用例9: N=1 且用户显式配置完全尊重（DB_CONNECTION_LIMIT=300, WORKER=16）');
const u1 = computePoolLimits({ ...base, instances: 1, userMainLimit: 300, userWorkerLimit: 16 });
assertEq('N=1 尊重 main', u1.mainPoolLimit, 300);
assertEq('N=1 尊重 worker', u1.workerPoolLimit, 16);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

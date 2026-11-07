// SPDX-License-Identifier: MIT
// 多实例 MySQL 连接数预算（自适应池限额）
//
// 背景：主池默认 connectionLimit=150 + 每个消息 worker 线程自己的池 8 条。
// 多实例部署时 N×(150+8) 很容易逼近 MySQL max_connections（默认 500），
// 运维工具一连就可能打满。本模块在启动时：
//   1) 把本实例注册进 Redis 实例集合（scr:instances hash，心跳续期，崩溃自动过期出列）；
//   2) 探测 MySQL max_connections（可用 DB_MAX_CONNECTIONS 覆盖，0=自动探测，探测失败退回 500）；
//   3) 按「可用预算 = max_connections - DB_CONN_RESERVE」均摊到每个存活实例，
//      算出主池 / worker 池的生效限额（纯函数 computePoolLimits，可单测）。
//
// 取舍（重要）：mysql2 连接池创建后 connectionLimit 不可热改，池限额只在**启动时算准**。
// 心跳 tick 只负责存活登记与超预算告警——若运行中发现实例数比启动时多且可能超预算，
// 打 warning 提醒运维（扩容需要滚动重启各实例才能重新分配预算）。

import os from 'os';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { dbConfig, getRedisUrl } from './index.js';

// 实例注册表：Redis hash，field=实例id(hostname:pid)，value=最近心跳 ISO 时间戳。
// hash 本身无 TTL，过期出列由心跳方按时间戳清理（超过 HEARTBEAT_TTL 视为已死并 HDEL）。
export const INSTANCE_REGISTRY_KEY = 'scr:instances';

const HEARTBEAT_INTERVAL_MS = 20 * 1000;  // 心跳间隔
const HEARTBEAT_TTL_MS = 60 * 1000;       // 心跳失效阈值：超过即视为实例已退出/崩溃

const FALLBACK_MAX_CONNECTIONS = 500;     // 探测失败时的退回值（MySQL 默认）
const DEFAULT_MAIN_LIMIT = 150;           // 与 config/index.js 的默认值保持一致
const DEFAULT_WORKER_LIMIT = 8;           // 与 messageWorker.js 的默认值保持一致
const MIN_MAIN_LIMIT = 20;                // 主池下限：防饿死
const MIN_WORKER_LIMIT = 2;               // worker 池下限：防饿死

export function getInstanceId() {
  return `${os.hostname()}:${process.pid}`;
}

// ============================================
// 纯函数：容量分配（无 IO，可单测）
// ============================================
// 输入：探测到的 maxConnections / 预留余量 / 存活实例数 / worker 线程数 /
//       用户显式配置（未设置传 null）/ 默认值与下限。
// 输出：主池与 worker 池（每个 worker 线程）的生效限额及决策细节。
export function computePoolLimits({
  maxConnections,
  reserve,
  instances,
  workerCount = 1,
  userMainLimit = null,
  userWorkerLimit = null,
  defaultMainLimit = DEFAULT_MAIN_LIMIT,
  defaultWorkerLimit = DEFAULT_WORKER_LIMIT,
  minMainLimit = MIN_MAIN_LIMIT,
  minWorkerLimit = MIN_WORKER_LIMIT
}) {
  const budget = maxConnections - reserve;   // 全集群可用连接预算
  const n = Math.max(1, instances);
  // 单实例时的期望值（完全尊重用户显式配置）
  const desiredMain = userMainLimit ?? defaultMainLimit;
  const desiredWorker = userWorkerLimit ?? defaultWorkerLimit;
  // 每实例默认连接占用（worker 部分 = 线程数 × 每 worker 池上限）
  const defaultWorkerTotal = workerCount * defaultWorkerLimit;
  const desiredWorkerTotal = workerCount * desiredWorker;

  if (n === 1) {
    return {
      instanceCount: 1,
      totalBudget: budget,
      perInstanceBudget: budget,
      mainPoolLimit: desiredMain,
      workerPoolLimit: desiredWorker,
      clampedMain: false,
      clampedWorker: false,
      overBudget: defaultMainLimit + defaultWorkerTotal > budget
    };
  }

  // 多实例：每实例预算 = floor(可用预算 / N)
  const perInstance = Math.max(0, Math.floor(budget / n));

  // worker 部分：按默认配比等比例缩放，且不超过期望值，不低于下限
  const denom = defaultMainLimit + defaultWorkerTotal;
  let workerTotal = Math.min(desiredWorkerTotal, Math.floor((defaultWorkerTotal * perInstance) / denom));
  workerTotal = Math.max(workerCount * minWorkerLimit, workerTotal);

  let main = perInstance - workerTotal;
  if (main < minMainLimit) {
    // 主池触底：保住主池下限，worker 压到下限
    main = minMainLimit;
    workerTotal = Math.max(workerCount * minWorkerLimit, perInstance - main);
  }
  const workerPoolLimit = Math.max(minWorkerLimit, Math.floor(workerTotal / workerCount));

  // 防呆：用户显式配置超出本实例预算时 clamp 到预算内（日志说明原值与生效值）；
  // 未超预算的显式配置则完全尊重（低于均摊值时等于让出预算，无害）
  const clampedMain = userMainLimit != null && userMainLimit > main;
  const clampedWorker = userWorkerLimit != null && userWorkerLimit > workerPoolLimit;
  const finalMain = clampedMain ? main : userMainLimit ?? main;
  const finalWorker = clampedWorker ? workerPoolLimit : userWorkerLimit ?? workerPoolLimit;

  return {
    instanceCount: n,
    totalBudget: budget,
    perInstanceBudget: perInstance,
    mainPoolLimit: finalMain,
    workerPoolLimit: finalWorker,
    clampedMain,
    clampedWorker,
    overBudget: finalMain + finalWorker * workerCount > perInstance
  };
}

// ============================================
// 实例注册表操作（传入已连接的 redis 客户端）
// ============================================
export async function registerInstance(redis) {
  await redis.hSet(INSTANCE_REGISTRY_KEY, getInstanceId(), new Date().toISOString());
}

export async function deregisterInstance(redis) {
  try {
    await redis.hDel(INSTANCE_REGISTRY_KEY, getInstanceId());
  } catch (err) {
    console.warn(`⚠️ 实例注销失败（不影响退出）: ${err.message}`);
  }
}

// 统计存活实例数：顺带清理超过 TTL 的陈旧条目（崩溃实例自动出列）
export async function countAliveInstances(redis) {
  const entries = await redis.hGetAll(INSTANCE_REGISTRY_KEY);
  const now = Date.now();
  const stale = [];
  let alive = 0;
  for (const [id, ts] of Object.entries(entries)) {
    const t = Date.parse(ts);
    if (Number.isNaN(t) || now - t > HEARTBEAT_TTL_MS) {
      stale.push(id);
    } else {
      alive++;
    }
  }
  if (stale.length > 0) {
    await redis.hDel(INSTANCE_REGISTRY_KEY, stale);
  }
  return alive;
}

// ============================================
// 探测与决策（带 memoization，database.js / messageWorkerClient.js 共用一次）
// ============================================
let memo = null;

export function resolveDbLimits() {
  if (!memo) memo = doResolveDbLimits();
  return memo;
}

async function doResolveDbLimits() {
  const envMax = parseInt(process.env.DB_MAX_CONNECTIONS, 10);
  const useEnvMax = Number.isFinite(envMax) && envMax > 0;
  const reserve = (() => {
    const raw = parseInt(process.env.DB_CONN_RESERVE, 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 50;
  })();

  // 探测 max_connections：用一次性短连接（不占池预算），失败退回默认值
  let maxConnections = useEnvMax ? envMax : FALLBACK_MAX_CONNECTIONS;
  let probeOk = useEnvMax;
  if (!useEnvMax) {
    let probe;
    try {
      probe = await mysql.createConnection({
        host: dbConfig.host,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        connectTimeout: 3000
      });
      const [rows] = await probe.query("SHOW VARIABLES LIKE 'max_connections'");
      const val = parseInt(rows?.[0]?.Value, 10);
      if (Number.isFinite(val) && val > 0) {
        maxConnections = val;
        probeOk = true;
      }
    } catch {
      // 探测失败退回 500
    } finally {
      if (probe) await probe.end().catch(() => {});
    }
  }

  // 实例注册与存活计数：用一次性 Redis 连接（主线程池此时可能尚未就绪）
  let instanceCount = 1;
  let redisOk = false;
  let tempRedis = null;
  try {
    tempRedis = createClient({ url: getRedisUrl() });
    tempRedis.on('error', () => {});
    await Promise.race([
      tempRedis.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 3000))
    ]);
    await registerInstance(tempRedis);
    instanceCount = Math.max(1, await countAliveInstances(tempRedis));
    redisOk = true;
  } catch (err) {
    // Redis 不可用时退化为单实例行为（维持现状默认大池），与 cron 锁的退化风格一致
    console.warn(`⚠️ 实例注册失败（Redis 不可用?），按单实例分配连接预算: ${err.message}`);
  } finally {
    if (tempRedis) await tempRedis.quit().catch(() => {});
  }

  const workerCount = Math.max(1, parseInt(process.env.MESSAGE_WORKER_POOL_SIZE, 10) || 1);
  const userMainLimit = parseInt(process.env.DB_CONNECTION_LIMIT, 10);
  const userWorkerLimit = parseInt(process.env.WORKER_DB_CONNECTION_LIMIT, 10);

  const limits = computePoolLimits({
    maxConnections,
    reserve,
    instances: instanceCount,
    workerCount,
    userMainLimit: Number.isFinite(userMainLimit) && userMainLimit > 0 ? userMainLimit : null,
    userWorkerLimit: Number.isFinite(userWorkerLimit) && userWorkerLimit > 0 ? userWorkerLimit : null
  });

  // 决策日志：一行说清探测值 / 实例数 / 生效值 / 是否 clamp
  console.log(
    `📊 连接预算决策: max_connections=${maxConnections}${useEnvMax ? '(env)' : probeOk ? '(探测)' : '(探测失败,退回默认)'}`
    + ` reserve=${reserve} 实例数=${limits.instanceCount}${redisOk ? '' : '(注册失败,按1算)'}`
    + ` worker线程=${workerCount} → 主池=${limits.mainPoolLimit} worker池=${limits.workerPoolLimit}/线程`
    + ` (每实例预算=${limits.perInstanceBudget})`
  );
  if (limits.clampedMain) {
    console.warn(`⚠️ DB_CONNECTION_LIMIT=${userMainLimit} 超出多实例预算，已 clamp 到 ${limits.mainPoolLimit}`);
  }
  if (limits.clampedWorker) {
    console.warn(`⚠️ WORKER_DB_CONNECTION_LIMIT=${userWorkerLimit} 超出多实例预算，已 clamp 到 ${limits.workerPoolLimit}`);
  }
  if (limits.overBudget) {
    console.warn(`⚠️ 实例数=${limits.instanceCount} 时预算不足，已按最低下限（主池 ${MIN_MAIN_LIMIT}/worker ${MIN_WORKER_LIMIT}）分配，请调大 max_connections 或调小 DB_CONN_RESERVE`);
  }

  return { ...limits, maxConnections, reserve };
}

// ============================================
// 心跳：注册表续期 + 超预算告警（由 index.js 用主 Redis 池启动）
// ============================================
// 返回 { stop() }。池限额不热改（mysql2 池建后不易缩），心跳只做存活维护：
// 发现实例数比启动时多且可能超预算时打 warning 提醒运维（扩容需滚动重启）。
export function startInstanceHeartbeat(redis, startupLimits) {
  const warned = new Set();

  async function tick() {
    try {
      await registerInstance(redis);
      const alive = await countAliveInstances(redis);
      if (alive > startupLimits.instanceCount) {
        const projected = alive * (startupLimits.mainPoolLimit
          + Math.max(1, parseInt(process.env.MESSAGE_WORKER_POOL_SIZE, 10) || 1) * startupLimits.workerPoolLimit);
        if (projected > startupLimits.maxConnections - startupLimits.reserve && !warned.has(alive)) {
          warned.add(alive);
          console.warn(`⚠️ 存活实例数已从 ${startupLimits.instanceCount} 增至 ${alive}，按当前池限额预计总连接 ${projected} 可能超过预算 ${startupLimits.maxConnections - startupLimits.reserve}，请滚动重启各实例以重新分配连接预算`);
        }
      }
    } catch (err) {
      // Redis 抖动不终止心跳，下一轮自动恢复
      console.warn(`⚠️ 实例心跳失败（下轮重试）: ${err.message}`);
    }
  }

  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  if (timer.unref) timer.unref();
  tick();
  return { stop: () => clearInterval(timer) };
}

// SPDX-License-Identifier: MIT
// 消息拉取 Worker 客户端（主线程）
// 维护一个 Worker 池，向 messageWorker 分发消息拉取任务并收集结果，带超时兜底。
//
// 两种运行模式：
// 1) esbuild 打包（app.js）：workerStringPlugin 拦截下方对 workerSource.js 的导入，
//    返回内联的 messageWorker 源码字符串，运行时 new Worker(source, { eval: true })
//    直接创建（mysql2/redis 外联，从 node_modules require）。
// 2) 源码模式（node src/index.js）：导入 workerSource.js 得到 null，改为直接从
//    src/workers/messageWorker.js 文件创建 Worker。
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { dbConfig, getRedisUrl, messageConfig } from '../config/index.js';
import bundledWorkerSource from './workerSource.js';

// eval worker 内的 require('mysql2'/'redis') 依赖 filename 来定位 node_modules，
// 这里指向 app.js 自身（与 node_modules 同目录），保证运行时能解析外部依赖。
const WORKER_FILENAME = fileURLToPath(import.meta.url);

// 源码模式下的 Worker 文件路径
function getWorkerPath() {
  return path.join(process.cwd(), 'src', 'workers', 'messageWorker.js');
}

const POOL_SIZE = 2;
// 连接健康探测必须在 50ms 内完成；45ms 未收到 ready 就立即熔断。
const CONNECTION_PROBE_TIMEOUT_MS = 45;
// 探测通过后，业务查询仍沿用独立的总任务超时。
const TASK_TIMEOUT_MS = 30000;

const workerData = {
  dbConfig: {
    host: dbConfig.host,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database
  },
  redisUrl: getRedisUrl(),
  offlineLimits: messageConfig.offlineLimits
};

let nextId = 1;
const pending = new Map();

function rejectWorkerPending(worker, error) {
  for (const [id, pendingTask] of pending) {
    if (pendingTask.worker === worker) {
      pending.delete(id);
      clearTimeout(pendingTask.probeTimer);
      clearTimeout(pendingTask.taskTimer);
      pendingTask.reject(error);
    }
  }
}

// 按 worker 引用替换：事件回调/定时器捕获的槽位可能已被其他故障抢先替换，
// 按 index 取 workers[index] 会误杀健康的替代实例；按引用定位则天然幂等。
function replaceWorker(oldWorker, reason) {
  if (!oldWorker || oldWorker.replacing) return;
  oldWorker.replacing = true;
  const index = workers.indexOf(oldWorker);
  // 引用仍在池中才补位；找不到说明槽位已被抢先替换，仅清理引用本身。
  if (index !== -1) {
    workers[index] = createWorker(index);
  }
  rejectWorkerPending(oldWorker, new Error(reason));
  oldWorker.terminate().catch(() => {});
}

function createWorker(index) {
  // 打包产物（app.js）：bundledWorkerSource 为内联的源码字符串，用 eval worker 创建，
  // 内部外联 mysql2/redis，运行时从 node_modules 解析；传入 filename 使 require 可解析。
  const worker = bundledWorkerSource
    ? new Worker(bundledWorkerSource, { eval: true, filename: WORKER_FILENAME, workerData })
    // 源码模式（node src/index.js）：直接从 messageWorker.js 文件创建
    : new Worker(getWorkerPath(), { workerData });
  worker.on('message', (msg) => {
    if (msg.workerReady) {
      worker.available = true;
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.ready) {
      clearTimeout(p.probeTimer);
      p.ready = true;
      return;
    }
    pending.delete(msg.id);
    clearTimeout(p.probeTimer);
    clearTimeout(p.taskTimer);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      const error = new Error(msg.error?.message || '消息拉取任务失败');
      // 探测阶段失败或业务查询发生连接级错误时，当前 worker 的连接池均不可信。
      if (!p.ready || msg.connectionError) {
        replaceWorker(worker, `MySQL 连接异常: ${error.message}`);
      }
      p.reject(error);
    }
  });
  worker.on('error', (err) => {
    console.error('❌ 消息拉取 Worker 错误:', err.message);
    replaceWorker(worker, `Worker 错误: ${err.message}`);
  });
  worker.on('exit', (code) => {
    // 任何退出（含 code 0）都必须补位，否则该槽位永久失效；
    // replace 路径的退出由 replacing 标记去重。
    if (!worker.replacing) {
      console.error('❌ 消息拉取 Worker 退出, code =', code);
      replaceWorker(worker, `Worker 退出: ${code}`);
    }
  });
  return worker;
}

// 固定大小 Worker 池，轮询分发（Worker 内部按消息队列串行处理）
const workers = Array.from({ length: POOL_SIZE }, (_, index) => createWorker(index));
let rr = 0;

function getAvailableWorker() {
  for (let offset = 0; offset < workers.length; offset++) {
    const index = (rr++ % workers.length + workers.length) % workers.length;
    const worker = workers[index];
    if (worker?.available) return { index, worker };
  }
  return null;
}

export function runMessageTask(type, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const target = getAvailableWorker();
    if (!target) {
      reject(new Error('消息 Worker 正在预热或重建'));
      return;
    }
    const { worker } = target;
    const pendingTask = { resolve, reject, worker, ready: false, probeTimer: null, taskTimer: null };
    pending.set(id, pendingTask);
    pendingTask.probeTimer = setTimeout(() => {
      if (!pending.has(id) || pendingTask.ready) return;
      pending.delete(id);
      clearTimeout(pendingTask.taskTimer);
      replaceWorker(pendingTask.worker, 'MySQL 连接健康探测超过 45ms');
      reject(new Error('消息 Worker 连接健康探测超时'));
    }, CONNECTION_PROBE_TIMEOUT_MS);
    pendingTask.taskTimer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(pendingTask.probeTimer);
      replaceWorker(pendingTask.worker, '消息拉取任务执行超时');
      reject(new Error('消息拉取任务执行超时'));
    }, TASK_TIMEOUT_MS);
    if (pendingTask.probeTimer.unref) pendingTask.probeTimer.unref();
    if (pendingTask.taskTimer.unref) pendingTask.taskTimer.unref();
    try {
      worker.postMessage({ id, type, ...params });
    } catch (err) {
      pending.delete(id);
      clearTimeout(pendingTask.probeTimer);
      clearTimeout(pendingTask.taskTimer);
      replaceWorker(pendingTask.worker, `Worker 投递失败: ${err.message}`);
      reject(err);
    }
  });
}

import mysql from 'mysql2/promise';
import { createClientPool } from 'redis';
import { dbConfig, getRedisUrl } from '../config/index.js';

// Redis 连接池：原先为单连接客户端，高并发（压测）时所有命令在单条 TCP 连接上排队，
// 出现"挤爆队列"（客户端队列堆积 → 命令超时/丢弃）。
// node-redis v5 原生支持 createClientPool，命令 API 与单连接完全一致（含 multi/exec）。
const REDIS_POOL_MIN = parseInt(process.env.REDIS_POOL_MIN || '4', 10);    // 常驻最小连接数
const REDIS_POOL_MAX = parseInt(process.env.REDIS_POOL_MAX || '32', 10);   // 高峰自动扩容上限
// 从池中获取连接的排队超时，超时抛 TimeoutError（外层还有 10s 命令超时兜底）
const REDIS_POOL_ACQUIRE_TIMEOUT = parseInt(process.env.REDIS_POOL_ACQUIRE_TIMEOUT || '5000', 10);

const redisClient = createClientPool(
  { url: getRedisUrl() },
  {
    minimum: REDIS_POOL_MIN,
    maximum: REDIS_POOL_MAX,
    acquireTimeout: REDIS_POOL_ACQUIRE_TIMEOUT,
    cleanupDelay: 3000 // 空闲连接延迟回收
  }
);

redisClient.on('error', (err) => {
  console.error('❌ Redis 连接池错误:', err.message);
});

let isRedisConnected = false;

(async () => {
  try {
    await redisClient.connect();
    isRedisConnected = true;
  } catch (err) {
    console.error('❌ Redis 连接池初始化失败:', err.message);
    isRedisConnected = false;
  }
})();

// Redis 命令超时兜底：防止命令挂起时 Promise 永不 settle（泄漏）
// 压测反馈：3s 太激进，Redis 高峰排队时会把"Redis 忙"误判为业务失败，放宽到 10s
const REDIS_COMMAND_TIMEOUT_MS = 10000;

export class RedisUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

function withRedisTimeout(operation) {
  // 注意：必须用 new Promise 手动 clearTimeout，而不是 Promise.race + unref。
  // Promise.race 在 operation 先 resolve 后仍会保留那个 10s 定时器直到其触发，
  // 高并发下会同时滞留「命令速率 × 10s」个 Timer 对象与闭包（GC 压力/内存高水位）。
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Redis 命令执行超时'));
    }, REDIS_COMMAND_TIMEOUT_MS);
    // 让定时器在进程退出前不阻塞
    if (timer.unref) timer.unref();
    Promise.resolve()
      .then(() => operation(redisClient))
      .then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); }
      );
  });
}

// options.strict: true 时，Redis 不可用/超时不再返回 fallbackValue，
// 而是抛出 RedisUnavailableError，由调用方决定语义（如 HTTP 返回 503 而非误判 401）
async function safeRedisExecute(operation, fallbackValue = null, options = {}) {
  const { strict = false } = options;

  if (!isRedisConnected || !redisClient || redisClient.isOpen === false) {
    console.warn('⚠️  Redis 未连接，跳过操作');
    if (strict) throw new RedisUnavailableError('Redis 未连接');
    return fallbackValue;
  }

  try {
    return await withRedisTimeout(operation);
  } catch (err) {
    // 覆盖两种超时：外层命令超时（中文文案）、池获取连接超时（TimeoutError，英文）
    if (err.message?.includes('超时') || err.name === 'TimeoutError' || err.message?.includes('Timeout')) {
      console.warn('⚠️  Redis 命令执行超时，返回降级值');
      if (strict) throw new RedisUnavailableError('Redis 命令执行超时');
      return fallbackValue;
    }
    if (err.message?.includes('closed') || err.message?.includes('connection')) {
      // 连接池成员连接异常：池内成员会自动重连；若整个池被关闭则重建
      console.warn('⚠️  Redis 连接已关闭，尝试重建连接池...');
      isRedisConnected = false;
      try {
        await redisClient.connect();
        isRedisConnected = true;
        console.log('✅ Redis 重连成功');
        return await withRedisTimeout(operation);
      } catch (reconnectErr) {
        console.error('❌ Redis 重连失败:', reconnectErr.message);
        if (strict) throw new RedisUnavailableError('Redis 重连失败');
        return fallbackValue;
      }
    }
    throw err;
  }
}

const pool = mysql.createPool(dbConfig);

export { pool, redisClient, safeRedisExecute, isRedisConnected };
export default { pool, redisClient, safeRedisExecute, isRedisConnected };

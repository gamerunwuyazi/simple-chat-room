// 模拟空闲连接假死自愈测试（仅 scr-dev 本地开发库，一次性脚本）
// 步骤：建小池（复用 worker 池同款参数）→ 取连接 SET SESSION wait_timeout=3
// → 等 5s 让服务端杀掉该连接 → 走健康探测路径（SELECT 1 短超时探测 →
// 失败则 destroy 死连接重建 → 再探测）→ 最终 SELECT 1 必须成功。
import mysql from 'mysql2/promise';
import fs from 'fs';

// 解析 .env.local.development 凭据
const env = Object.fromEntries(
  fs.readFileSync(new URL('./.env.local.development', import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('DB_')).map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

console.log('目标自证: DB_HOST=' + env.DB_HOST, 'DB_NAME=' + env.DB_NAME);
if (env.DB_HOST !== 'localhost' || env.DB_NAME !== 'scr-dev') {
  console.error('非 scr-dev 本地库，中止');
  process.exit(1);
}

// ===== 1. 建一个小池（与 worker 池同款参数） =====
const pool = mysql.createPool({
  host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
  connectionLimit: 2, maxIdle: 2, idleTimeout: 60000, connectTimeout: 3000,
  enableKeepAlive: true, keepAliveInitialDelay: 10000
});

// 预热：拿一条连接并故意把它变成"僵尸"（服务端 3s 后单方面杀掉它）
// 关键：持有不归还，模拟真实场景「连接被借出期间被服务端/网络设备掐断」
const victim = await pool.getConnection();
await victim.query("SET SESSION wait_timeout = 3, interactive_timeout = 3");
const victimThread = (await victim.query("SELECT CONNECTION_ID() AS id"))[0][0].id;
console.log(`[1] 连接已建立并设 wait_timeout=3，thread=${victimThread}，持有不归还，等 5s 让服务端杀掉它...`);
await new Promise(r => setTimeout(r, 5000));

// 先证明 victim 确实死了：对它做一次查询必须抛连接级错误
try {
  await victim.query('SELECT 1');
  console.error('❌ victim 连接竟然还活着，测试前提不成立');
  process.exit(1);
} catch (err) {
  console.log(`[1b] victim 已死，查询报错: ${err.code || ''} ${err.message}`);
  victim.destroy(); // 丢弃死连接（自愈第一步）
}

// ===== 2. 健康探测路径（复刻修复后的自愈逻辑） =====
const PROBE_TIMEOUT_MS = 2000;
let activePool = pool;
const probeConn = await (async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('获取数据库连接超时')), PROBE_TIMEOUT_MS);
      });
      timer.unref?.();
      const conn = await Promise.race([activePool.getConnection(), timeout]);
      clearTimeout(timer);
      try {
        await conn.query('SELECT 1');
        console.log(`[2] 探测#${attempt}: SELECT 1 成功（连接健康）`);
        return conn;
      } catch (err) {
        conn.destroy();
        throw err;
      }
    } catch (err) {
      console.warn(`[2] 探测#${attempt} 失败: ${err.code || ''} ${err.message} → destroy 死连接，重建连接池后重试`);
      if (attempt === 3) throw err;
      await activePool.end().catch(() => {});
      activePool = mysql.createPool({
        host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
        connectionLimit: 2, maxIdle: 2, idleTimeout: 60000, connectTimeout: 3000,
        enableKeepAlive: true, keepAliveInitialDelay: 10000
      });
    }
  }
})();

// ===== 3. 最终验证：新连接上真实查询 =====
const [rows] = await probeConn.query('SELECT 1 AS ok, CONNECTION_ID() AS newThread, @@wait_timeout AS wt');
console.log('[3] 自愈后查询结果:', rows[0]);
await probeConn.release();
await activePool.end().catch(() => {});
console.log('✅ 测试通过：死连接被检测并重建，SELECT 1 返回真值');

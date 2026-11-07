// SPDX-License-Identifier: MIT
// 消息拉取 Worker 线程
// 将 getGlobalMessages / getGroupMessages / getOfflineMessages 等 CPU 密集的
// 消息查询与格式化任务放到独立线程执行，避免阻塞主线程事件循环。
import { parentPort, workerData } from 'worker_threads';
import mysql from 'mysql2/promise';
import { createClientPool } from 'redis';

const { dbConfig, redisUrl, offlineLimits, workerConnectionLimit } = workerData;

let dbPromise = null;
let redisPromise = null;

function getDb() {
  if (!dbPromise) {
    // 使用连接池替代单连接：offline-messages 是重查询，若用单连接会串行阻塞
    // 同一 worker 上的 getGlobalMessages / getGroupMessages（load-messages 也走这里）。
    const pool = mysql.createPool({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      // 每个 worker × 连接数需计入总连接预算。默认读主线程传入的 workerConnectionLimit
      // （单实例=8，多实例由连接预算自适应收紧，见 config/poolBudget.js）；
      // 兜底仍支持 WORKER_DB_CONNECTION_LIMIT 环境变量（独立运行 worker 时）。
      connectionLimit: workerConnectionLimit || parseInt(process.env.WORKER_DB_CONNECTION_LIMIT || '8', 10),
      // 空闲连接管理：必须让 maxIdle < connectionLimit，mysql2 才会启动空闲回收器
      // （base/pool.js 的条件）。此前 maxIdle=10 ≥ connectionLimit，回收器从不启动，
      // idleTimeout 形同虚设——连接会一直存活到被 MySQL 端 wait_timeout 静默关闭，
      // 之后首次查询才报 PROTOCOL_CONNECTION_LOST，表现为"连接超时+重连数据库"。
      // 防空闲假死第一条腿：空闲 60s 由客户端主动断开重建，连接活不到服务端超时；
      // 第二条腿见下方 pool.on('connection') 的会话级 wait_timeout 兜底。
      maxIdle: 2,
      idleTimeout: parseInt(process.env.WORKER_DB_IDLE_TIMEOUT || '60000', 10),
      // 连接超时调快（默认 10s）：MySQL 不可达时新连接 3s 即失败，
      // 配合任务层重建重试（约 3s+3s），尽快回退主线程，避免 HTTP 被拖到超时
      connectTimeout: 3000,
      // TCP 层保活：对端静默丢弃连接（wait_timeout/网络设备）时，
      // keepalive 探测让本端感知死连接而非把查询无限挂起。
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });
    // 会话级保活兜底（第二条腿）：即使 idleTimeout 因故未生效（如连接被借出期间
    // 网络设备静默掐断后归还），本端会话的 wait_timeout 也不再依赖服务端全局值。
    // 正常路径下空闲连接 60s 即被回收，根本活不到这个阈值——两条腿互为冗余。
    // mysql2 在每次新建连接入池时触发 'connection' 事件（同步于 connect 回调），
    // 此处查询先于取用方的业务查询入队，不存在顺序竞争。
    pool.on('connection', (conn) => {
      conn.query("SET SESSION wait_timeout = 28800, interactive_timeout = 28800", () => {});
    });
    dbPromise = pool;
  }
  return dbPromise;
}

// 说明：这里**没有**"每任务先 SELECT 1 探活"的环节。
//
// 曾经的实现是每个任务先用 40ms 上限跑一次 SELECT 1，失败就 conn.destroy()，
// 两次都失败再 resetDb() 整池重建。实测这是故障主因：
//   1) SELECT 1 在正常连接上也要一次完整往返，负载稍高就超过 40ms，
//      于是把"只是慢了一点"的好连接 destroy 掉；
//   2) 整池重建 = 后续请求全部要重新 TCP+鉴权，即用户感知的
//      "请求大半时间被连接超时+重连数据库占了"；
//   3) 主线程再把失败当成 worker 不可信，terminate 掉整个 isolate 重建，
//      重建期间槽位不可用，请求全部回退主线程。
//
// mysql2 连接池本身就能处理坏连接：对已被服务端关闭的连接发起查询会立刻抛
// PROTOCOL_CONNECTION_LOST / ECONNRESET，池会自动把该连接移除并按需新建。
// 所以坏连接的代价只是"一次失败的真实查询 + 一次按需建连"，
// 由下方 runTask 的重试路径承担，不需要预探测。

function getRedis() {
  if (!redisPromise) {
    redisPromise = (async () => {
      // worker 内同样池化，避免高并发拉取消息时单连接排队
      const client = createClientPool({ url: redisUrl }, { minimum: 2, maximum: 8, acquireTimeout: 5000 });
      client.on('error', () => {});
      await client.connect();
      return client;
    })();
  }
  return redisPromise;
}

// ===== getGlobalMessages =====
async function runGetGlobalMessages({ limit, olderThan, userId, db }) {
  const redis = await getRedis();

  let query = 'SELECT m.id, m.user_id as userId, u.nickname, u.avatar_url as avatarUrl,'
    + 'm.content, m.at_userid, m.message_type as messageType, m.group_id as groupId, m.timestamp'
    + ' FROM scr_messages m'
    + ' JOIN scr_users u ON m.user_id = u.id'
    + ' WHERE m.group_id IS NULL';

  const params = [];

  let safeLimit;
  try {
    safeLimit = parseInt(limit);
    if (isNaN(safeLimit) || safeLimit <= 0) {
      safeLimit = 20;
    }
  } catch (e) {
    safeLimit = 20;
  }

  const isOlderThanValid = olderThan !== null && olderThan !== undefined && olderThan !== '' && olderThan !== 0 && String(olderThan).trim() !== '';

  if (isOlderThanValid) {
    let safeOlderThan;
    try {
      safeOlderThan = parseInt(olderThan);
      if (!isNaN(safeOlderThan)) {
        query += ' AND m.id < ?';
        params.push(safeOlderThan);
      }
    } catch (e) {
      // 解析失败，使用默认值0
    }
  }

  query += ' ORDER BY m.timestamp DESC, m.id DESC LIMIT ?';
  params.push(safeLimit);

  const [messages] = await db.query(query, params);

  let readMaxId = 0;
  if (userId) {
    const readValue = await redis.get(`scr:read:global:${parseInt(userId)}`);
    readMaxId = readValue ? parseInt(readValue) : 0;
  }

  const processedMessages = messages.map(msg => {
    let atUserIds = null;
    if (msg.at_userid) {
      try {
        const parsed = JSON.parse(msg.at_userid);
        if (Array.isArray(parsed)) {
          atUserIds = parsed.filter(id => id !== null && id !== undefined && id !== '' && !isNaN(Number(id))).map(id => Number(id));
          if (atUserIds.length === 0) atUserIds = null;
        }
      } catch (e) {
        atUserIds = null;
      }
    }
    const baseMessage = {
      id: msg.id,
      userId: msg.userId,
      nickname: msg.nickname,
      avatarUrl: msg.avatarUrl,
      content: msg.content,
      at_userid: atUserIds,
      // 实时推送用的是驼峰 atUserid，历史接口两种键都返回，
      // 否则前端刷新后拿到的历史消息没有 @ 名单（@我 气泡标识会消失）
      atUserid: atUserIds,
      messageType: msg.messageType,
      groupId: msg.groupId !== null && msg.groupId !== undefined ? parseInt(msg.groupId) : null,
      timestamp: msg.timestamp,
      isRead: userId ? (msg.id <= readMaxId || String(msg.userId) === String(userId)) : false
    };

    if (msg.groupNickname) {
      baseMessage.groupNickname = msg.groupNickname;
    }

    if (msg.messageType === 101) {
      const recallMessageId = String(msg.content || '').trim();
      if (recallMessageId && !isNaN(Number(recallMessageId))) {
        baseMessage.content = recallMessageId;
      }
    }

    if (msg.messageType === 1 && msg.content) {
      try {
        const contentData = JSON.parse(msg.content);
        if (contentData.url) {
          baseMessage.imageUrl = contentData.url;
        }
      } catch (error) {
        console.error(`解析图片消息失败: 消息ID=${msg.id}, 错误=${error.message}`);
      }
    }

    return baseMessage;
  });

  return processedMessages.reverse();
}

// ===== getGroupMessages =====
async function runGetGroupMessages({ groupId, limit, olderThan, userId, db }) {
  const redis = await getRedis();

  let safeGroupId;
  try {
    safeGroupId = parseInt(groupId);
    if (isNaN(safeGroupId)) {
      return [];
    }
  } catch (e) {
    return [];
  }

  let safeLimit;
  try {
    safeLimit = parseInt(limit);
    if (isNaN(safeLimit) || safeLimit <= 0) {
      safeLimit = 20;
    }
  } catch (e) {
    safeLimit = 20;
  }

  let query = 'SELECT m.id, m.user_id as userId, u.nickname, u.avatar_url as avatarUrl,'
    + 'm.content, m.at_userid, m.message_type as messageType, m.group_id as groupId, m.timestamp,'
    + 'gm.group_nickname as groupNickname'
    + ' FROM scr_messages m'
    + ' JOIN scr_users u ON m.user_id = u.id'
    + ' LEFT JOIN scr_group_members gm ON m.user_id = gm.user_id AND m.group_id = gm.group_id AND gm.deleted_at IS NULL'
    + ' WHERE m.group_id = ?';
  const params = [safeGroupId];

  const isOlderThanValid = olderThan !== null && olderThan !== undefined && olderThan !== '' && olderThan !== 0 && String(olderThan).trim() !== '';
  if (isOlderThanValid) {
    let safeOlderThan;
    try {
      safeOlderThan = parseInt(olderThan);
      if (!isNaN(safeOlderThan)) {
        query += ' AND m.id < ?';
        params.push(safeOlderThan);
      }
    } catch (e) {
      // 解析失败，使用默认值0
    }
  }

  query += ' ORDER BY m.timestamp DESC, m.id DESC LIMIT ?';
  params.push(safeLimit);

  const [messages] = await db.query(query, params);

  let readMaxId = 0;
  let isGroupDisturb = false;
  if (userId) {
    // 检查用户是否对该群组设置了免打扰
    try {
      const [memberRows] = await db.execute(
        'SELECT is_disturb FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
        [safeGroupId, parseInt(userId)]
      );
      if (memberRows.length > 0 && memberRows[0].is_disturb === 1) {
        isGroupDisturb = true;
      }
    } catch (e) {
      console.error('检查群组免打扰状态失败:', e.message);
    }

    if (!isGroupDisturb) {
      const readValue = await redis.get(`scr:read:group:${safeGroupId}:${parseInt(userId)}`);
      readMaxId = readValue ? parseInt(readValue) : 0;
    }
  }

  const processedMessages = messages.map(msg => {
    let atUserIds = null;
    if (msg.at_userid) {
      try {
        const parsed = JSON.parse(msg.at_userid);
        if (Array.isArray(parsed)) {
          atUserIds = parsed.filter(id => id !== null && id !== undefined && id !== '' && !isNaN(Number(id))).map(id => Number(id));
          if (atUserIds.length === 0) atUserIds = null;
        }
      } catch (e) {
        atUserIds = null;
      }
    }
    const baseMessage = {
      id: msg.id,
      userId: msg.userId,
      nickname: msg.nickname,
      avatarUrl: msg.avatarUrl,
      content: msg.content,
      at_userid: atUserIds,
      // 实时推送用的是驼峰 atUserid，历史接口两种键都返回，
      // 否则前端刷新后拿到的历史消息没有 @ 名单（@我 气泡标识会消失）
      atUserid: atUserIds,
      messageType: msg.messageType,
      groupId: msg.groupId !== null && msg.groupId !== undefined ? parseInt(msg.groupId) : null,
      timestamp: msg.timestamp,
      isRead: userId ? (msg.id <= readMaxId || String(msg.userId) === String(userId)) : false
    };

    if (msg.groupNickname) {
      baseMessage.groupNickname = msg.groupNickname;
    }

    if (msg.messageType === 101) {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed && parsed.id) {
          baseMessage.content = msg.content;
        }
      } catch (e) {
        const recallMessageId = String(msg.content || '').trim();
        if (recallMessageId && !isNaN(Number(recallMessageId))) {
          baseMessage.content = JSON.stringify({
            id: Number(recallMessageId),
            nickname: { [msg.userId]: msg.groupNickname || msg.nickname || '用户' }
          });
        }
      }
    }

    if (msg.messageType === 1 && msg.content) {
      try {
        const contentData = JSON.parse(msg.content);
        if (contentData.url) {
          baseMessage.imageUrl = contentData.url;
        }
      } catch (error) {
        console.error(`解析图片消息失败: 消息ID=${msg.id}, 错误=${error.message}`);
      }
    }

    // 免打扰群组：强制所有消息已读
    if (isGroupDisturb) {
      baseMessage.isRead = true;
    }

    return baseMessage;
  });

  return processedMessages.reverse();
}

// ===== getOfflineMessages =====
async function runGetOfflineMessages({ userId, publicAndGroupMinId, privateMinId, db }) {
  const redis = await getRedis();

  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const publicLimit = offlineLimits.public;
  const [publicMessages] = await db.query(`
    SELECT 
      m.id, 
      m.user_id as userId, 
      u.nickname, 
      u.avatar_url as avatarUrl, 
      m.content, 
      m.at_userid as atUserid,
      m.message_type as messageType, 
      m.timestamp,
      'public' as type
    FROM scr_messages m 
    JOIN scr_users u ON m.user_id = u.id 
    WHERE m.group_id IS NULL 
      AND m.timestamp >= ?
      AND m.id > ?
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ?
  `, [threeMonthsAgo, publicAndGroupMinId, publicLimit]);

  const [allMemberRecords] = await db.execute(`
    SELECT group_id, joined_at, deleted_at FROM scr_group_members WHERE user_id = ?
  `, [userId]);

  const groupRecordsMap = new Map();
  for (const record of allMemberRecords) {
    const groupId = record.group_id;
    if (!groupRecordsMap.has(groupId)) {
      groupRecordsMap.set(groupId, []);
    }
    groupRecordsMap.get(groupId).push(record);
  }

  let groupMessages = [];
  if (groupRecordsMap.size > 0) {
    for (const [groupId, records] of groupRecordsMap) {
      const timeConditions = [];
      const params = [groupId, threeMonthsAgo, publicAndGroupMinId];

      for (const record of records) {
        if (record.deleted_at) {
          timeConditions.push(`(m.timestamp >= ? AND m.timestamp <= ?)`);
          params.push(record.joined_at, record.deleted_at);
        } else {
          timeConditions.push(`m.timestamp >= ?`);
          params.push(record.joined_at);
        }
      }

      const timeCondition = timeConditions.join(' OR ');

      const groupLimit = offlineLimits.group;
      params.push(groupLimit);

      const [groupMsgs] = await db.query(`
        SELECT 
          m.id, 
          m.user_id as userId, 
          u.nickname, 
          u.avatar_url as avatarUrl, 
          m.content, 
          m.at_userid as atUserid,
          m.message_type as messageType, 
          m.timestamp,
          'group' as type,
          m.group_id as groupId,
          g.name as groupName,
          g.deleted_at as groupDeletedAt,
          gm.group_nickname as groupNickname
        FROM scr_messages m 
        JOIN scr_users u ON m.user_id = u.id 
        JOIN scr_groups g ON m.group_id = g.id
        LEFT JOIN scr_group_members gm ON m.user_id = gm.user_id AND m.group_id = gm.group_id AND gm.deleted_at IS NULL
        WHERE m.group_id = ?
          AND m.timestamp >= ?
          AND m.id > ?
          AND (${timeCondition})
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT ?
      `, params);

      groupMessages = groupMessages.concat(groupMsgs);
    }

    groupMessages.sort((a, b) => {
      if (b.timestamp !== a.timestamp) {
        return new Date(b.timestamp) - new Date(a.timestamp);
      }
      return b.id - a.id;
    });

    if (groupMessages.length > 8000) {
      groupMessages = groupMessages.slice(0, 8000);
    }
  }

  const privateLimit = offlineLimits.private;
  // 原查询用 (A OR B) 大范围条件 + 相关 EXISTS 子查询，无法走 sender/receiver 组合索引；
  // 改为两条 UNION ALL（发送侧 / 接收侧），各自命中 (sender_id,receiver_id) 与 (receiver_id,sender_id) 索引，外层统一排序分页。
  const [privateMessages] = await db.query(`
    SELECT * FROM (
      SELECT
        p.id,
        p.sender_id as senderId,
        p.receiver_id as receiverId,
        p.content,
        p.at_userid as atUserid,
        p.message_type as messageType,
        p.is_read as isRead,
        p.timestamp,
        'private' as type,
        u.nickname,
        u.avatar_url as avatarUrl
      FROM scr_private_messages p
      JOIN scr_users u ON p.sender_id = u.id
      WHERE p.sender_id = ?
        AND p.receiver_id != ?
        AND EXISTS (
          SELECT 1 FROM scr_friends cf
          WHERE cf.user_id = ? AND cf.friend_id = p.receiver_id AND cf.status = 1
        )
        AND p.timestamp >= ?
        AND p.id > ?
      UNION ALL
      SELECT
        p.id,
        p.sender_id as senderId,
        p.receiver_id as receiverId,
        p.content,
        p.at_userid as atUserid,
        p.message_type as messageType,
        p.is_read as isRead,
        p.timestamp,
        'private' as type,
        u.nickname,
        u.avatar_url as avatarUrl
      FROM scr_private_messages p
      JOIN scr_users u ON p.sender_id = u.id
      WHERE p.receiver_id = ?
        AND p.sender_id != ?
        AND EXISTS (
          SELECT 1 FROM scr_friends cf
          WHERE cf.user_id = ? AND cf.friend_id = p.sender_id AND cf.status = 1
        )
        AND p.timestamp >= ?
        AND p.id > ?
    ) t
    ORDER BY t.timestamp DESC, t.id DESC
    LIMIT ?
  `, [userId, userId, userId, threeMonthsAgo, privateMinId, userId, userId, userId, threeMonthsAgo, privateMinId, privateLimit]);

  const processRecallMessage = (msg) => {
    if (msg.messageType === 101) {
      if (msg.type === 'group' && msg.groupId) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed && parsed.id) {
            return msg;
          }
        } catch (e) {
          // 旧格式，需要转换
        }
        const recallMessageId = String(msg.content || '').trim();
        if (recallMessageId && !isNaN(Number(recallMessageId))) {
          msg.content = JSON.stringify({
            id: Number(recallMessageId),
            nickname: { [msg.userId || msg.senderId]: msg.groupNickname || msg.nickname || '用户' }
          });
        }
      }
    }
    return msg;
  };

  let globalReadMaxId = 0;
  if (userId) {
    try {
      const val = await redis.get(`scr:read:global:${userId}`);
      globalReadMaxId = val ? parseInt(val) : 0;
    } catch (e) {
      globalReadMaxId = 0;
    }
  }

  const processedPublicMessages = publicMessages.map(msg => {
    const processed = processRecallMessage(msg);
    processed.isRead = globalReadMaxId > 0 ? (msg.id <= globalReadMaxId) : false;
    return processed;
  });

  const groupReadMaxIds = {};
  if (userId) {
    const uniqueGroupIds = [...new Set(groupMessages.map(m => m.groupId))];
    for (const gid of uniqueGroupIds) {
      try {
        const val = await redis.get(`scr:read:group:${gid}:${userId}`);
        groupReadMaxIds[gid] = val ? parseInt(val) : 0;
      } catch (e) {
        groupReadMaxIds[gid] = 0;
      }
    }
  }

  const processedGroupMessages = groupMessages.map(msg => {
    const processed = processRecallMessage(msg);
    const maxId = groupReadMaxIds[msg.groupId] || 0;
    const isOwnMessage = String(msg.userId || msg.senderId) === String(userId);
    processed.isRead = isOwnMessage || (maxId > 0 ? (msg.id <= maxId) : false);
    return processed;
  });

  const processedPrivateMessages = privateMessages.map(processRecallMessage);

  return {
    publicMessages: processedPublicMessages.reverse(),
    groupMessages: processedGroupMessages.reverse(),
    privateMessages: processedPrivateMessages.reverse(),
    timestamp: new Date().toISOString()
  };
}

// 从池取连接的超时：连接池假死（连接被网络设备静默掐断但本端不知情、查询无限挂起）
// 或池耗尽排队时，不能让任务永远等在 getConnection 上——超时抛错，
// 由任务层按连接级错误处理（resetDb 重建后重试），主线程的就绪超时也才有可能等到结果。
const ACQUIRE_TIMEOUT_MS = parseInt(process.env.WORKER_DB_ACQUIRE_TIMEOUT || '4000', 10);

async function acquireDb() {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Worker 获取数据库连接超时')), ACQUIRE_TIMEOUT_MS);
  });
  if (timer.unref) timer.unref();
  try {
    return await Promise.race([getDb().getConnection(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 任务分发：从池中取一条连接执行业务查询，完成后无条件归还池。
// onReady 在拿到连接后立即回调——此时主线程的探测计时器即可清零，
// 不需要（也不再有）额外的 SELECT 1 探活往返。
async function runTask(task, onReady) {
  const db = await acquireDb();
  try {
    onReady();
    switch (task.type) {
      case 'getGlobalMessages':
        return await runGetGlobalMessages({ ...task, db });
      case 'getGroupMessages':
        return await runGetGroupMessages({ ...task, db });
      case 'getOfflineMessages':
        return await runGetOfflineMessages({ ...task, db });
      default:
        throw new Error('未知任务类型: ' + task.type);
    }
  } finally {
    db.release();
  }
}

// 连接级错误：连接已被服务端关闭（wait_timeout/重启/网络中断）或建连失败。
// 这类错误在 worker 内自愈（resetDb + 重试），不外溢成任务失败。
function isConnectionError(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`;
  return /closed state|PROTOCOL_CONNECTION_LOST|PROTOCOL_SEQUENCE_TIMEOUT|ECONNRESET|EPIPE|ETIMEDOUT|ER_SERVER_LOST|ECONNREFUSED|ENOTFOUND|ER_ACCESS|connect ETIMEDOUT|Connection lost|获取数据库连接超时/i.test(text);
}

function resetDb() {
  const pool = dbPromise;
  dbPromise = null;
  if (pool) {
    pool.end().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Worker 只有成功拿到过一条 MySQL 连接后，才会被主线程纳入调度。
// 这里只验证"能连上"，不做 SELECT 1 探活——拿不到连接时 MySQL 本就不可用，
// 此时让 worker 保持 unavailable，请求会立刻回退主线程，比派给它再失败更快。
async function announceWhenHealthy() {
  while (true) {
    try {
      const db = await getDb().getConnection();
      db.release();
      parentPort.postMessage({ workerReady: true });
      return;
    } catch {
      resetDb();
      await sleep(1000);
    }
  }
}

announceWhenHealthy();

// 空闲周期保活：低流量时段任务稀疏，池内连接长期不动。
// 每 60s 对池做一次 SELECT 1（复用池内连接、完成即归还，1 次/分钟对 DB 无压力）：
//   - 连接健康 → 顺带刷新活跃时间，保持连接热身；
//   - 连接已被服务端/网络设备静默掐断 → 立刻抛连接级错误，就地 resetDb 剔除死池，
//     下个任务直接用全新池，不再撞上"假死连接+就绪超时+回退主线程"。
setInterval(() => {
  const pool = dbPromise;
  if (!pool) return;
  pool.query('SELECT 1').catch((err) => {
    if (isConnectionError(err)) {
      console.warn('⚠️ 消息 Worker 空闲保活发现死连接，重建连接池:', err.message);
      resetDb();
    }
  });
}, 60000).unref?.();

parentPort.on('message', async (task) => {
  // 主线程控制消息：就绪超时后通知 worker 丢弃可能假死的连接池并重建
  if (task && task.type === '__resetDb') {
    console.warn('⚠️ 消息 Worker 收到重建指令，丢弃旧连接池（下次任务按需重建）');
    resetDb();
    return;
  }
  try {
    let result;
    let readySent = false;
    const onReady = () => {
      if (!readySent) {
        readySent = true;
        parentPort.postMessage({ id: task.id, ready: true });
      }
    };
    try {
      result = await runTask(task, onReady);
    } catch (err) {
      // 连接级错误在 worker 内自愈：丢弃旧池后重试一次。
      // 已 ready 说明连接当时是好的，是查询中途连接才断的，同样值得重试一次。
      if (!isConnectionError(err)) throw err;
      console.warn('⚠️ 消息 Worker 连接异常，重建连接池后重试:', err.message);
      resetDb();
      result = await runTask(task, onReady);
    }
    parentPort.postMessage({ id: task.id, ok: true, result });
  } catch (err) {
    // 走到这里说明自愈重试也失败了（通常是 MySQL 真的不可达）。
    // 不再因此 terminate worker——它会带着全新的连接池继续服务下一个任务。
    console.error('❌ 消息 Worker 任务失败:', err.message);
    parentPort.postMessage({
      id: task.id,
      ok: false,
      connectionError: isConnectionError(err),
      error: { message: err.message }
    });
  }
});

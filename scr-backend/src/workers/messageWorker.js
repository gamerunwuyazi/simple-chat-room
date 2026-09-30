// SPDX-License-Identifier: MIT
// 消息拉取 Worker 线程
// 将 getGlobalMessages / getGroupMessages / getOfflineMessages 等 CPU 密集的
// 消息查询与格式化任务放到独立线程执行，避免阻塞主线程事件循环。
import { parentPort, workerData } from 'worker_threads';
import mysql from 'mysql2/promise';
import { createClientPool } from 'redis';

const { dbConfig, redisUrl, offlineLimits } = workerData;

let dbPromise = null;
let redisPromise = null;

function getDb() {
  if (!dbPromise) {
    // 使用连接池替代单连接：offline-messages 是重查询，若用单连接会串行阻塞
    // 同一 worker 上的 getGlobalMessages / getGroupMessages（load-messages 也走这里）。
    dbPromise = mysql.createPool({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      // 2 个 worker × 15 = 30 连接；配合主池 150，远低于 MySQL max_connections(500)
      connectionLimit: 15,
      // 空闲连接管理：mysql2 仅在 maxIdle < connectionLimit 时才启动空闲回收器，
      // 空闲 3 小时后由客户端主动断开（早于 MySQL wait_timeout 默认 8h），防止连接腐化
      maxIdle: 10,
      idleTimeout: 3 * 60 * 60 * 1000,
      // 连接超时调快（默认 10s）：MySQL 不可达时新连接 3s 即失败，
      // 配合任务层重建重试（约 3s+3s），尽快回退主线程，避免 HTTP 被拖到超时
      connectTimeout: 3000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });
  }
  return dbPromise;
}

const CONNECTION_PROBE_TIMEOUT_MS = 40;

function withinTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
      if (timer.unref) timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
}

// 每项任务先取得一条连接并在同一条连接上完成 40ms 健康探测。
// getConnection 不限时：池空闲连接被 idleTimeout 回收后池为空，mysql2 会自动新建连接
// （新连接不存在僵尸风险，建连耗时由 connectTimeout 兜底）；40ms 探测只针对池中取出的旧连接，
// 用于识别已被服务端静默关闭的僵尸连接。
async function acquireHealthyConnection() {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = await getDb().getConnection();
    try {
      await withinTimeout(
        conn.query({ sql: 'SELECT 1', timeout: CONNECTION_PROBE_TIMEOUT_MS }),
        CONNECTION_PROBE_TIMEOUT_MS,
        'MySQL 连接健康探测超时'
      );
      return conn;
    } catch (err) {
      conn.destroy(); // 销毁坏连接（自动移出池），池空后下次 getConnection 自动新建
      lastErr = err;
    }
  }
  throw lastErr;
}

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

  let safeLimit = 20;
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
    let safeOlderThan = 0;
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

  let safeGroupId = 0;
  try {
    safeGroupId = parseInt(groupId);
    if (isNaN(safeGroupId)) {
      return [];
    }
  } catch (e) {
    return [];
  }

  let safeLimit = 20;
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
    let safeOlderThan = 0;
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

// 任务分发：探测通过的连接仅供当前任务使用，完成后无条件归还池。
async function runTask(task, onReady) {
  const db = await acquireHealthyConnection();
  onReady();
  try {
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

// 连接级错误：连接已被服务端关闭（wait_timeout/重启/网络中断）或健康探测超时。
function isConnectionError(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`;
  return /健康探测超时|closed state|PROTOCOL_CONNECTION_LOST|PROTOCOL_SEQUENCE_TIMEOUT|ECONNRESET|EPIPE|ETIMEDOUT|ER_SERVER_LOST/i.test(text);
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

// Worker 只有完成一次真实 MySQL 健康探测后才会被主线程纳入调度。
async function announceWhenHealthy() {
  while (true) {
    try {
      const db = await acquireHealthyConnection();
      db.release();
      parentPort.postMessage({ workerReady: true });
      return;
    } catch {
      resetDb();
      await sleep(100);
    }
  }
}

announceWhenHealthy();

parentPort.on('message', async (task) => {
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
      if (!isConnectionError(err) || readySent) throw err;
      // 首次连接探测失败：丢弃旧池后重试一次；若仍未 ready，主线程会在 45ms 熔断此 worker。
      resetDb();
      result = await runTask(task, onReady);
    }
    parentPort.postMessage({ id: task.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id: task.id,
      ok: false,
      connectionError: isConnectionError(err),
      error: { message: err.message }
    });
  }
});

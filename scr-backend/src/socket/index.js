import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { registerUserHandlers } from './handlers/userHandler.js';
import { registerMessageHandlers } from './handlers/messageHandler.js';
import { registerPrivateHandlers } from './handlers/privateHandler.js';
import { socketConfig, getRedisUrl } from '../config/index.js';
import { createBroadcastProducer } from '../utils/broadcast/producer.js';
import { createBroadcastConsumer } from '../utils/broadcast/consumer.js';

// 在线用户管理（使用 Redis）
// 存储在 Redis key: scr:online_users (Hash: socketId -> userData)

// 添加在线用户
async function addOnlineUser(socketId, userData, redisClient) {
  try {
    await redisClient.hSet('scr:online_users', String(socketId), JSON.stringify(userData));
  } catch (err) {
    console.error('添加在线用户失败:', err.message);
  }
}

// 移除在线用户
async function removeOnlineUser(socketId, redisClient) {
  try {
    await redisClient.hDel('scr:online_users', String(socketId));
  } catch (err) {
    console.error('移除在线用户失败:', err.message);
  }
}

// 获取在线用户
async function getOnlineUser(socketId, redisClient) {
  try {
    const userData = await redisClient.hGet('scr:online_users', String(socketId));
    return userData ? JSON.parse(userData) : null;
  } catch (err) {
    console.error('获取在线用户失败:', err.message);
    return null;
  }
}

// 获取所有在线用户
async function getAllOnlineUsers(redisClient) {
  try {
    const users = await redisClient.hGetAll('scr:online_users');
    const result = [];
    for (const socketId in users) {
      try {
        const userData = JSON.parse(users[socketId]);
        if (userData && userData.id) {
          result.push({ socketId, ...userData });
        } else {
          console.warn(`⚠️ 在线用户数据无效(socketId: ${socketId})，已跳过`);
          await redisClient.hDel('scr:online_users', String(socketId));
        }
      } catch (parseErr) {
        console.error(`❌ 解析在线用户数据失败(socketId: ${socketId}):`, parseErr.message);
        await redisClient.hDel('scr:online_users', String(socketId));
      }
    }
    return result;
  } catch (err) {
    console.error('获取所有在线用户失败:', err.message);
    return [];
  }
}

// 获取在线用户数量
async function getOnlineUserCount(redisClient) {
  try {
    return await redisClient.hLen('scr:online_users');
  } catch (err) {
    console.error('获取在线用户数量失败:', err.message);
    return 0;
  }
}

// 更新在线用户数据
async function updateOnlineUser(socketId, updates, redisClient) {
  try {
    const userData = await getOnlineUser(socketId, redisClient);
    if (userData) {
      const updatedUser = { ...userData, ...updates };
      await redisClient.hSet('scr:online_users', socketId, JSON.stringify(updatedUser));
      return updatedUser;
    }
    return null;
  } catch (err) {
    console.error('更新在线用户失败:', err.message);
    return null;
  }
}

// 按用户ID更新所有在线用户数据
async function updateOnlineUserByUserId(userId, updates, redisClient) {
  try {
    const users = await redisClient.hGetAll('scr:online_users');
    for (const socketId in users) {
      try {
        const userData = JSON.parse(users[socketId]);
        if (userData && userData.id && String(userData.id) === String(userId)) {
          const updatedUser = { ...userData, ...updates };
          await redisClient.hSet('scr:online_users', socketId, JSON.stringify(updatedUser));
        }
      } catch (parseErr) {
        console.error(`❌ 解析在线用户数据失败(socketId: ${socketId}):`, parseErr.message);
        await redisClient.hDel('scr:online_users', String(socketId));
      }
    }
  } catch (err) {
    console.error('按用户ID更新在线用户失败:', err.message);
  }
}

// 检查用户是否在线
async function isUserOnline(socketId, redisClient) {
  try {
    return await redisClient.hExists('scr:online_users', socketId);
  } catch (err) {
    console.error('检查用户是否在线失败:', err.message);
    return false;
  }
}

// 已认证用户管理（使用 socket.io 原生房间）
// 房间名：authenticated_users

// 添加已认证用户到房间
async function addAuthenticatedUser(userId, socket, redisClient) {
  try {
    // 添加到 Redis Set（保留用于兼容性检查）
    await redisClient.sAdd('scr:authenticated_users', String(userId));
    // 添加到 socket.io 房间
    if (socket) {
      socket.join('authenticated_users');
    }
  } catch (err) {
    console.error('添加已认证用户失败:', err.message);
  }
}

// 从房间移除已认证用户
async function removeAuthenticatedUser(userId, socket, redisClient) {
  try {
    // 从 Redis Set 移除
    await redisClient.sRem('scr:authenticated_users', String(userId));
    // 从 socket.io 房间移除
    if (socket) {
      socket.leave('authenticated_users');
    }
  } catch (err) {
    console.error('移除已认证用户失败:', err.message);
  }
}

// 检查用户是否已认证
async function isAuthenticatedUser(userId, redisClient) {
  try {
    return await redisClient.sIsMember('scr:authenticated_users', String(userId));
  } catch (err) {
    console.error('检查已认证用户失败:', err.message);
    return false;
  }
}

export function setupSocketIO(server, { pool, redisClient, isIPBanned, getUserSession, validateMessageContent, checkRateLimit, filterMessageFields, isGroupAdmin, getGlobalMessages, getGroupMessages }) {
  
  // 配置 Socket.IO - 使用环境变量配置
  const io = new Server(server, {
    ...socketConfig
  });

  // Redis 适配器：让单发 io.to('user_X') / 控制类操作（如 disconnectSockets）能跨进程生效。
  // 注意：多人广播（group_X / authenticated_users）仍走下方 Redis Streams 扇出路径，
  // 不经适配器，避免与广播消费者重复投递。
  const pubClient = createClient({ url: getRedisUrl() });
  const subClient = pubClient.duplicate();
  pubClient.on('error', (err) => console.error('❌ 广播适配器 pub Redis 错误:', err.message));
  subClient.on('error', (err) => console.error('❌ 广播适配器 sub Redis 错误:', err.message));
  io.adapter(createAdapter(pubClient, subClient));
  Promise.all([pubClient.connect(), subClient.connect()]).catch((err) =>
    console.error('❌ Redis 广播适配器连接失败:', err.message)
  );

  // 广播子系统：生产者 + 消费者
  // 所有广播任务不再在 socket.on 回调里直接 io.to(room).emit，而是经生产者入队，
  // 由独立消费者从 Redis Streams 异步扇出到本进程持有的房间客户端。
  const broadcastProducer = createBroadcastProducer(redisClient);
  const broadcastConsumer = createBroadcastConsumer({ io });
  broadcastConsumer.start().catch((err) => console.error('启动广播消费者失败:', err.message));

  // 优雅关闭：立即停止监听以释放端口，再停止广播消费者（持久化 lastId），随后退出进程。
  // 关键：
  //   1. 不能等待所有 socket 连接关闭——WebSocket/HTTP keep-alive 永不自发结束，等它们会卡死。
  //      server.close() 会立刻停止 accept 并让 OS 释放监听端口，存量连接由进程退出一并回收。
  //   2. 必须真正退出进程，否则 socket.io 连接 + 阻塞 XREAD 的 Redis 连接会一直持有端口，
  //      导致重启时报 EADDRINUSE，且 SIGTERM（kill）无法退出、只能 kill -9。
  let shuttingDown = false;
  async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('🛑 收到退出信号，正在优雅关闭...');
    // 立即停止监听，让新重启的进程能马上 bind 到同一端口
    try { server.close(); } catch (e) { /* ignore */ }
    try { if (io && typeof io.close === 'function') io.close(); } catch (e) { /* ignore */ }
    // 兜底：无论清理流程是否卡死，最多等 N 秒后强制退出，确保端口被释放
    const forceExit = setTimeout(() => process.exit(0), 2000);
    if (forceExit.unref) forceExit.unref();
    try {
      await broadcastConsumer.stop();
    } catch (err) {
      console.error('停止广播消费者失败:', err.message);
    }
    process.exit(0);
  }
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Socket 事件日志批量写入（每事件一条 INSERT 会放大 DB 压力，采用缓冲批量落库）
  const socketEventLogBuffer = [];
  let socketEventLogFlushTimer = null;

  function flushSocketEventLogs() {
    if (socketEventLogBuffer.length === 0) return;
    const batch = socketEventLogBuffer.splice(0, socketEventLogBuffer.length);
    const placeholders = batch.map(() => '(?, ?, ?)').join(',');
    const params = [];
    for (const item of batch) {
      params.push(item.userId, item.ip, item.eventName);
    }
    pool.query(
      `INSERT INTO scr_socket_event_logs (user_id, ip_address, event_name) VALUES ${placeholders}`,
      params
    ).catch(err => console.error('批量写入Socket事件日志失败:', err.message));
  }

  function logSocketEvent(userId, ip, eventName) {
    if (!eventName) return;
    socketEventLogBuffer.push({ userId, ip, eventName });
    if (socketEventLogBuffer.length >= 50) {
      flushSocketEventLogs();
    } else if (!socketEventLogFlushTimer) {
      socketEventLogFlushTimer = setTimeout(() => {
        socketEventLogFlushTimer = null;
        flushSocketEventLogs();
      }, 500);
    }
  }

  // 获取 socket 真实客户端 IP（与 validateSocketIP 逻辑一致）
  function getSocketClientIP(socket) {
    let clientIP = socket.handshake.address;
    if (socket.handshake.headers && socket.handshake.headers['x-forwarded-for']) {
      clientIP = socket.handshake.headers['x-forwarded-for'].trim().split(',')[0].trim();
    } else if (socket.handshake.headers && socket.handshake.headers['x-real-ip']) {
      clientIP = socket.handshake.headers['x-real-ip'].trim();
    }
    if (clientIP === '::1') {
      return '127.0.0.1';
    }
    if (clientIP && clientIP.startsWith('::ffff:')) {
      return clientIP.slice(7);
    }
    return clientIP || null;
  }

  // 封装在线用户管理函数（绑定redisClient）
  const onlineUserManager = {
    addOnlineUser: (socketId, userData) => addOnlineUser(socketId, userData, redisClient),
    removeOnlineUser: (socketId) => removeOnlineUser(socketId, redisClient),
    getOnlineUser: (socketId) => getOnlineUser(socketId, redisClient),
    getAllOnlineUsers: () => getAllOnlineUsers(redisClient),
    getOnlineUserCount: () => getOnlineUserCount(redisClient),
    updateOnlineUser: (socketId, updates) => updateOnlineUser(socketId, updates, redisClient),
    updateOnlineUserByUserId: (userId, updates) => updateOnlineUserByUserId(userId, updates, redisClient),
    isUserOnline: (socketId) => isUserOnline(socketId, redisClient)
  };

  // 封装已认证用户管理函数（绑定redisClient）
  const authUserManager = {
    addAuthenticatedUser: (userId, socket) => addAuthenticatedUser(userId, socket, redisClient),
    removeAuthenticatedUser: (userId, socket) => removeAuthenticatedUser(userId, socket, redisClient),
    isAuthenticatedUser: (userId) => isAuthenticatedUser(userId, redisClient)
  };

  // 强制断开用户连接并清理
  async function forceDisconnectUser(socket, reason = 'session-expired', originalEventName = null, originalEventData = null) {
    // 如果是 session-expired，只发送事件，不做其他清理操作
    if (reason === 'session-expired') {
      // 发送事件，带上原始事件信息
      if (originalEventName && originalEventData) {
        socket.emit(reason, {
          originalEventName: originalEventName,
          originalEventData: originalEventData
        });
      } else {
        socket.emit(reason);
      }
    } else {
      // 其他原因（如 account-logged-in-elsewhere）继续断开连接
      // 从在线用户列表中移除
      const user = await onlineUserManager.getOnlineUser(socket.id);
      if (user) {
        await onlineUserManager.removeOnlineUser(socket.id);
        await authUserManager.removeAuthenticatedUser(user.id, socket);
        
        // 更新用户最后在线时间
        try {
          await pool.execute(
            'UPDATE scr_users SET last_online = NOW() WHERE id = ?',
            [user.id]
          );
        } catch (err) {
          console.error('更新用户最后上线时间失败:', err.message);
        }
        
        // 集体广播该用户的下线事件（含用户信息），不再广播全量用户列表
        broadcastProducer?.enqueue('authenticated_users', 'user-offline', {
          id: user.id,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl
        });
      }
      
      // 发送事件并断开连接
      socket.emit(reason);
      socket.disconnect(true);
    }
  }

  // Socket.IO会话验证中间件（封禁检查已移除，仅校验会话）
  async function validateSocketPacket(socket, [eventName, ...args]) {
    // 不需要验证的事件列表
    const excludedEvents = ['disconnect', 'error'];
    if (excludedEvents.includes(eventName)) {
      return true;
    }

    const data = args[0] || {};
    const userData = data;

    // user-joined 是认证入口，其余事件一律要求携带有效的 userId + sessionToken（fail-closed）
    const isJoinEvent = eventName === 'user-joined';

    // 除 user-joined 外，所有事件必须携带 userId 和 sessionToken，否则拒绝，防止绕过鉴权触发任意事件
    if (!isJoinEvent && (!userData.userId || !userData.sessionToken)) {
      await forceDisconnectUser(socket, 'session-expired', eventName, data);
      throw new Error('会话无效');
    }

    // 检查用户是否在Redis已认证列表中（user-joined 是认证入口，跳过该检查）
    if (!isJoinEvent) {
      const uid = parseInt(userData.userId);
      // Redis pipeline 一次往返完成 SISMEMBER + GET，避免每事件多次 Redis 调用。
      // 注意：这里只校验 Redis 中的访问令牌（与 HTTP 鉴权 getUserSession 行为一致），
      // 不再查询 scr_sessions 表——socket.use 中间件对同一 socket 是串行执行的，
      // 中间件里的 DB 查询在高并发下会因连接池排队而阻塞该 socket 的全部后续上行包。
      let replies;
      try {
        replies = await redisClient.multi()
          .sIsMember('scr:authenticated_users', String(uid))
          .get(`scr:token:${uid}`)
          .exec();
      } catch (err) {
        console.error('❌ 中间件 Redis pipeline 失败:', err.message);
        await forceDisconnectUser(socket, 'session-expired', eventName, data);
        throw new Error('会话校验失败');
      }
      const isAuth = replies?.[0];
      const token = replies?.[1] ?? null;

      if (!isAuth) {
        await forceDisconnectUser(socket, 'session-expired', eventName, data);
        throw new Error('会话过期');
      }

      // 校验 userId + sessionToken 与 Redis 中的访问令牌一致
      if (token !== userData.sessionToken) {
        await forceDisconnectUser(socket, 'session-expired', eventName, data);
        throw new Error('会话无效');
      }
    }

    // 验证通过
    return true;
  }

  io.on('connection', (socket) => {
    // 异步检查 IP 封禁（不阻塞连接）：若 IP 被封禁则立即踢下线，并销毁该用户（若已认证）的 token 与 refresh token
    (async () => {
      try {
        const clientIP = getSocketClientIP(socket);
        if (!clientIP) return;

        const banInfo = await isIPBanned(clientIP);
        if (!banInfo.isBanned) return;

        socket.emit('account-banned', {
          message: `您的IP已被封禁，无法访问${banInfo.reason ? `，原因：${banInfo.reason}` : ''}`,
          ipAddress: clientIP,
          isBanned: true,
          reason: banInfo.reason,
          remainingTime: banInfo.remainingTime,
          status: 'error'
        });

        // 等待该连接完成认证（最多1秒），以便销毁其 token 与 refresh token
        let user = await onlineUserManager.getOnlineUser(socket.id);
        const waitUntil = Date.now() + 1000;
        while (!user && Date.now() < waitUntil) {
          await new Promise((r) => setTimeout(r, 100));
          user = await onlineUserManager.getOnlineUser(socket.id);
        }

        if (user) {
          await redisClient.del(`scr:token:${user.id}`);
          try {
            await pool.execute('DELETE FROM scr_sessions WHERE user_id = ?', [user.id]);
          } catch (err) {
            // ignore
          }
          await onlineUserManager.removeOnlineUser(socket.id);
          await authUserManager.removeAuthenticatedUser(user.id, socket);
        }

        socket.disconnect(true);
      } catch (err) {
        console.error('异步IP封禁检查失败:', err.message);
      }
    })();

    // 为每个连接的 socket 设置数据包验证中间件
    socket.use(async (packet, next) => {
      try {
        // 记录 Socket 事件日志（仅用户ID/IP/事件名，不含事件体）
        const eventName = String(packet[0] || '').slice(0, 64);
        let logUserId = null;
        if (packet[1] && packet[1].userId !== undefined) {
          const parsedUserId = parseInt(packet[1].userId);
          if (!isNaN(parsedUserId)) {
            logUserId = parsedUserId;
          }
        }
        logSocketEvent(logUserId, getSocketClientIP(socket), eventName);

        await validateSocketPacket(socket, packet);
        next();
      } catch (err) {
        next(err);
      }
    });

    // 注册各个handler
    const context = {
      pool,
      broadcastProducer,
      ...onlineUserManager,
      ...authUserManager,
      forceDisconnectUser,
      checkRateLimit,
      validateMessageContent,
      filterMessageFields,
      isGroupAdmin,
      getGlobalMessages,
      getGroupMessages
    };

    registerUserHandlers(socket, io, context);
    registerMessageHandlers(socket, io, context);
    registerPrivateHandlers(socket, io, context);
  });

  return { io, broadcastProducer, broadcastConsumer };
}

export default setupSocketIO;

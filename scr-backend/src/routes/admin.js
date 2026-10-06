import { pool, redisClient } from '../models/database.js';
import { ADMIN_PASSWORD } from '../config/index.js';
import { getOnlineUser, removeOnlineUser, getAllOnlineUsers } from '../utils/session.js';

// 管理员认证中间件
async function authenticateAdmin(req, res, next) {
  const adminPassword = req.headers['x-admin-password'] || req.body?.adminPassword;

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ status: 'error', message: '管理员密码未配置' });
  }

  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ status: 'error', message: '管理员认证失败' });
  }

  next();
}

export function setupRoutes(app, io, broadcastProducer) {
  // 封禁IP或用户（支持传 ipAddress 或 userId 任意一个参数）
  app.post('/api/admin/ban-ip', authenticateAdmin, async (req, res) => {
    try {
      const { ipAddress, userId, reason, expiresAt } = req.body;

      if (!ipAddress && !userId) {
        return res.status(400).json({ status: 'error', message: '请提供 ipAddress 或 userId 至少一个参数' });
      }

      let expiresDate = null;
      if (expiresAt) {
        expiresDate = new Date(expiresAt);
        if (isNaN(expiresDate.getTime())) {
          return res.status(400).json({ status: 'error', message: '解封时间格式错误' });
        }
      }

      const banData = {
        reason: reason || '违反使用规则',
        expires_at: expiresDate
      };

      if (ipAddress) {
        // 优先写 Redis（封禁检查全部读 Redis），随后落库持久化
        await redisClient.hSet('scr:banned_ips', ipAddress, JSON.stringify(banData));

        await pool.execute(
          'INSERT INTO scr_banned_ips (ip_address, user_id, reason, expires_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason), expires_at = VALUES(expires_at)',
          [ipAddress, userId || null, reason || '违反使用规则', expiresDate]
        );

        io.to(`ip_${ipAddress}`).emit('ip-banned', {
          ipAddress: ipAddress,
          userId: userId,
          reason: reason || '违反使用规则',
          expiresAt: expiresDate
        });

        const socketsInRoom = await io.in(`ip_${ipAddress}`).fetchSockets();
        for (const socket of socketsInRoom) {
          const user = await getOnlineUser(socket.id);
          if (user) {
            await removeOnlineUser(socket.id);
            await redisClient.sRem('scr:authenticated_users', String(user.id));

            // 若该用户正是本次同时封禁的 userId，则跳过删除凭据（由 userId 分支统一执行一次），继续踢下一个
            const isSameBannedUser = userId !== undefined && String(user.id) === String(userId);
            if (!isSameBannedUser) {
              await redisClient.del(`scr:token:${user.id}`);
            }

            try {
              if (!isSameBannedUser) {
                await pool.execute(
                  'DELETE FROM scr_sessions WHERE user_id = ?',
                  [user.id]
                );
              }
              await pool.execute(
                'UPDATE scr_users SET last_online = NOW() WHERE id = ?',
                [user.id]
              );
            } catch (err) {
              // ignore
            }
          }
        }

        io.to(`ip_${ipAddress}`).disconnectSockets(true);

        const allOnlineUsers = await getAllOnlineUsers();
        const onlineUsersArray = allOnlineUsers.map(u => ({
          id: u.id,
          nickname: u.nickname,
          avatarUrl: u.avatarUrl,
          isOnline: true
        }));

        broadcastProducer?.enqueue('authenticated_users', 'users-list', {
          online: onlineUsersArray
        });
      }

      if (userId) {
        const userIdStr = String(userId);

        // 优先写 Redis（封禁检查全部读 Redis），随后落库持久化
        await redisClient.hSet('scr:banned_users', userIdStr, JSON.stringify(banData));

        if (!ipAddress) {
          await pool.execute(
            'INSERT INTO scr_banned_ips (ip_address, user_id, reason, expires_at) VALUES (?, ?, ?, ?)',
            [null, userId, reason || '违反使用规则', expiresDate]
          );
        }

        // 封禁即注销该用户的登录凭据：删除 Redis 访问 token 与数据库中的 refresh token
        await redisClient.del(`scr:token:${userIdStr}`);
        await pool.execute('DELETE FROM scr_sessions WHERE user_id = ?', [userId]);

        io.to(`user_${userId}`).emit('user-banned', {
          ipAddress: ipAddress,
          userId: userId,
          reason: reason || '违反使用规则',
          expiresAt: expiresDate
        });

        const userSocketsInRoom = await io.in(`user_${userId}`).fetchSockets();
        for (const socket of userSocketsInRoom) {
          const user = await getOnlineUser(socket.id);
          if (user) {
            await removeOnlineUser(socket.id);
            await redisClient.sRem('scr:authenticated_users', String(user.id));

            try {
              await pool.execute(
                'UPDATE scr_users SET last_online = NOW() WHERE id = ?',
                [user.id]
              );
            } catch (err) {
              // ignore
            }
          }
        }

        io.to(`user_${userId}`).disconnectSockets(true);

        if (!ipAddress) {
          const allOnlineUsers = await getAllOnlineUsers();
          const onlineUsersArray = allOnlineUsers.map(u => ({
            id: u.id,
            nickname: u.nickname,
            avatarUrl: u.avatarUrl,
            isOnline: true
          }));

          broadcastProducer?.enqueue('authenticated_users', 'users-list', {
            online: onlineUsersArray
          });
        }
      }

      const bannedTarget = ipAddress ? `IP ${ipAddress}` : `用户 ${userId}`;
      res.json({
        status: 'success',
        message: `${bannedTarget} 已被封禁`,
        bannedAt: new Date().toISOString(),
        expiresAt: expiresDate ? expiresDate.toISOString() : null
      });
    } catch (err) {
      console.error('封禁IP失败:', err.message);
      res.status(500).json({ status: 'error', message: '封禁IP失败' });
    }
  });

  // 解封IP或用户（支持传 ipAddress 或 userId 任意一个参数）
  app.post('/api/admin/unban-ip', authenticateAdmin, async (req, res) => {
    try {
      const { ipAddress, userId } = req.body;

      if (!ipAddress && !userId) {
        return res.status(400).json({ status: 'error', message: '请提供 ipAddress 或 userId 至少一个参数' });
      }

      if (ipAddress && userId) {
        // 同时提供 IP 和用户ID 时，只删除同时匹配的记录
        // 优先删 Redis（封禁检查全部读 Redis），随后清理数据库
        await redisClient.hDel('scr:banned_ips', ipAddress);
        await redisClient.hDel('scr:banned_users', String(userId));

        await pool.execute(
          'DELETE FROM scr_banned_ips WHERE ip_address = ? AND user_id = ?',
          [ipAddress, userId]
        );
      } else {
        if (ipAddress) {
          await redisClient.hDel('scr:banned_ips', ipAddress);

          await pool.execute(
            'DELETE FROM scr_banned_ips WHERE ip_address = ?',
            [ipAddress]
          );
        }

        if (userId) {
          await redisClient.hDel('scr:banned_users', String(userId));

          await pool.execute(
            'DELETE FROM scr_banned_ips WHERE user_id = ?',
            [userId]
          );
        }
      }

      const unbannedTarget = ipAddress ? `IP ${ipAddress}` : `用户 ${userId}`;
      res.json({
        status: 'success',
        message: `${unbannedTarget} 已解封`
      });
    } catch (err) {
      console.error('解封IP失败:', err.message);
      res.status(500).json({ status: 'error', message: '解封IP失败' });
    }
  });

  // 获取封禁列表
  app.get('/api/admin/banned-ips', authenticateAdmin, async (req, res) => {
    try {
      const [bannedIps] = await pool.execute(`
        SELECT b.*, u.username, u.nickname,
          CASE WHEN b.expires_at IS NULL THEN '永久'
               WHEN b.expires_at > NOW() THEN CONCAT('剩余 ', TIMESTAMPDIFF(HOUR, NOW(), b.expires_at), ' 小时')
               ELSE '已过期'
          END as status
        FROM scr_banned_ips b
        LEFT JOIN scr_users u ON b.user_id = u.id
        ORDER BY b.banned_at DESC
      `);

      res.json({
        status: 'success',
        bannedList: bannedIps,
        count: bannedIps.length
      });
    } catch (err) {
      console.error('获取封禁IP列表失败:', err.message);
      res.status(500).json({ status: 'error', message: '获取封禁IP列表失败' });
    }
  });

  // 获取IP操作日志
  app.get('/api/admin/login-ips', authenticateAdmin, async (req, res) => {
    try {
      const [loginIps] = await pool.execute(`
        SELECT lip.*, u.username, u.nickname
        FROM scr_ip_logs lip
        LEFT JOIN scr_users u ON lip.user_id = u.id
        ORDER BY lip.timestamp DESC
        LIMIT 5000
      `);

      res.json({
        status: 'success',
        loginIPs: loginIps,
        totalLogs: loginIps.length
      });
    } catch (err) {
      console.error('获取IP操作日志失败:', err.message);
      res.status(500).json({ status: 'error', message: '获取IP操作日志失败' });
    }
  });

  // 获取API请求日志
  app.get('/api/admin/api-logs', authenticateAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 3000;
      const offset = (page - 1) * limit;

      const [logs] = await pool.query(`
        SELECT al.*, u.username, u.nickname
        FROM scr_api_logs al
        LEFT JOIN scr_users u ON al.user_id = u.id
        ORDER BY al.timestamp DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);

      const [countResult] = await pool.query(
        'SELECT COUNT(*) as total FROM scr_api_logs'
      );
      const total = countResult[0].total;

      res.json({
        status: 'success',
        apiLogs: logs,
        pagination: {
          page: page,
          limit: limit,
          total: total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err) {
      console.error('获取API日志失败:', err.message);
      res.status(500).json({ status: 'error', message: '获取API日志失败' });
    }
  });

  // 获取Socket事件日志
  app.get('/api/admin/socket-logs', authenticateAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 3000;
      const offset = (page - 1) * limit;

      const [logs] = await pool.query(`
        SELECT sel.*, u.username, u.nickname
        FROM scr_socket_event_logs sel
        LEFT JOIN scr_users u ON sel.user_id = u.id
        ORDER BY sel.timestamp DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);

      const [countResult] = await pool.query(
        'SELECT COUNT(*) as total FROM scr_socket_event_logs'
      );
      const total = countResult[0].total;

      res.json({
        status: 'success',
        socketLogs: logs,
        pagination: {
          page: page,
          limit: limit,
          total: total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err) {
      console.error('获取Socket日志失败:', err.message);
      res.status(500).json({ status: 'error', message: '获取Socket日志失败' });
    }
  });
}
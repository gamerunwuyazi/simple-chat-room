import { SocketEvents } from '../events.js';
import { trimIPLogs } from '../../utils/session.js';

export function registerUserHandlers(socket, io, { pool, addOnlineUser, removeOnlineUser, getOnlineUser, getAllOnlineUsers, addAuthenticatedUser, removeAuthenticatedUser, forceDisconnectUser, broadcastProducer }) {
  
  // 用户加入聊天室
  socket.on(SocketEvents.USER_JOINED, async (userData) => {
    try {
      // 确保用户 ID 是数字类型，防止 SQL 注入
      const userId = parseInt(userData.userId);
      if (isNaN(userId)) {
        await forceDisconnectUser(socket, 'session-expired');
        return;
      }
      
      // 从数据库中获取真实的用户信息（优先执行，确认用户存在）
      const [users] = await pool.execute(
          'SELECT nickname, avatar_url as avatarUrl, gender FROM scr_users WHERE id = ?',
          [userId]
      );
      
      if (users.length === 0) {
        socket.emit(SocketEvents.ERROR, { message: '用户不存在' });
        socket.emit(SocketEvents.SESSION_EXPIRED);
        socket.disconnect(true);
        return;
      }
      
      const user = users[0];
      const { nickname, avatarUrl, gender } = user;
      
      // 加入用户自己的房间，用于接收私人和群组通知
      socket.join(`user_${userId}`);
      
      // 加入用户的所有群组房间
      try {
        const [userGroups] = await pool.execute(
          'SELECT group_id FROM scr_group_members WHERE user_id = ? AND deleted_at IS NULL',
          [userId]
        );
        
        for (const group of userGroups) {
          socket.join(`group_${group.group_id}`);
        }
      } catch (err) {
        console.error('❌ 加入用户群组列表房间失败:', err.message);
      }
      
      // 获取客户端IP并加入IP房间，用于接收IP封禁通知
      let clientIP = socket.handshake.headers['x-forwarded-for'];
      if (!clientIP) {
        clientIP = socket.handshake.headers['x-real-ip'];
      }
      if (!clientIP) {
        clientIP = socket.handshake.address || socket.conn.remoteAddress;
      }
      // 取第一个IP（如果有多个）
      if (clientIP && clientIP.includes(',')) {
        clientIP = clientIP.split(',')[0].trim();
      }
      // 处理IPv6格式
      let processedIP = clientIP;
      if (processedIP === '::1') {
        processedIP = '127.0.0.1';
      } else if (processedIP && processedIP.startsWith('::ffff:')) {
        processedIP = processedIP.slice(7);
      }
      if (processedIP) {
        socket.join(`ip_${processedIP}`);
      }
      
      // 检查用户是否已经在线，如果在线则移除旧连接
      const allOnlineUsers = await getAllOnlineUsers();
      let isExistingUser = false;
      for (const onlineUser of allOnlineUsers) {
        if (String(onlineUser.id) === String(userId)) {
          await removeOnlineUser(onlineUser.socketId);
          isExistingUser = true;
          break;
        }
      }
  
      // 存储用户信息（使用数据库中的真实信息）
      await addOnlineUser(socket.id, {
        id: userId,
        nickname: nickname,
        socketId: socket.id,
        avatarUrl: avatarUrl,
        gender: gender
      });
  
      // 将用户添加到已认证集合和房间，只有发送过 user-joined 的用户才能收到主聊天室消息
      await addAuthenticatedUser(userId, socket);
  
      try {
        // 更新用户最后在线时间
        await pool.execute(
            'UPDATE scr_users SET last_online = NOW() WHERE id = ?',
            [userId]
        );
      } catch (err) {
        console.error('❌ 更新用户最后在线时间失败:', err.message);
      }

      // 记录用户加入事件到scr_ip_logs
      try {
        // 从nginx代理头获取真实客户端IP
        let clientIP = socket.handshake.headers['x-forwarded-for'];
        if (!clientIP) {
          clientIP = socket.handshake.headers['x-real-ip'];
        }
        if (!clientIP) {
          clientIP = socket.handshake.address || 'unknown';
        }
        // 取第一个IP（如果有多个）
        if (clientIP && clientIP.includes(',')) {
          clientIP = clientIP.split(',')[0].trim();
        }
        await pool.execute(
          'INSERT INTO scr_ip_logs (user_id, ip_address, action) VALUES (?, ?, ?)',
          [userId, clientIP, 'check_status']
        );
        // 清理旧记录，保持最多8000条
        await trimIPLogs();
      } catch (logErr) {
        console.error('记录IP日志失败:', logErr.message);
      }

      // 完整在线用户列表只返回给当前加入的前端（单播），不再返回离线列表、不再集体广播全量列表
      const onlineUsersList = await getAllOnlineUsers();
      const onlineUsersArray = onlineUsersList.map(user => ({
        id: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        isOnline: true
      }));

      socket.emit(SocketEvents.USERS_LIST, {
        online: onlineUsersArray
      });

      // 集体广播该用户的上线事件（含用户信息）。
      // 已认证用户（含刚加入的该用户自己）都会收到，前端按用户 id 去重合并，
      // 避免用户在自己已包含自己的完整列表里再添加一遍自己
      broadcastProducer?.enqueue('authenticated_users', SocketEvents.USER_ONLINE, {
        id: userId,
        nickname: nickname,
        avatarUrl: avatarUrl,
        gender: gender
      });

      // 发送加入确认事件
      socket.emit(SocketEvents.USER_JOINED_CONFIRMED, {
        success: true,
        userId: userId
      });
  
    } catch (err) {
      console.error('❌ 处理用户加入时出错:', err.message);
      socket.emit(SocketEvents.ERROR, { message: '加入聊天室失败' });
    }
  });

  // 用户断开连接
  socket.on(SocketEvents.DISCONNECT, async (reason) => {
    // 从已认证用户集合和房间中移除
    const user = await getOnlineUser(socket.id);
    if (user) {
      await removeAuthenticatedUser(user.id, socket);
    }

    // 从在线用户列表中移除
    if (user) {
      await removeOnlineUser(socket.id);

      // 更新用户最后上线时间（即下线时间）
      try {
        await pool.execute(
          'UPDATE scr_users SET last_online = NOW() WHERE id = ?',
          [user.id]
        );
      } catch (err) {
        console.error('更新用户最后上线时间失败:', err.message);
      }

      // 集体广播该用户的下线事件（含用户信息），不再广播全量用户列表
      broadcastProducer?.enqueue('authenticated_users', SocketEvents.USER_OFFLINE, {
        id: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl
      });
    }
  });

  // 连接错误处理
  socket.on(SocketEvents.ERROR, (error) => {
  });
}

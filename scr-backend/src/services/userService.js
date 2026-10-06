import bcrypt from 'bcryptjs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { pool, redisClient} from '../models/database.js';
import { checkRegisterRateLimit, checkLoginRateLimit } from '../utils/rateLimiters.js';
import { validateUsername, validatePassword, validateNickname } from '../utils/validators.js';
import { getClientIP, generateSessionToken } from '../utils/helpers.js';
import { isIPBanned, isUserBanned } from '../middleware/auth.js';
import { filterMessageFields } from '../utils/messageFilters.js';
import { sessionConfig } from '../config/index.js';
import {
  setSocketIO as setSessionSocketIO,
  createUserSession,
  updateOnlineUserByUserId,
  logIPAction
} from '../utils/session.js';
import { verifyPOWSolution } from 'human-verify/backend';

let io;
let broadcastProducer;

// POW 验证函数 - 只验证 POW，行为验证已在 /api/verify/pow-challenge 完成
async function verifyHuman(req, res) {
  try {
    const { sessionId, nonce } = req.body;
    
    if (!sessionId || !nonce) {
      return { success: false, message: '缺少 POW 验证数据' };
    }

    // POW 验证（1.2.x 起为异步，且无论成败都会销毁会话防重放）
    const powResult = await verifyPOWSolution(sessionId, nonce);
    if (!powResult.success) {
      return { success: false, message: powResult.error || 'POW 验证失败' };
    }

    if (!powResult.passed) {
      return { success: false, message: 'POW 验证未通过' };
    }

    return { success: true };
  } catch (err) {
    console.error('POW 验证失败:', err.message);
    return { success: false, message: 'POW 验证失败' };
  }
}

export function initUserService(dependencies) {
  ({ io, broadcastProducer } = dependencies);
  if (io) setSessionSocketIO(io);
}

const avatarDir = path.join(process.cwd(), 'public', 'avatars');

export async function register(req, res) {
  try {
    const { username, password, nickname, gender, sessionId, nonce } = req.body;
    const clientIP = getClientIP(req);

    // 从 Redis 检查 IP 封禁（封禁数据由 admin 接口/启动同步写入 Redis）
    const ipBan = await isIPBanned(clientIP);
    if (ipBan.isBanned) {
      let message = '您的 IP 已被封禁';
      if (ipBan.reason) message += `，原因：${ipBan.reason}`;
      if (ipBan.remainingTime) {
        const { days, hours, minutes } = ipBan.remainingTime;
        message += `，还剩 ${days}天${hours}小时${minutes}分钟解封`;
      }
      return res.status(403).json({ status: 'error', message });
    }

    if (!username || !password || !nickname || !sessionId || !nonce) {
      return res.status(400).json({ status: 'error', message: '请填写所有字段' });
    }

    const genderNum = parseInt(gender);
    if (isNaN(genderNum) || genderNum < 0 || genderNum > 2) {
      return res.status(400).json({ status: 'error', message: '性别参数非法' });
    }

    // 人机验证
    const captchaResult = await verifyHuman(req, res);
    if (!captchaResult.success) {
      return res.status(400).json({ status: 'error', message: captchaResult.message || '人机验证失败，请重试' });
    }

    const registerRateLimit = await checkRegisterRateLimit(clientIP);
    if (!registerRateLimit.allowed) {
      let message = '注册请求过于频繁';
      if (registerRateLimit.limitType === 'hour') {
        message = `1小时内最多注册2次，请${registerRateLimit.waitSeconds}秒后再试`;
      } else if (registerRateLimit.limitType === 'day') {
        message = `24小时内最多注册5次，请${registerRateLimit.waitSeconds}秒后再试`;
      } else if (registerRateLimit.limitType === 'month') {
        message = `1个月内最多注册20次，请${registerRateLimit.waitSeconds}秒后再试`;
      }
      return res.status(429).json({
        status: 'error',
        message: message
      });
    }

    if (!validateUsername(username) && !validatePassword(password) && !validateNickname(nickname)) {
      return res.status(400).json({ status: 'error', message: '用户名、密码或昵称非法' });
    }

    const [existingUsers] = await pool.execute(
        'SELECT id FROM scr_users WHERE username = ?',
        [username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ status: 'error', message: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await pool.execute(
        'INSERT INTO scr_users (username, password, nickname, gender, last_online) VALUES (?, ?, ?, ?, NOW())',
        [username, hashedPassword, nickname, genderNum]
    );

    await logIPAction(result.insertId, clientIP, 'register');
    console.log(`用户注册,id:${result.insertId},IP:${clientIP}`);

    const autoLoginToken = crypto.randomBytes(32).toString('hex');

    await redisClient.set(`scr:auto_login_token:${result.insertId}`, autoLoginToken, {
      EX: 300
    });

    res.json({
      status: 'success',
      message: '注册成功',
      userId: result.insertId,
      autoLoginToken: autoLoginToken
    });
  } catch (err) {
    console.error('注册失败:', err.message);
    res.status(500).json({ status: 'error', message: '注册失败' });
  }
}

export async function login(req, res) {
  try {
    const { username, password, sessionId, nonce, autoLoginToken } = req.body;
    const clientIP = getClientIP(req);

    // 账号密码登录或自动登录 token 登录
    if (username !== undefined && (password !== undefined || autoLoginToken)) {
      const isAutoLogin = !!autoLoginToken;

      if (!isAutoLogin) {
        if (!sessionId || !nonce) {
          return res.status(400).json({ status: 'error', message: '请完成人机验证' });
        }

        const captchaResult = await verifyHuman(req, res);
        if (!captchaResult.success) {
          return res.status(400).json({ status: 'error', message: captchaResult.message || '人机验证失败，请重试' });
        }
      }

      const loginRateLimit = await checkLoginRateLimit(clientIP);
      if (!loginRateLimit.allowed) {
        let message = '登录请求过于频繁';
        if (loginRateLimit.limitType === 'minute') {
          message = `登录请求过于频繁，请${loginRateLimit.waitSeconds}秒后再试`;
        } else if (loginRateLimit.limitType === 'hour') {
          message = `1小时内登录请求次数已达上限，请${loginRateLimit.waitSeconds}秒后再试`;
        }
        return res.status(429).json({
          status: 'error',
          message: message
        });
      }

      let users;
      let ipBan;
      try {
        // 并行：查询用户记录 + IP封禁检查（Redis，互不依赖）
        [users, ipBan] = await Promise.all([
          (async () => {
            const [rows] = await pool.execute(
              'SELECT id, username, password, nickname, gender, avatar_url FROM scr_users WHERE username = ?',
              [username]
            );
            return rows;
          })(),
          isIPBanned(clientIP)
        ]);

        if (users.length === 0) {
          await logIPAction(null, clientIP, 'login_failed');
          return res.status(401).json({ status: 'error', message: '用户名或密码错误' });
        }
      } catch (err) {
        console.error('❌ 查询用户失败:', err.message);
        void logIPAction(null, clientIP, 'login_failed');
        const isPoolSaturated = err.message?.includes('Queue limit reached');
        return res.status(isPoolSaturated ? 503 : 500).json({
          status: 'error',
          message: isPoolSaturated ? '服务繁忙，请稍后重试' : '查询用户失败'
        });
      }

      const user = users[0];
      if (isAutoLogin) {
        const storedToken = await redisClient.get(`scr:auto_login_token:${user.id}`);
        if (!storedToken || storedToken !== autoLoginToken) {
          return res.status(400).json({ status: 'error', message: '自动登录 token 无效或已过期，请使用账号密码登录' });
        }
      } else {
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
          await logIPAction(user.id, clientIP, 'login_failed');
          return res.status(401).json({ status: 'error', message: '用户名或密码错误' });
        }
      }

      // IP 封禁检查（已与用户查询并行获取）
      if (ipBan.isBanned) {
        let message = '您的 IP 已被封禁';
        if (ipBan.reason) message += `，原因：${ipBan.reason}`;
        if (ipBan.remainingTime) {
          const { days, hours, minutes } = ipBan.remainingTime;
          message += `，还剩 ${days}天${hours}小时${minutes}分钟解封`;
        }
        return res.status(429).json({ status: 'error', message, isBanned: true });
      }
      // 账号封禁检查（Redis）
      const userBan = await isUserBanned(user.id);
      if (userBan.isBanned) {
        let message = '您的账号已被封禁';
        if (userBan.reason) message += `，原因：${userBan.reason}`;
        if (userBan.remainingTime) {
          const { days, hours, minutes } = userBan.remainingTime;
          message += `，还剩 ${days}天${hours}小时${minutes}分钟解封`;
        }
        return res.status(429).json({ status: 'error', message, isBanned: true });
      }

      if (autoLoginToken) {
        await redisClient.del(`scr:auto_login_token:${user.id}`);
      }

      // 并行：创建会话 + 记录登录日志（互不依赖）
      const [session] = await Promise.all([
        createUserSession(user.id),
        logIPAction(user.id, clientIP, 'login')
      ]);
      console.log(`用户登录,id:${user.id},IP:${clientIP}`);

      res.json({
        status: 'success',
        message: '登录成功',
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          gender: user.gender,
          avatar_url: user.avatar_url
        },
        ...session
      });
      return;
    }

    return res.status(400).json({ status: 'error', message: '请提供账号密码' });
  } catch (err) {
    console.error('登录失败:', err.message);
    res.status(500).json({ status: 'error', message: '登录失败' });
  }
}

export async function refreshToken(req, res) {
  try {
    const { userId, refreshToken } = req.body;

    if (!userId || !refreshToken) {
      return res.status(400).json({ status: 'error', message: '缺少必要参数' });
    }

    const [rows] = await pool.execute(
      'SELECT refresh_token, refresh_expires FROM scr_sessions WHERE user_id = ?',
      [parseInt(userId)]
    );

    if (rows.length === 0) {
      return res.status(401).json({ status: 'error', message: '会话已过期，请重新登录' });
    }

    const session = rows[0];

    // 从 Redis 检查封禁：先查 IP，再查 user_id，封禁期间禁止刷新 token
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     req.headers['x-real-ip'] ||
                     req.socket?.remoteAddress ||
                     'unknown';
    const ipBan = await isIPBanned(clientIP);
    if (ipBan.isBanned) {
      let message = '您的 IP 已被封禁，无法刷新会话';
      if (ipBan.reason) message += `，原因：${ipBan.reason}`;
      return res.status(429).json({ status: 'error', message, isBanned: true });
    }
    const userBan = await isUserBanned(parseInt(userId));
    if (userBan.isBanned) {
      let message = '您的账号已被封禁，无法刷新会话';
      if (userBan.reason) message += `，原因：${userBan.reason}`;
      return res.status(429).json({ status: 'error', message, isBanned: true });
    }

    if (new Date(session.refresh_expires) <= new Date()) {
      await pool.execute('DELETE FROM scr_sessions WHERE user_id = ?', [parseInt(userId)]);
      return res.status(401).json({ status: 'error', message: '会话已过期，请重新登录' });
    }

    if (session.refresh_token !== refreshToken) {
      return res.status(401).json({ status: 'error', message: 'Refresh Token 无效' });
    }

    const newToken = generateSessionToken();
    const newRefreshToken = generateSessionToken();
    const newExpires = Date.now() + (sessionConfig.expireMinutes * 60 * 1000);
    const newRefreshExpires = Date.now() + (sessionConfig.refreshExpireDays * 24 * 60 * 60 * 1000);
    const tokenKey = `scr:token:${parseInt(userId)}`;
    
    await pool.execute(
      'UPDATE scr_sessions SET refresh_token = ?, refresh_expires = ?, last_active = NOW() WHERE user_id = ?',
      [newRefreshToken, new Date(newRefreshExpires), parseInt(userId)]
    );
    await redisClient.set(tokenKey, newToken);
    await redisClient.expire(tokenKey, Math.ceil((newExpires - Date.now()) / 1000));

    res.json({
      status: 'success',
      message: 'Token 刷新成功',
      token: newToken,
      refreshToken: newRefreshToken
    });
  } catch (err) {
    console.error('刷新 Token 失败:', err.message);
    res.status(500).json({ status: 'error', message: '刷新 Token 失败' });
  }
}

export async function updateNickname(req, res) {
  try {
    const userId = req.userId;
    const { nickname } = req.body;

    if (!validateNickname(nickname)) {
      return res.status(400).json({ status: 'error', message: '昵称不能为空' });
    }

    await pool.execute(
      'UPDATE scr_users SET nickname = ? WHERE id = ?',
      [nickname, userId]
    );

    const [users] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    const user = users[0];

    const [nicknameUpdateResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, timestamp) VALUES (?, ?, ?, NOW())',
      [userId, JSON.stringify({ type: 'nickname', nickname }), 102]
    );

    await updateOnlineUserByUserId(userId, { nickname });

    const now = new Date();
    const timestampMs = now.getTime();
    const rawType102Message = {
      id: nicknameUpdateResult.insertId,
      userId: userId,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      content: JSON.stringify({ type: 'nickname', nickname: nickname }),
      messageType: 102,
      groupId: null,
      timestamp: timestampMs,
      timestampISO: now.toISOString()
    };

    const type102Message = filterMessageFields(rawType102Message, 'public');

    broadcastProducer?.enqueue('authenticated_users', 'message-received', type102Message);

    res.json({ status: 'success', message: '昵称修改成功', nickname: nickname });
  } catch (err) {
    console.error('修改昵称失败:', err.message);
    res.status(500).json({ status: 'error', message: '修改昵称失败' });
  }
}

export async function updateSignature(req, res) {
  try {
    const userId = req.userId;
    const { signature } = req.body;

    if (!userId) {
      return res.status(400).json({ status: 'error', message: '用户 ID 不能为空' });
    }

    const cleanSignature = signature ? signature.substring(0, 500) : null;

    await pool.execute(
      'UPDATE scr_users SET signature = ? WHERE id = ?',
      [cleanSignature, userId]
    );

    res.json({
      status: 'success',
      message: '个性签名更新成功'
    });
  } catch (err) {
    console.error('更新个性签名失败:', err.message);
    res.status(500).json({ status: 'error', message: '更新个性签名失败' });
  }
}

export async function updateGender(req, res) {
  try {
    const userId = req.userId;
    const { gender } = req.body;

    if (!userId) {
      return res.status(400).json({ status: 'error', message: '用户 ID 不能为空' });
    }

    const genderNum = parseInt(gender);
    if (isNaN(genderNum) || genderNum < 0 || genderNum > 2) {
      return res.status(400).json({ status: 'error', message: '性别参数非法' });
    }

    await pool.execute(
      'UPDATE scr_users SET gender = ? WHERE id = ?',
      [genderNum, userId]
    );

    res.json({
      status: 'success',
      message: '性别更新成功'
    });
  } catch (err) {
    console.error('更新性别失败:', err.message);
    res.status(500).json({ status: 'error', message: '更新性别失败' });
  }
}

export async function changePassword(req, res) {
  try {
    const userId = req.userId;
    const clientIP = getClientIP(req);
    const { oldPassword, newPassword, sessionId, nonce } = req.body;

    if (!oldPassword || !newPassword || !sessionId || !nonce) {
      return res.status(400).json({ status: 'error', message: '缺少必要参数' });
    }

    if (!validatePassword(newPassword)) {
      return res.status(400).json({ status: 'error', message: '新密码格式错误' });
    }

    // POW 验证
    const captchaResult = await verifyHuman(req, res);
    if (!captchaResult.success) {
      return res.status(400).json({ status: 'error', message: captchaResult.message || '人机验证失败，请重试' });
    }

    const [users] = await pool.execute(
      'SELECT id, password FROM scr_users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    const user = users[0];
    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ status: 'error', message: '原密码错误' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await pool.execute(
      'UPDATE scr_users SET password = ? WHERE id = ?',
      [hashedNewPassword, userId]
    );

    res.json({ status: 'success', message: '密码修改成功' });
  } catch (err) {
    console.error('修改密码失败:', err.message);
    res.status(500).json({ status: 'error', message: '修改密码失败' });
  }
}

export function checkAvatarStorage() {
  const MAX_AVATAR_SIZE_MB = 100;
  const MAX_AVATAR_FILES = 10000;

  try {
    if (!fs.existsSync(avatarDir)) {
      return { full: false, message: '' };
    }

    const stats = fs.statSync(avatarDir);
    const sizeInMB = stats.size / (1024 * 1024);

    if (sizeInMB > MAX_AVATAR_SIZE_MB) {
      return { full: true, message: `头像存储空间不足（当前${sizeInMB.toFixed(2)}MB，限制${MAX_AVATAR_SIZE_MB}MB）` };
    }

    const files = fs.readdirSync(avatarDir);
    if (files.length > MAX_AVATAR_FILES) {
      return { full: true, message: `头像文件数量过多（当前${files.length}个，限制${MAX_AVATAR_FILES}个）` };
    }

    return { full: false, message: '' };
  } catch (error) {
    console.error('检查头像存储失败:', error.message);
    return { full: false, message: '' };
  }
}

export async function uploadAvatar(req, res) {
  try {
    if (!req.file) {
      const ext = req.body?.filename ? path.extname(req.body.filename).toLowerCase() : '';
      const prohibitedExts = ['.php', '.php3', '.php4', '.php5', '.phtml', '.phar'];
      if (prohibitedExts.includes(ext)) {
        return res.status(400).json({ status: 'error', message: '禁止上传PHP文件' });
      }
      return res.status(400).json({ status: 'error', message: '没有上传文件' });
    }

    const storageStatus = checkAvatarStorage();
    if (storageStatus.full) {
      return res.status(400).json({ status: 'error', message: storageStatus.message });
    }

    const userId = req.userId;

    if (!userId) {
      return res.status(400).json({ status: 'error', message: '用户ID不能为空' });
    }

    const [users] = await pool.execute(
        'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
        [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    const user = users[0];

    if (!req.file?.filename) {
      console.error('❌ 头像上传失败：文件对象缺少filename字段');
      return res.status(500).json({ status: 'error', message: '文件处理失败' });
    }
    
    const avatarUrl = `/avatars/${req.file.filename}`;

    const avatarFiles = fs.readdirSync(avatarDir).filter(file => {
      return file.startsWith(`avatar_${userId}.`);
    });

    if (avatarFiles.length > 1) {
      const currentAvatarFilename = req.file.filename;
      for (const file of avatarFiles) {
        if (file !== currentAvatarFilename) {
          try {
            const filePath = path.join(avatarDir, file);
            fs.unlinkSync(filePath);
          } catch (deleteError) {
            console.error(`删除旧头像文件 ${file} 失败:`, deleteError.message);
          }
        }
      }
    }

    const timestamp = Date.now();
    const avatarUrlWithVersion = `${avatarUrl}?v=${timestamp}`;

    await pool.execute(
        'UPDATE scr_users SET avatar_url = ? WHERE id = ?',
        [avatarUrlWithVersion, userId]
    );

    const [avatarUpdateResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, timestamp) VALUES (?, ?, ?, NOW())',
      [userId, JSON.stringify({ type: 'avatar', avatarUrl: avatarUrlWithVersion }), 102]
    );

    await updateOnlineUserByUserId(userId, { avatarUrl: avatarUrlWithVersion });

    const now = new Date();
    const timestampMs = now.getTime();
    const rawType102Message = {
      id: avatarUpdateResult.insertId,
      userId: userId,
      nickname: user.nickname,
      avatarUrl: avatarUrlWithVersion,
      content: JSON.stringify({ type: 'avatar', avatarUrl: avatarUrlWithVersion }),
      messageType: 102,
      groupId: null,
      timestamp: timestampMs,
      timestampISO: now.toISOString()
    };

    const type102Message = filterMessageFields(rawType102Message, 'public');

    broadcastProducer?.enqueue('authenticated_users', 'message-received', type102Message);

    res.json({
      status: 'success',
      avatarUrl: avatarUrlWithVersion,
      message: '头像上传成功'
    });
  } catch (err) {
    console.error('头像上传失败:', err.message);
    res.status(500).json({ status: 'error', message: '头像上传失败' });
  }
}

export async function getSelfInfo(req, res) {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ status: 'error', message: '未登录' });
    }

    const [users] = await pool.execute(
      'SELECT id, username, nickname, gender, signature, avatar_url, friend_verification, last_online, created_at FROM scr_users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    const user = users[0];

    res.json({
      status: 'success',
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        gender: user.gender,
        signature: user.signature,
        avatar_url: user.avatar_url,
        friend_verification: user.friend_verification === 1,
        last_online: user.last_online,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('获取当前用户信息失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取当前用户信息失败' });
  }
}

export async function getUserById(req, res) {
  try {
    const userId = req.params.id;

    const [users] = await pool.execute(
        'SELECT id, username, nickname, gender, signature, avatar_url, friend_verification, last_online FROM scr_users WHERE id = ?',
        [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    res.json({
      status: 'success',
      user: {
        id: users[0].id,
        username: users[0].username,
        nickname: users[0].nickname,
        gender: users[0].gender,
        signature: users[0].signature,
        avatar_url: users[0].avatar_url,
        friend_verification: users[0].friend_verification === 1,
        last_online: users[0].last_online
      }
    });
  } catch (err) {
    console.error('获取用户信息失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取用户信息失败' });
  }
}

export async function checkUsername(req, res) {
  try {
    const { username } = req.query;

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ status: 'error', message: '用户名不能为空' });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({ status: 'error', message: '用户名非法' });
    }

    const trimmedUsername = username.trim();

    if (!trimmedUsername) {
      return res.status(400).json({ status: 'error', message: '用户名不能为空' });
    }

    const [existingUsers] = await pool.execute(
      'SELECT id FROM scr_users WHERE username = ?',
      [trimmedUsername]
    );

    res.json({
      status: 'success',
      isAvailable: existingUsers.length === 0,
      username: trimmedUsername
    });
  } catch (err) {
    console.error('❌ 检查用户名失败:', err.message);
    res.status(500).json({ status: 'error', message: '检查用户名失败' });
  }
}

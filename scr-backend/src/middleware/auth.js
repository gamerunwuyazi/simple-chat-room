import { pool, safeRedisExecute, RedisUnavailableError } from '../models/database.js';
import { rateLimitConfig } from '../config/index.js';
import { getClientIP } from '../utils/helpers.js';

const RATE_LIMIT_CONFIG = {
  SHORT_WINDOW_MS: rateLimitConfig.shortWindowMs,
  SHORT_LIMIT: rateLimitConfig.shortLimit,
  LONG_WINDOW_MS: rateLimitConfig.longWindowMs,
  LONG_LIMIT: rateLimitConfig.longLimit
};

// 消息发送/撤回等操作的速率限制 —— 基于 Redis Sorted Set(ZSET) 的滑动窗口，用 Lua 保证原子性。
// 相比旧版（List + JS 过滤）的优势：读、删、写一次原子完成，无竞态；只传计数与最小分数，
// 不传输全部记录，O(log N)；过期成员自动被清除，内存窗口固定。
const RATE_LIMIT_LUA = `
  local shortKey = KEYS[1]
  local longKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local shortLimit = tonumber(ARGV[2])
  local longLimit = tonumber(ARGV[3])
  local shortWindow = tonumber(ARGV[4])
  local longWindow = tonumber(ARGV[5])
  local member = ARGV[6]

  -- 移除窗口外的旧记录
  redis.call('ZREMRANGEBYSCORE', shortKey, 0, now - shortWindow)
  redis.call('ZREMRANGEBYSCORE', longKey, 0, now - longWindow)

  local shortCount = redis.call('ZCARD', shortKey)
  local longCount = redis.call('ZCARD', longKey)

  -- 返回 {allowed, limitType(1=短窗口,2=长窗口), retryAfter}
  if shortCount >= shortLimit then
    local first = redis.call('ZRANGE', shortKey, 0, 0, 'WITHSCORES')
    local retry = shortWindow - (now - tonumber(first[2]))
    if retry < 1 then retry = 1 end
    return {0, 1, retry}
  end

  if longCount >= longLimit then
    local first = redis.call('ZRANGE', longKey, 0, 0, 'WITHSCORES')
    local retry = longWindow - (now - tonumber(first[2]))
    if retry < 1 then retry = 1 end
    return {0, 2, retry}
  end

  -- member 使用 "时间戳:随机串"，保证同一毫秒内多次发送也能正确计数
  redis.call('ZADD', shortKey, now, member)
  redis.call('ZADD', longKey, now, member)
  -- 过期时间比窗口略长，自动清理
  redis.call('EXPIRE', shortKey, math.ceil(shortWindow / 1000) + 1)
  redis.call('EXPIRE', longKey, math.ceil(longWindow / 1000) + 1)
  return {1, 0, 0}
`;

async function checkRateLimit(userId) {
  const now = Date.now();
  const shortWindowKey = `scr:rate_limit:${userId}:short`;
  const longWindowKey = `scr:rate_limit:${userId}:long`;
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

  return safeRedisExecute(async (client) => {
    const result = await client.eval(RATE_LIMIT_LUA, {
      keys: [shortWindowKey, longWindowKey],
      // Lua eval 参数必须为 string|Buffer（node-redis v4 强制类型检查），这里统一转字符串
      arguments: [
        String(now),
        String(RATE_LIMIT_CONFIG.SHORT_LIMIT),
        String(RATE_LIMIT_CONFIG.LONG_LIMIT),
        String(RATE_LIMIT_CONFIG.SHORT_WINDOW_MS),
        String(RATE_LIMIT_CONFIG.LONG_WINDOW_MS),
        member
      ]
    });

    const [allowed, limitType, retryAfter] = result.map(Number);
    if (!allowed) {
      // Lua 返回的 retry 基于毫秒时间戳计算，单位是毫秒；对外统一换算成秒。
      // 用 ceil 向上取整，避免显示"请0秒后再试"。
      return {
        allowed: false,
        limitType: limitType === 1 ? 'short' : 'long',
        retryAfter: Math.ceil(retryAfter / 1000)
      };
    }
    return { allowed: true };
  }, { allowed: true });
}

// 解析 Redis 中的封禁条目（isIPBanned/isUserBanned 共用）
function parseBanEntry(banDataStr) {
  if (!banDataStr) {
    return { isBanned: false, reason: null, remainingTime: null };
  }

  const banData = JSON.parse(banDataStr);

  if (banData.expires_at) {
    const expireDate = new Date(banData.expires_at);
    const now = new Date();

    if (expireDate <= now) {
      return { isBanned: false, expired: true, reason: null, remainingTime: null, expireDate };
    }

    const diff = expireDate - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    return {
      isBanned: true,
      reason: banData.reason || '未知原因',
      remainingTime: { totalSeconds: Math.ceil(diff / 1000), days, hours, minutes }
    };
  }

  return { isBanned: true, reason: banData.reason || '永久封禁', remainingTime: null };
}

async function isIPBanned(ip) {
  return safeRedisExecute(async (client) => {
    const banDataStr = await client.hGet('scr:banned_ips', ip);

    const result = parseBanEntry(banDataStr);

    // 已过期的封禁条目：从 Redis 与 MySQL 中同步清除
    if (banDataStr && result.expired) {
      await client.hDel('scr:banned_ips', ip);
      await pool.execute(
        'DELETE FROM scr_banned_ips WHERE ip_address = ? AND expires_at IS NOT NULL AND expires_at <= NOW()',
        [ip]
      );
      return { isBanned: false, reason: null, remainingTime: null };
    }

    return result;
  }, { isBanned: false, reason: null, remainingTime: null });
}

async function isUserBanned(userId) {
  return safeRedisExecute(async (client) => {
    const banDataStr = await client.hGet('scr:banned_users', String(userId));

    const result = parseBanEntry(banDataStr);

    // 已过期的封禁条目：从 Redis 与 MySQL 中同步清除
    if (banDataStr && result.expired) {
      await client.hDel('scr:banned_users', String(userId));
      await pool.execute(
        'DELETE FROM scr_banned_ips WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <= NOW()',
        [userId]
      );
      return { isBanned: false, reason: null, remainingTime: null };
    }

    return result;
  }, { isBanned: false, reason: null, remainingTime: null });
}

async function validateUserSession(userId, token) {
  if (!userId || !token) {
    return false;
  }

  // strict: Redis 超时/不可用时抛 RedisUnavailableError，
  // 由上层返回 503 而非误判"会话无效"(401)
  return safeRedisExecute(async (client) => {
    const userIdNum = parseInt(userId);
    const tokenKey = `scr:token:${userIdNum}`;
    const sessionToken = await client.get(tokenKey);

    if (!sessionToken) {
      return false;
    }

    if (sessionToken !== token) {
      return false;
    }

    return true;
  }, false, { strict: true });
}

async function getUserSession(userId) {
  return safeRedisExecute(async (client) => {
    const token = await client.get(`scr:token:${userId}`);
    return token ? { token } : null;
  }, null, { strict: true });
}

async function validateIP(req, res, next) {
  try {
    let clientIP = getClientIP(req);

    if (clientIP === '::1') {
      clientIP = '127.0.0.1';
    } else if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.slice(7);
    }

    if (!clientIP) {
      return res.status(403).json({ status: 'error', message: '访问被拒绝' });
    }

    const ipBanResult = await isIPBanned(clientIP);
    if (ipBanResult.isBanned) {
      const banInfo = {
        reason: ipBanResult.reason,
        banUntil: ipBanResult.remainingTime ? new Date(Date.now() + ipBanResult.remainingTime.totalSeconds * 1000) : null
      };

      return res.status(403).json({
        status: 'error',
        message: '您的IP地址已被封禁',
        banInfo: banInfo
      });
    }

    req.clientIP = clientIP;
    next();
  } catch (err) {
    let clientIP = getClientIP(req);
    if (clientIP === '::1') {
      clientIP = '127.0.0.1';
    } else if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.slice(7);
    }
    console.error(`❌ [API] IP验证错误: ${clientIP}, 路径: ${req.path}, 错误: ${err.message}`);
    res.status(500).json({ status: 'error', message: '服务器错误' });
  }
}

const excludedPaths = {
  '*': [
    '/api/health',
    '/api/session-check',
    '/api/admin/',
    '/api/register',
    '/api/login',
    '/api/refresh-token',
    '/api/check-username',
    '/api/verify/challenge',
    '/api/verify/pow-challenge'
  ],
  'GET': [
    '/avatars',
    '/uploads'
  ]
};

async function validateIPAndSession(req, res, next) {
  try {
    let isExcluded = false;

    if (excludedPaths['*']) {
      isExcluded = excludedPaths['*'].some(path => {
        if (path.endsWith('/')) {
          return req.path.startsWith(path);
        }
        return req.path === path || req.path.startsWith(path + '/');
      });
    }

    if (!isExcluded && excludedPaths[req.method]) {
      isExcluded = excludedPaths[req.method].some(path => {
        if (path.endsWith('/')) {
          return req.path.startsWith(path);
        }
        return req.path === path || req.path.startsWith(path + '/');
      });
    }

    if (isExcluded) {
      return next();
    }

    // 仅认证在 app.router 中注册的路由
    const router = (req.app && req.app.router) || (req.app && req.app._router);
    if (router && router.stack) {
      const method = req.method.toLowerCase();
      const isKnownRoute = router.stack.some(layer => {
        if (!layer.route) return false;
        if (!layer.route.methods[method]) return false;
        try {
          return layer.match(req.path);
        } catch {
          return false;
        }
      });

      if (!isKnownRoute) {
        return next();
      }
    }

    let clientIP = getClientIP(req);

    if (clientIP === '::1') {
      clientIP = '127.0.0.1';
    } else if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.slice(7);
    }

    if (!clientIP) {
      return res.status(403).json({ status: 'error', message: '访问被拒绝' });
    }

    req.clientIP = clientIP;

    const userId = req.headers['user-id'] || req.query.userId;
    const sessionToken = req.headers['session-token'] || req.query.sessionToken;

    if (!userId || !sessionToken) {
      return res.status(401).json({ status: 'error', message: '未授权访问' });
    }

    // 仅校验会话 token；IP/账号封禁只在 login、register、refresh-token 接口内检查
    const sessionValid = await validateUserSession(userId, sessionToken);

    if (!sessionValid) {
      return res.status(401).json({ status: 'error', message: '会话无效' });
    }

    req.userId = userId;
    req.sessionToken = sessionToken;

    next();
  } catch (err) {
    // Redis 不可用/超时：会话校验无法完成，不能判定"会话无效"，
    // 返回 503 让前端自动重试，避免压测高峰误杀有效会话
    if (err instanceof RedisUnavailableError) {
      return res.status(503).json({
        status: 'error',
        message: '服务繁忙，请稍后重试',
        retryable: true
      });
    }

    let clientIP = getClientIP(req);
    if (clientIP === '::1') {
      clientIP = '127.0.0.1';
    } else if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.slice(7);
    }
    const userId = req.headers['user-id'] || req.query.userId;
    console.error(`❌ [API] 组合验证错误: ${clientIP}, userId=${userId || 'undefined'}, 路径: ${req.path}, 错误: ${err.message}`);
    res.status(500).json({ status: 'error', message: '服务器错误' });
  }
}

export {
  checkRateLimit,
  getClientIP,
  isIPBanned,
  isUserBanned,
  validateUserSession,
  getUserSession,
  validateIP,
  validateIPAndSession,
  excludedPaths
};

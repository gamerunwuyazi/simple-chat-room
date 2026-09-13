import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const isDev = process.env.NODE_ENV === 'development';

let envPath;
if (isDev) {
  if (fs.existsSync(path.join(process.cwd(), '.env.local.development'))) {
    envPath = path.join(process.cwd(), '.env.local.development');
  } else if (fs.existsSync(path.join(process.cwd(), '.env.development'))) {
    envPath = path.join(process.cwd(), '.env.development');
  }
} else {
  if (fs.existsSync(path.join(process.cwd(), '.env.local'))) {
    envPath = path.join(process.cwd(), '.env.local');
  } else if (fs.existsSync(path.join(process.cwd(), '.env'))) {
    envPath = path.join(process.cwd(), '.env');
  }
}

if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`✅ 已加载${isDev ? '开发环境' : ''}配置文件`);
} else {
  console.log('');
  if (isDev) {
    console.log('⚠️  未检测到 .env.development 或 .env.development.local 配置文件！');
    console.log('⚠️  请复制 .env.development 为 .env.development.local 并填写配置信息');
  } else {
    console.log('⚠️  未检测到 .env 或 .env.local 配置文件！');
    console.log('⚠️  请复制 .env.example 为 .env.local 并填写配置信息');
  }
  console.log('');
  console.log('需要配置以下环境变量:');
  console.log('  - DB_HOST: MySQL数据库地址');
  console.log('  - DB_USER: MySQL用户名');
  console.log('  - DB_PASSWORD: MySQL密码');
  console.log('  - DB_NAME: 数据库名称');
  console.log('  - ADMIN_PASSWORD: 管理员密码');
  console.log('');
  process.exit(1);
}

// ============================================
// 数据库配置
// ============================================
export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  // MySQL 服务器 max_connections=500：主池 150 + 2×worker×15 = 180，留足余量
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 150,
  // 连接耗尽时最多排队的查询数，超过直接报错快速失败（避免无限排队拖垮所有请求）
  // 压测实测 50 连接 + 1000 排队会被瞬间打满报 "Queue limit reached"，扩连接后同步提高排队上限
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT) || 3000,
  // 空闲连接管理：主线程调用频繁、无需健康探测，仅靠客户端主动断开防止连接长期闲置腐化。
  // 注意：mysql2 仅在 maxIdle < connectionLimit 时才启动空闲回收器（base/pool.js），
  // maxIdle 只负责「空闲数超过即裁剪」，超过 idleTimeout 的连接无论数量都会被关闭
  maxIdle: parseInt(process.env.DB_MAX_IDLE) || 100,
  // 空闲 1 小时后由客户端主动断开（远早于 MySQL wait_timeout 默认 8h，杜绝僵尸连接）
  idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT) || 3600000,
  // 连接超时调快（默认 10s）：MySQL 不可达时新连接 3s 即失败，
  // 避免 HTTP 请求在建立连接阶段长时间挂起后才报错
  connectTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT) || 3000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

// ============================================
// 服务器配置
// ============================================
export const serverConfig = {
  port: parseInt(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'production',
  corsOrigin: process.env.CORS_ORIGIN || undefined
};

// ============================================
// Redis 配置
// ============================================
export const redisConfig = {
  url: process.env.REDIS_URL || null,
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB) || 0
};

// ============================================
// Socket.IO WebSocket 配置
// ============================================
export const socketConfig = {
  pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT) || 60000,
  pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL) || 25000,
  connectTimeout: parseInt(process.env.SOCKET_CONNECT_TIMEOUT) || 45000,
  upgradeTimeout: parseInt(process.env.SOCKET_UPGRADE_TIMEOUT) || 30000,
  cors: {
    origin: serverConfig.corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  allowEIO3: true
};

// ============================================
// 速率限制配置
// ============================================
export const rateLimitConfig = {
  shortWindowMs: parseInt(process.env.RATE_LIMIT_SHORT_WINDOW_MS) || 10000,
  shortLimit: parseInt(process.env.RATE_LIMIT_SHORT_LIMIT) || 10,
  longWindowMs: parseInt(process.env.RATE_LIMIT_LONG_WINDOW_MS) || 60000,
  longLimit: parseInt(process.env.RATE_LIMIT_LONG_LIMIT) || 40
};

// ============================================
// 文件上传配置
// ============================================
export const uploadConfig = {
  uploadDir: process.env.UPLOAD_DIR || 'public/uploads',
  avatarDir: process.env.AVATAR_DIR || 'public/avatars',
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 10,
  maxAvatarSizeMB: parseInt(process.env.MAX_AVATAR_SIZE_MB) || 2
};

// ============================================
// 会话配置
// ============================================
export const sessionConfig = {
  expireMinutes: parseInt(process.env.SESSION_EXPIRE_MINUTES) || 20,
  refreshExpireDays: parseInt(process.env.REFRESH_TOKEN_EXPIRE_DAYS) || 7,
  autoLoginExpireMinutes: parseInt(process.env.AUTO_LOGIN_EXPIRE_MINUTES) || 5
};

// ============================================
// 消息配置
// ============================================
export const messageConfig = {
  maxLength: parseInt(process.env.MAX_MESSAGE_LENGTH) || 10000,
  offlineLimits: {
    public: parseInt(process.env.OFFLINE_MESSAGES_LIMIT_PUBLIC) || 3000,
    group: parseInt(process.env.OFFLINE_MESSAGES_LIMIT_GROUP) || 8000,
    private: parseInt(process.env.OFFLINE_MESSAGES_LIMIT_PRIVATE) || 5000
  }
};

// ============================================
// 定时任务配置
// ============================================
export const cronConfig = {
  cleanupSchedule: process.env.CLEANUP_CRON_SCHEDULE || '0 0 2 * * *',
  fileRetentionDays: parseInt(process.env.FILE_RETENTION_DAYS) || 7
};

// ============================================
// 安全配置
// ============================================
export const securityConfig = {
  adminPassword: process.env.ADMIN_PASSWORD
};

// ============================================
// 日志配置
// ============================================
export const logConfig = {
  level: process.env.LOG_LEVEL || 'info'
};

// 兼容性导出（保持向后兼容）
export const ADMIN_PASSWORD = securityConfig.adminPassword;

// 获取 Redis 连接 URL（优先使用完整URL，否则构建）
export function getRedisUrl() {
  if (redisConfig.url) return redisConfig.url;
  
  let url = `redis://`;
  if (redisConfig.password) {
    url += `:${redisConfig.password}@`;
  }
  url += `${redisConfig.host}:${redisConfig.port}`;
  url += `/${redisConfig.db}`;
  
  return url;
}

export default {
  dbConfig,
  serverConfig,
  redisConfig,
  socketConfig,
  rateLimitConfig,
  uploadConfig,
  sessionConfig,
  messageConfig,
  cronConfig,
  securityConfig,
  logConfig,
  ADMIN_PASSWORD,
  getRedisUrl
};

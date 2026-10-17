import {
  createSession,
  verifySession,
  generatePOWChallenge,
  verifyPOWSolution,
  configureSessionStore,
  createRedisSessionStore
} from 'human-verify/backend';
import { redisClient } from '../models/database.js';
import { verifyConfig } from '../config/index.js';

// 集群环境：把验证会话存储切换到 Redis，确保多个 worker 进程共享会话
configureSessionStore(
  createRedisSessionStore({
    get: (key) => redisClient.get(key),
    set: (key, value, ttlMs) => redisClient.set(key, value, { PX: ttlMs }),
    del: (key) => redisClient.del(key)
  })
);

export function setupVerifyRoutes(app) {
  // 1. 创建验证会话（需要前端上报视口尺寸，后端按视口生成全屏透明挑战图）
  app.post('/api/verify/challenge', async (req, res) => {
    try {
      // workers：生图 worker 线程数，由 HUMAN_VERIFY_WORKERS 配置（见 config/index.js）
      const session = await createSession({
        viewport: req.body?.viewport,
        workers: verifyConfig.workers
      });
      res.json(session);
    } catch (err) {
      console.error('创建验证会话失败:', err.message);
      res.status(500).json({ error: '创建验证会话失败' });
    }
  });

  // 2. 行为验证 + POW 挑战
  app.post('/api/verify/pow-challenge', async (req, res) => {
    try {
      const { sessionId, encryptedData } = req.body;

      if (!sessionId || !encryptedData) {
        return res.status(400).json({ error: '缺少必要参数' });
      }

      const result = await verifySession(sessionId, encryptedData);

      if (!result.success) {
        return res.status(400).json({ error: result.error || '会话验证失败' });
      }

      if (!result.passed) {
        return res.json({
          passed: false,
          score: result.score,
          reason: result.reason || '行为验证未通过'
        });
      }

      const pow = await generatePOWChallenge(sessionId);
      res.json({
        passed: true,
        score: result.score,
        details: result.details,
        pow
      });
    } catch (err) {
      console.error('POW 挑战生成失败:', err.message);
      res.status(500).json({ error: 'POW 挑战生成失败' });
    }
  });
}
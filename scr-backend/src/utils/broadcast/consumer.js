// 广播消息消费者
// 每个 Node 进程启动时独立运行一个消费循环：使用普通 XREAD（非 XREADGROUP）阻塞读取
// broadcast_stream，进程之间通过"各自独立的 lastId"实现扇出（所有进程都读全量消息，
// 但只发送给本进程持有的房间客户端）。
//
// 设计要点：
//   1. 不聚合、不丢弃：每条广播消息都会原样扇出（仅排除消息自身发送者），保证正常聊天
//      消息零丢失。压测等高频场景的瞬时突增由 Stream 队列天然削峰。
//   2. 异步解耦：socket.on 回调只做一次极快的 XADD，广播的遍历发送被搬到这里异步执行，
//      不再占用 socket.on 的主事件循环时间片。
//   3. 稳步让出：单个大批次内每发送若干条就 setImmediate 让出一次事件循环（不睡眠、不丢消息），
//      兼顾大房间与进程响应性。批次之间靠 XREAD BLOCK 天然让出。
import { hostname } from 'os';
import { createClient } from 'redis';
import { getRedisUrl } from '../../config/index.js';
import { BROADCAST_STREAM, PROGRESS_KEY_PREFIX } from './constants.js';

const READ_COUNT = 500;           // 每次批量读取条数
const YIELD_EVERY = 200;          // 批次内每发送多少条 setImmediate 让出一次事件循环
const PERSIST_INTERVAL_MS = 2000; // lastId 持久化间隔

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBroadcastConsumer({ io }) {
  // 节点标识：用于独立维护并持久化各自的 lastId（多机/多进程下互不干扰）
  const node = `${hostname()}:${process.pid}${process.env.NODE_ID ? ':' + process.env.NODE_ID : ''}`;
  const progressKey = `${PROGRESS_KEY_PREFIX}:${node}`;

  // 使用独立 Redis 连接执行阻塞 XREAD，避免与业务命令共用连接互相拖累
  const redis = createClient({ url: getRedisUrl() });
  redis.on('error', (err) => console.error('❌ 广播消费者 Redis 错误:', err.message));
  redis.on('ready', () => console.log(`✅ 广播消费者已连接 (${node})，Stream=${BROADCAST_STREAM}`));

  let lastId = '0';
  let running = false;
  let stopping = false;
  let loopPromise = null;
  let persistTimer = null;

  function persistProgress() {
    try {
      if (redis.isReady) return redis.hSet(progressKey, 'lastId', String(lastId)).catch(() => {});
    } catch (e) {
      // ignore
    }
    return Promise.resolve();
  }

  // 向本进程持有该房间的客户端发送单条消息（跳过消息自身发送者）
  async function emitToRoom(room, event, payload, excludeSocketId) {
    let sockets;
    try {
      sockets = io.sockets.adapter.rooms.get(room);
    } catch (e) {
      return;
    }
    if (!sockets || sockets.size === 0) return; // 本进程无该房间客户端，直接丢弃

    let count = 0;
    for (const sid of sockets) {
      if (excludeSocketId && String(sid) === String(excludeSocketId)) continue; // 排除发送者

      const s = io.sockets.sockets.get(sid);
      if (!s || !s.connected) continue;
      try {
        s.emit(event, payload);
      } catch (e) {
        // ignore
      }

      // 大房间内让出事件循环，避免同步连发阻塞（不丢消息）
      if (++count >= YIELD_EVERY) {
        count = 0;
        await new Promise((resolve) => globalThis.setImmediate(resolve));
      }
    }
  }

  async function consumeOnce() {
    const reply = await redis.xRead(
      { key: BROADCAST_STREAM, id: lastId },
      { BLOCK: 0, COUNT: READ_COUNT }
    );
    if (!reply) return;

    // 兼容不同 RESP/返回结构：RESP2 下为对象（key: {key, messages}），数组下为 reply[0]
    const streamData = Array.isArray(reply) ? reply[0] : Object.values(reply)[0];
    const entries = (streamData && (streamData.messages || streamData.elements)) || [];
    if (!entries.length) return;

    // 推进 lastId 为批内最后一条并持久化，重启后从断点继续（避免重复读取）
    lastId = entries[entries.length - 1].id;
    await persistProgress();

    // 逐条扇出，绝不聚合/丢弃
    for (const entry of entries) {
      let msg;
      try {
        msg = JSON.parse(String(entry.message.data));
      } catch (e) {
        continue; // 单条损坏不影响其它
      }
      if (!msg || !msg.room) continue;
      await emitToRoom(msg.room, msg.event || 'message', msg.payload, msg.excludeSocketId);
    }
  }

  async function consumeLoop() {
    while (running && !stopping) {
      if (!redis.isReady) {
        await sleep(1000); // 等待连接就绪 / 自动重连
        continue;
      }
      try {
        await consumeOnce();
      } catch (err) {
        if (!stopping) console.error('❌ 广播消费失败:', err.message);
        await sleep(500);
      }
    }
    running = false;
  }

  async function start() {
    if (running) return;
    running = true;
    stopping = false;
    try {
      await redis.connect();
    } catch (err) {
      console.error('广播消费者 Redis 连接失败:', err.message);
    }
    try {
      lastId = (await redis.hGet(progressKey, 'lastId')) || '0';
    } catch (e) {
      lastId = '0';
    }
    console.log(`📡 广播消费者启动: ${node}，从 lastId=${lastId} 续读`);
    persistTimer = setInterval(() => persistProgress(), PERSIST_INTERVAL_MS);
    if (persistTimer.unref) persistTimer.unref();
    loopPromise = consumeLoop();
  }

  async function stop() {
    stopping = true;
    running = false;
    if (persistTimer) clearInterval(persistTimer);
    try {
      await persistProgress();
    } catch (e) {
      // ignore
    }
    // 阻塞中的 XREAD 无法主动中断，交由进程退出时自然关闭连接
    process.nextTick(() => redis.quit().catch(() => {}));
  }

  return {
    start,
    stop,
    getStatus: () => ({ node, lastId, redisReady: redis.isReady })
  };
}
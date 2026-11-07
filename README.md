# simple-chat-room

一个基于 WebSocket 的实时聊天系统，支持公共聊天、私密聊天和群组聊天功能。

## 技术栈

### 后端
- **运行时**: Node.js 21+
- **框架**: Express 5 + Socket.IO 4
- **数据库**: MySQL 8+（主存储），Redis 7+（会话与在线状态）
- **构建**: esbuild（打包为单文件）

### 前端
- **框架**: Vue 3 + Pinia（状态管理）
- **构建**: Vite 8
- **WebSocket 客户端**: Socket.IO Client

## 功能特性

- 用户注册与登录（支持滑块验证码）
- 公共聊天室（全员消息）
- 私密聊天（一对一）
- 群组聊天（支持创建/加入群组、群管理）
- 文件与图片上传/分享
- 消息引用回复
- @用户 提醒
- 好友系统（添加/删除/搜索）
- 好友验证开关
- 在线状态显示
- 消息离线拉取
- IP 与 API 请求日志审计

## 部署前准备

### 环境要求

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | >= 21 | 运行时环境 |
| MySQL | >= 8.0 | 主数据库 |
| Redis | >= 7.0 | 会话缓存与在线状态 |
| npm | >= 10 | 包管理 |

## 部署步骤

### 1. 克隆项目并安装依赖

```bash
# 后端
cd scr-backend
npm install

# 前端
cd ../scr-web
npm install
```

### 2. 配置环境变量

```bash
cd scr-backend
# 生产环境
cp .env.example .env.local
# 开发环境
cp .env.development .env.development.local
```

编辑对应的 `.env.local`（或 `.env.local.development`），根据实际环境修改以下必填项：

```ini
DB_HOST=localhost          # MySQL 地址
DB_USER=your_user          # MySQL 用户名
DB_PASSWORD=your_password  # MySQL 密码
DB_NAME=your_database      # 数据库名称
ADMIN_PASSWORD=your_admin_pwd  # 管理员密码
```

其余配置项可按需调整（端口、Redis、速率限制等），所有项均有默认值。

> 开发模式下（`npm run dev` / `npm run devbuild`）会自动加载 `.env.development.local`，生产模式下加载 `.env.local`。

### 3. 启动 Redis 和 MySQL

确保 Redis 和 MySQL 服务已运行，且 MySQL 中已创建对应的数据库（无需手动建表，系统启动时会自动创建）。

### 4. 启动后端服务

```bash
cd scr-backend
npm run server
```

后端默认监听端口 **3000**。

#### 多实例连接数预算

多实例部署时，各实例启动时会通过 Redis（`scr:instances`，心跳 60s TTL，崩溃自动出列）感知存活实例数 N，并把 `max_connections - DB_CONN_RESERVE` 的连接预算均摊：N=1 维持默认大池（主池 150 + worker 8），N≥2 时每实例 = `floor(预算/N)`（下限主池 20 / worker 2），显式设置的 `DB_CONNECTION_LIMIT` / `WORKER_DB_CONNECTION_LIMIT` 会被 clamp 到预算内并告警。池限额只在启动时计算（mysql2 池不可热改），运行中扩容实例后需滚动重启以重新分配；相关配置见 `.env.example` 的「多实例连接数预算」段。

### 5. 启动前端（开发模式）

```bash
cd scr-web
npm run dev
```

前端开发服务器默认监听端口 **8080**，访问 `http://localhost:8080` 即可。

### 6. 生产环境构建前端

```bash
cd scr-web
npm run build
```

构建产物输出到 `scr-web/dist/` 目录，可部署到任意静态文件服务器（Nginx 等），并配置反向代理将 `/api`、`/socket.io/` 等路径转发到后端端口。

## 项目结构

```
simple-chat-room/
├── scr-backend/           # 后端服务
│   ├── src/
│   │   ├── config/        # 配置
│   │   ├── middleware/     # 中间件（认证、错误处理、文件上传）
│   │   ├── models/        # 数据库连接
│   │   ├── routes/        # API 路由
│   │   ├── services/      # 业务逻辑
│   │   ├── socket/        # WebSocket 事件处理
│   │   └── utils/         # 工具函数
│   ├── app.js             # 构建产物
│   ├── esbuild.config.mjs # 构建配置
├── scr-web/               # Vue 3 前端
├── LICENSE                # MIT 开源协议
└── README.md              # 本文件
```

## 脚本说明

### 后端

| 命令 | 说明 |
|------|------|
| `npm run build` | 使用 esbuild 打包源码到 app.js（生产模式，压缩） |
| `npm run server` | 构建（生产模式）并启动服务 |
| `npm start` | 直接使用源码启动（不构建） |
| `npm run dev` | 开发模式（构建后监听源码变化自动重启） |
| `npm run devbuild` | 开发构建（仅构建，不压缩，不监听） |
| `npm run lint` | 运行 ESLint 检查代码 |

### 前端

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产环境构建 |

## 常见问题

**Q: 启动时提示"未检测到配置文件"**
A: 请确保已执行 `cp .env.example .env.local` 并填写配置。

**Q: 数据库连接失败**
A: 检查 MySQL 服务是否运行，以及 `.env.local` 中的数据库配置是否正确。

**Q: 前端连接不上后端**
A: 前端通过环境变量 `VITE_SERVER_URL` 配置后端地址（留空代表使用同域），在 `scr-web/.env.local` 中设置。

## 许可证

本项目基于 MIT 许可证开源 - 详见 [LICENSE](LICENSE) 文件。

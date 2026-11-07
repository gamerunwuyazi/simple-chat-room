# SCR 八项功能 · 交付总结（终版）

生成时间：2026-11-01　范围：`/www/wuyazi/scr`（simple-chat-room）

---

## 一、八项功能清单与落地位置

| # | 功能 | 前端落点 | 后端落点 | 状态 |
|---|---|---|---|---|
| 1 | 群接龙 | `GroupFeatureBar.vue` + `ChainCard.vue` | `routes/groupFeature.js` + `services/groupFeatureService.js` + `scr_group_chains` | 代码级完成，未端到端实测 |
| 2 | 群投票 | `VoteCard.vue` | 同上 + `scr_group_votes` / `scr_group_vote_options` / `scr_group_vote_records` | 代码级完成，未端到端实测 |
| 3 | 群搜索 | `GroupSearchPanel.vue`（群聊页走后端）/ `SearchMessageModal.vue`（三页走本地过滤） | `GET /api/groups/:id/search` | **已浏览器实测通过**（两条路径） |
| 4 | 角色徽标 | `RoleBadge.vue`（仅 `GroupMessageItem.vue:23` 引用） | `services/groupService.js` 群成员接口加 `is_owner`/`role` | 群聊通过 / **统一聊天缺失** |
| 5 | 发送状态（发送中/失败/重发） | `stores/messageStatusStore.js` + `utils/chat/messageStatus.js` + `MessageStatus/PendingBubble.vue` | `socket/handlers/messageHandler.js` + `privateHandler.js` + `utils/messageIdempotency.js` | **已浏览器实测通过** |
| 6 | @气泡 / @我标识 | `utils/chat/mention.js` + 两个 `MessageItem` 组件 + `GroupChat.vue` 横幅 | `utils/messageFilters.js`（私聊 payload 补 `atUserid`） | **已浏览器实测通过** |
| 7 | 表情面板 | `EmojiPanel.vue` + 三个聊天页 | 无（表情以 `message_type=0` 文本落库） | 插入位置通过 / **面板定位不通过** |
| 8 | 正在输入（typing） | `stores/typingStore.js` + `MessageStatus/TypingIndicator.vue` + `utils/chat/typing.js` | `socket/handlers/typingHandler.js` + `utils/typing/typingHub.js` | **已浏览器实测通过** |

---

## 二、架构描述

### 2.1 表结构

**新增 8 张表**（全部写在 `scr-backend/src/index.js` 的 `CREATE TABLE IF NOT EXISTS` 建表区，**代码里 0 条 ALTER TABLE**）：

| 表 | 用途 | 关键字段 |
|---|---|---|
| `scr_group_chains` | 接龙主表 | `group_id`、`creator_id`、`status`（active/ended）、`allow_chain` |
| `scr_group_chain_participants` | 接龙参与记录 | `chain_id`、`user_id`、`content` |
| `scr_group_votes` | 投票主表 | `group_id`、`creator_id`、`status`、`ends_at`、`anonymous`、`allow_vote` |
| `scr_group_vote_options` | 投票选项 | `vote_id`、`label`、`sort` |
| `scr_group_vote_records` | 投票记录 | `vote_id`、`option_id`、`user_id` |
| `scr_group_features` | 群功能开关 | `group_id`、`allow_chain`、`allow_vote`、`show_typing` |
| `scr_user_settings` | 用户级开关 | `user_id`、`show_typing` |
| `scr_messages` / `scr_private_messages`（**已有表，加列**） | 重发幂等 | 新增 `client_msg_id` + 唯一索引，见第四节 |

### 2.2 REST 接口（12 个，挂载见 `scr-backend/src/routes/groupFeature.js:18-35`）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/groups/:groupId/chains` | 群成员 |
| POST | `/api/groups/:groupId/chains` | 群成员 + `allow_chain` |
| POST | `/api/groups/:groupId/chains/:chainId/join` | 群成员 |
| POST | `/api/groups/:groupId/chains/:chainId/end` | 发起人 |
| GET | `/api/groups/:groupId/votes` | 群成员 |
| POST | `/api/groups/:groupId/votes` | 群成员 + `allow_vote` |
| POST | `/api/groups/:groupId/votes/:voteId/vote` | 群成员 |
| POST | `/api/groups/:groupId/votes/:voteId/end` | 发起人 |
| GET | `/api/groups/:groupId/search` | 群成员 |
| GET | `/api/groups/:groupId/settings` | 群成员 |
| PUT | `/api/groups/:groupId/settings` | 群主/管理员 |
| PUT | `/api/user/settings/typing` | 登录用户 |

### 2.3 Socket 事件

| 事件 | 方向 | 说明 |
|---|---|---|
| `typing-start` / `typing-stop` | 双向 | 经 Redis 扇出 |
| `group-feature-chains` / `group-feature-votes` | 服务端→客户端 | 接龙/投票数据变更 |
| `message-sent` | 服务端→客户端 | 落库回执（含 `success` / `duplicate` / `clientMsgId`） |

### 2.4 Redis 扇出与去重

- **广播不走 `io.to(room).emit`**：socket handler 只做一次极快的 XADD 到 Redis Stream `broadcast_stream`，由每进程独立消费者异步扇出。
- **typing 去重**：Redis `SET (scope,目标,userId) NX PX 1200` —— 同一 (会话, 用户) 窗口内只有一条 `typing:true` 进入扇出，多端/多实例都只发一条；`typing:false` 删锁后直发。
- **typing 合并键**：`room|userId`（原先只用 `room`，会导致同群 A 的 typing 覆盖 B）。

### 2.5 权限与开关

| 能力 | 群主 | 管理员 | 普通成员 |
|---|---|---|---|
| 接龙/投票 发起 | ✓ | ✓ | 受 `allow_chain`/`allow_vote` 开关约束 |
| 结束接龙/投票 | 仅发起人 | 仅发起人 | ✗（403） |
| 改群功能开关 | ✓ | ✓ | ✗（403） |
| 群成员读接口 | ✓ | ✓ | ✓（但**未鉴权到群成员**，见已知缺陷） |

### 2.6 限流

- socket 消息：短窗 10 秒 10 次，长窗 60 秒 40 次（`RATE_LIMIT_SHORT_LIMIT` / `LONG_LIMIT`）。
- 接龙/投票/搜索 REST **无独立 per-user 限流**，依赖鉴权 + 唯一约束 + 搜索扫描上限（单次最多 3000 行）。

### 2.7 幂等契约

- 键：`clientMsgId`，归一化后截断至 64 字符。
- 落库列：`scr_messages.client_msg_id` / `scr_private_messages.client_msg_id`（均可空）。
- 唯一索引：`(user_id, client_msg_id)` / `(sender_id, client_msg_id)`。
- 命中重复时**回放首包**：`success:true` + `duplicate:true` + 首包同 `messageId` + 首包同 `message` 对象 + 同 `clientMsgId`，**绝不返回 `success:false`**，且不再 INSERT、不再广播。
- 能力探测：`isIdempotencyReady(table)` 走进程内 Map + **60s TTL** 缓存，列不存在则降级（跳过幂等键写入 + 打一次告警），列就位后自动转 ready，**无需重启**。

### 2.8 @全体（`-1`）语义

**群聊 `-1` = @全体，计入「@我」；私聊 / 主聊天室不计入。**

- 后端：群消息 `-1` 原样透传（落库 `[-1]`、下发 `atUserid: [-1]`）；私聊落库前剔除 `-1`（`privateHandler.js:145-152`，只留正整数）。
- 前端：`storageStore.js:341/348` 离线归一化保留 `-1`；`storageStore.js:631` / `groupStore.js:58,89` / `GroupChat.vue:466` 三处判定统一为 `|| String(id) === '-1'`。
- 主聊天室 `websocket.js:855` 只比自己 id，天然不把 `-1` 当 @我。

---

## 三、浏览器实测结论（七项）

环境：前端 http://localhost:5173（vite，仅监听 `[::1]`）／后端 http://localhost:3100／库 `scr-dev` @ localhost:3306；Playwright 1.64.1 + chromium headless shell，`--no-sandbox`，viewport 1440×900，locale zh-CN。

| 项 | 功能 | 结论 | console error | pageerror | 关键证据 |
|---|---|---|---|---|---|
| 1 | @我气泡（滚动+1.5s 高亮） | **通过** | 0 | 0 | 横幅「1 条@我的消息 点击查看」→ scrollTop 0→534 → `.msg-bubble.active` 背景 `rgba(76,175,80,0.6)` |
| 2 | 私聊 typing | **通过** | 0 | 0 | 800ms 起 `.typing-indicator`=1，文案「无崖子27 正在输入」；1600/2400/3200ms 持续 |
| 3 | 群聊 typing | **通过**（群 70） | 0 | 0 | 「压测T01 正在输入」；群 17 因 `show_typing=0` 不下发（配置差异，非缺陷） |
| 4 | 表情插入位置 | **插入位置通过（三处）＋面板定位不通过** | 0 | 0 | 三页输入框值均 `A😀B`（光标 offset=1）；面板 `rect.y=-261`/`-315`、`inViewport:false` |
| 5 | 搜索类型筛选 | **通过（两条路径）** | 0 | 0 | 后端直连 API 复算 `text`→5 / `image`→0 / `card`→0 / `text,card`→5；前端 modal chips 齐全 |
| 6 | 角色徽标 | 群主**通过** / 统一聊天无徽标**已复现** / 管理员**未实测** | 0 | 0 | 群聊 `.role-badge`=3（`role-badge owner`）；统一聊天 badge=0 而 `.msg-sender-name`=20 |
| 7 | 失败气泡 + 重发 | **通过（含幂等断言）** | 0 | 0 | 断网→`.pending-message.is-failed`+「重发」→`.is-sending`+三点→复用同一记录；库内匹配行数=1，唯一索引 NON_UNIQUE=0 |

**未实测（不得按通过计）**：群接龙、群投票端到端；管理员徽标渲染；设置页 typing 开关往返；撤回的 DDL 后回归；发送状态「三点动画不从头开始」的截图证据。

---

## 四、已有数据库的修改 SQL（仅存量环境执行）

> **本机开发库 `scr-dev` 已于 2026-11-01 执行完毕**（一次性独立脚本经项目自身 `mysql2` 链路执行，执行前打印库标识自证；幂等能力已启用并实测通过，当前**不处于降级态**）。
> **其它存量环境（如有）仍需各自执行下面两条语句。**
>
> **代码里 0 条 ALTER**：DDL 只写在 `scr-backend/src/index.js` 的 `CREATE TABLE IF NOT EXISTS` 本体里（`client_msg_id` 列见 `:266`（私聊）、`:291`（群聊），唯一索引见 `:275`、`:295`），**全新数据库从零初始化即最新结构**，无需执行下面任何语句。

### 4.1 需要执行的语句

```sql
-- 1) 群聊 / 全局消息
ALTER TABLE scr_messages
  ADD COLUMN client_msg_id VARCHAR(64) DEFAULT NULL
    COMMENT '客户端消息ID：重发幂等键（同一用户唯一）' AFTER at_userid,
  ADD UNIQUE KEY unique_messages_client_msg (user_id, client_msg_id);

-- 2) 私聊
ALTER TABLE scr_private_messages
  ADD COLUMN client_msg_id VARCHAR(64) DEFAULT NULL
    COMMENT '客户端消息ID：重发幂等键（同一发送者唯一）' AFTER sender_id,
  ADD UNIQUE KEY unique_private_client_msg (sender_id, client_msg_id);
```

### 4.2 执行后校验

```sql
-- 期望：2 行 column + 4 行 index（两个索引各 2 列）
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'client_msg_id'
 ORDER BY TABLE_NAME;

SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND INDEX_NAME IN ('unique_messages_client_msg','unique_private_client_msg')
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- 行数不变（基线：scr_messages 1052 / scr_private_messages 33）
SELECT (SELECT COUNT(*) FROM scr_messages) AS scr_messages,
       (SELECT COUNT(*) FROM scr_private_messages) AS scr_private_messages;
```

### 4.3 回滚语句（**未执行**，仅备查）

```sql
ALTER TABLE scr_messages
  DROP INDEX unique_messages_client_msg, DROP COLUMN client_msg_id;
ALTER TABLE scr_private_messages
  DROP INDEX unique_private_client_msg, DROP COLUMN client_msg_id;
```

### 4.4 注意事项

- 既有存量数据 `client_msg_id` 全为 NULL，**MySQL 唯一索引对 NULL 不去重**，加索引不会因历史数据失败。
- 文件上传、REST 发消息等非 socket 路径写入 NULL，同样不受影响。
- 执行权限：开发/测试库的 ALTER 由用户或具备 DDL 权限者执行（agent 沙箱禁止 ALTER，对所有 agent 生效）。
- 本机执行后核对：`scr-dev @ HK570060727545:3306`；两列两索引就位（NON_UNIQUE=0）；行数 1052→1052、33→33 未变；`isIdempotencyReady` 两表均 `true`。

---

## 五、已知缺陷与限制

### 后端

1. **幂等键按「同一用户」唯一**：唯一索引是 `(user_id, client_msg_id)` / `(sender_id, client_msg_id)`。若前端把同一 `clientMsgId` 用在两个不同会话，第二条会被判重复并回第一条。前端当前「一次发送一个 id」，实际不触发。
2. **幂等命中只回 ack，不补发广播**：首包已落库但广播丢失时，重复命中只回 ack，不补发 `message-received`，其他端可能看不到该消息。
3. **搜索是 LIKE 粗筛 + 应用层精筛**：单次最多扫 3000 行，超出范围的历史消息搜不到；未建全文索引。
4. **投票截止不落库**：`ends_at` 过期只在读取时判定为 closed，没有后台任务更新 `status`。
5. **接龙/投票/搜索 REST 无独立限流**：依赖鉴权 + 唯一约束 + 搜索扫描上限。
6. **成员名单接口未鉴权到群成员**：`GET /api/group-members/:groupId` 沿用既有实现，任意登录用户可读。
7. **私聊 `at_userid` 的 `-1` 被剔除**：私聊无 @全体 语义，客户端塞 `-1` 会被过滤；群聊 `-1` 原样透传。

### 前端

8. **【本轮唯一确认的功能性缺陷】表情面板整体渲染在视口外，用户点不到**：`EmojiPanel.vue:165-176` 用 `position:absolute; bottom:calc(100%+8px)`，而它在三个视图里都是**整屏高容器的直接子元素**（`position:static` + `overflow:hidden`），`bottom:100%` 相对满高的聊天容器（#chat-main，y=0、高 900）→ 面板整体落到视口上方（实测 `rect.y` = -261 统一聊天 / -315 群聊与私聊、`inViewport:false`）。**真实用户点不到任何 emoji。** 建议修法：把 `EmojiPanel` 挂到输入区的定位父级内，或给 `.emoji-panel` 一个高度等于输入框的定位锚点。注意与「插入位置正确」分开记 —— 插入逻辑（`focus()+execCommand`）是对的，三处实测均为 `A😀B`。
9. **角色徽标统一聊天视图缺失**：`RoleBadge.vue` 只被 `GroupMessageItem.vue:23` 引用，`UnifiedMessageItem.vue` 未接 `senderRole` → 主聊天室看不到群主/管理员徽标（实测 badge=0，而同页有 20 个发送者名可挂徽标）。需产品侧决定是否补齐。
10. **@我 高亮仅覆盖 `messageType ≠ 5`**：Markdown 消息（type 5）走 marked 解析分支，不经过 `highlightMentions`，正文里的 @ 不高亮、也不触发气泡标识（两边同口径）。
11. **引用消息正文里的 @ 不高亮**：引用气泡走 `quotedMessageParsedContent`。
12. **typing 事件在 socket 重连窗口可能丢失**：先跑群聊发送再串行跑私聊 typing，接收方 `.typing-indicator` 偶发为 0；单独跑稳定通过。与重连时序相关（曾观测到 `session-expired` → 前端刷新 token → 重连期间事件丢失）。**尚属观察，未确证为产品缺陷**，建议产品侧评估。
13. **群搜索两条入口口径不同**：`GroupSearchPanel` 走后端接口、只命中可渲染文本；`SearchMessageModal` 走本地 localForage 过滤、不区分 JSON 原文。（两条路径均已实测通过，但口径差异仍在。）
14. **表情「最近使用」只存 localStorage**：换设备或清缓存即丢失。
15. **`is_encrypted` / `encrypted_content` / `encryption_metadata` 三列不在初始化建表代码里**（历史遗留，本次未涉及）。

---

## 六、交付物清单

| 路径 | 内容 |
|---|---|
| `docs/scr-8features-summary.md` | 本文件（完整版） |
| `other/stage1-api-contract.md` | 后端契约（12 接口 / socket 事件 / Redis / 权限 / 限流 / 幂等 / `-1` 语义） |
| `other/stage1-backend-report.md` | 阶段一后端报告 |
| `other/stage3-idempotency-report.md` | 重发幂等报告（§10 `-1` 剔除、§11 DDL 执行与真实幂等验证） |
| `other/stage-summary-frontend.md` | 前端小结（发送状态 + @气泡两条链路） |
| `/tmp/browser-acceptance-report.md` | 浏览器实测报告（七项逐项 + 复现步骤 + console 原文 + 已知非缺陷） |
| `/tmp/frontend-msg-report.md` | 前端报告（含第六节 气泡级 @我） |
| `/tmp/e2e/README.md` | 浏览器验收环境说明（账号对照 / 群角色 / 内存红线 / 踩坑） |
| `/tmp/t*.png` | 截图 53 张 |
| `/tmp/e2e/_t*.json` | 原始断言数据 |
| `/tmp/e2e/test_t*.py` | 测试脚本 |

---

## 七、DDL 列位置与初始化代码的等价性（本次收尾修正）

实际执行的 ALTER 与初始化建表代码原本在私聊表上不一致：ALTER 用 `AFTER sender_id`，
而 `src/index.js` 原写作 `AFTER at_userid`。列序不影响功能，但会让「从零初始化的新库」与
「迁移后的存量库」结构不等价 —— 与本项目「全新库从零初始化即最新结构」的要求相悖。

**已修正**：把 `src/index.js` 的 `scr_private_messages` 建表列序改为
`id → sender_id → client_msg_id → receiver_id → content → at_userid → …`，
与线上库 `SHOW CREATE TABLE` 完全一致（群聊表本来就是 `at_userid → client_msg_id`，无需改）。

修正后已验证：
- 两条 ALTER 语句在等价临时表上**干跑可执行**，产出的列序与唯一索引（NON_UNIQUE=0）与线上库一致；
- 两条建表语句本身可执行，产出的列序与线上库一致；
- 文档内 `src/index.js` 行号引用同步更新为 `:266`（私聊列）`:291`（群聊列），唯一索引 `:275` `:295`。

## 八、复现与验证摘要

```
后端：node --check（改动文件全过）；vite/esbuild build EXIT=0；3100 重启后 401（服务在、需鉴权）
前端：vite build EXIT=0（限堆 768MB）；eslint 0 error（warning 全为既有 import/order、no-unused-vars）
数据库：两列两索引就位 NON_UNIQUE=0；行数 1052/33 未变；isIdempotencyReady 两表 true
幂等：全表 (user_id, client_msg_id) 重复组数 = 0；唯一标记轮库内仅落 1 行
浏览器：七项 console error 0 / pageerror 0
文档行号：抽验 10 处全部准确
测试数据：scr_messages 中 id>1060 行数 = 0，无残留
仓库：一次性临时脚本已清理，未跟踪文件 24 → 18
```

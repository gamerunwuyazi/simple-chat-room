# SCR 八项功能 · 最终架构总结

日期：2026-11-01　仓库：`/www/wuyazi/scr`（后端 `scr-backend/`，前端 `scr-web/`）

## 0. 范围与材料来源

| 需求 | 归属 | 主要实现位置 |
| --- | --- | --- |
| 1 群接龙 | 后端 + 前端功能工程师 | `scr-backend/src/services/groupFeatureService.js`；`scr-web/src/components/GroupFeature/{GroupFeatureBar,ChainCard,CreateChainModal}.vue` |
| 2 群投票 | 后端 + 前端功能工程师 | 同上 + `{VoteCard,CreateVoteModal}.vue` |
| 3 群搜索 | 后端 + 前端功能工程师 | `groupFeatureService.js:841`；`scr-web/src/components/GroupFeature/GroupSearchPanel.vue`、`components/SearchMessageModal.vue` |
| 4 角色徽标 | 后端 + 前端功能工程师 | `scr-backend/src/services/groupService.js:535`；`scr-web/src/components/MessageItem/RoleBadge.vue` |
| 5 发送状态（发送中/失败/重发） | 前端消息工程师 | `scr-web/src/stores/messageStatusStore.js`、`utils/chat/messageStatus.js`、`components/MessageStatus/PendingBubble.vue` |
| 6 @气泡 / @我标识 | 前端消息工程师 + 后端口径 | `scr-web/src/utils/chat/mention.js`；后端 `scr-backend/src/utils/messageFilters.js:66` |
| 7 表情面板 | 前端功能工程师 | `scr-web/src/components/EmojiPanel.vue` |
| 8 正在输入（typing） | 后端 + 前端功能工程师 | `scr-backend/src/utils/typing/{typingCache,typingHub}.js`、`socket/handlers/typingHandler.js`；`scr-web/src/utils/chat/typing.js` |

配套材料：
- 后端契约（唯一权威口径）：`/www/wuyazi/scr/other/stage1-api-contract.md`
- 后端交付报告：`/www/wuyazi/scr/other/stage1-backend-report.md`、`/www/wuyazi/scr/other/stage3-idempotency-report.md`
- 前端小结：`/www/wuyazi/scr/other/stage-summary-frontend.md`、`/tmp/frontend-msg-report.md`、`/tmp/stage3-design.md`
- 浏览器实测报告：`/tmp/browser-acceptance-report.md`（测试环境工程师产出，2026-11-01 13:44~14:25 完成；本文已按其结论回写「浏览器实测回写」「未实测项清单」「已知缺陷与限制」三节）

行号说明：本文所有行号均以 2026-11-01 当前工作区为准（`grep -n` / `sed -n` 实测），后续改动可能导致漂移。

---

## 1. 群接龙

### 做了什么
- 后端建表：`scr_group_chains`（表头：标题/说明/发起人/结束时间）、`scr_group_chain_entries`（参与条目，唯一约束 `unique_chain_entry(chain_id,user_id)` 保证一人一条）。
- 4 个 REST 接口：列表 / 发起 / 参与 / 结束。发起权限 = 群成员 且 `scr_groups.allow_chain=1`；群主/管理员不受开关限制。结束权限 = 发起人或群主/管理员。
- 实时扇出：`group-chain-created` / `group-chain-updated`，走 Redis Streams（room `group_<groupId>`），前端按 id upsert 合并，不整列表重拉。
- 前端：`GroupFeatureBar.vue` 提供 tab 入口与权限显隐，`ChainCard.vue` 渲染卡片，`CreateChainModal.vue` 负责发起。

### 改了哪些文件
后端（`/www/wuyazi/scr/scr-backend/`）：
- `src/index.js:321`（`scr_group_chains` 建表）、`:337`（`scr_group_chain_entries` 建表）
- `src/services/groupFeatureService.js:119` `getGroupChains`、`:152` `createGroupChain`、`:198` `joinGroupChain`、`:249` `closeGroupChain`
- `src/services/groupFeatureService.js:188`（`group-chain-created` 扇出）、`:239`、`:277`（`group-chain-updated` 扇出）
- `src/routes/groupFeature.js:18-21`（4 条路由挂载）
- `src/routes/index.js:6`（import）、`:19`（`setupGroupFeatureRoutes(app)`）

前端（`/www/wuyazi/scr/scr-web/`）：
- `src/components/GroupFeature/GroupFeatureBar.vue`（389 行）、`ChainCard.vue`（224 行）、`CreateChainModal.vue`
- `src/api/groupFeatures.js:9` `getChains`、`:13` `createChain`、`:17` `joinChain`、`:21` `closeChain`
- `src/composables/useGroupFeatures.js:35` `useGroupFeatures`、`:67-68`（并发拉 chains/votes）、`:173`（订阅 4 个 socket 事件）
- `src/views/GroupChat.vue:58`（`<GroupFeatureBar>` 挂载）、`:375`（import）

### 怎么验的
- 代码级：`node --check` 全部 0 退出；接口形状对 3100 实测校准（`chains[]{...,joined}`）；权限分支逐条读码核对（普通成员被 `allow_chain=0` 拦 403，管理员不受限）。
- 浏览器实测：**未做**（本轮七项浏览器验收不含群接龙；见「未实测项清单」A1/B6）。

### 已知缺陷与限制
- 接龙内容上限 1000 字、标题 100 字，超出返回 400（`groupFeatureService.js:163`）。
- 参与接龙不校验群开关（`allow_chain` 只管发起），符合设计但需在 UI 上说清。

---

## 2. 群投票

### 做了什么
- 后端建表：`scr_group_votes`（表头，含 `multiple` 多选、`anonymous` 匿名、`status` open/closed、`ends_at` 截止）、`scr_group_vote_options`（选项 + 排序）、`scr_group_vote_records`（投票记录，唯一约束 `unique_vote_record(vote_id,option_id,user_id)`）。
- 4 个 REST 接口：列表 / 发起 / 投票 / 结束。发起权限 = 群成员 且 `allow_vote=1`（管理员不受限）；允许改票（先删旧记录再写），提交与已投完全相同的选项集合返回 409。
- 匿名投票不返回投票人明细，只给计数与 `totalVoters`。
- 实时扇出：`group-vote-created` / `group-vote-updated`，同样走 Redis Streams 分片。

### 改了哪些文件
后端：
- `src/index.js:352`（`scr_group_votes`）、`:371`（`scr_group_vote_options`）、`:382`（`scr_group_vote_records`）
- `src/services/groupFeatureService.js:387` `getGroupVotes`、`:409` `createGroupVote`、`:505` `submitVoteBallot`、`:596` `closeGroupVote`
- `src/services/groupFeatureService.js:495`、`:586`、`:623`（投票事件扇出）
- `src/routes/groupFeature.js:24-27`（4 条路由）

前端：
- `src/components/GroupFeature/VoteCard.vue`（343 行）、`CreateVoteModal.vue`
- `src/api/groupFeatures.js:26` `getVotes`、`:30` `createVote`、`:41` `submitBallot`、`:45` `closeVote`
- `src/composables/useGroupFeatures.js:3-9`（API 引入）、`:173`（订阅投票事件）

### 怎么验的
- 代码级：接口形状对 3100 实测校准（`votes[]{...,totalVoters,myOptionIds,options[]{id,label,sort,count,voters}}`）；`node --check` 全绿；事务边界（投票记录增删在一个事务内）读码核对。
- 浏览器实测：**未做**（本轮七项浏览器验收不含群投票；见「未实测项清单」A2/B6）。

### 已知缺陷与限制
- 投票截止时间 `ends_at` 只在读取时判定为 closed，没有后台任务把 `status` 落库改成 closed（`groupFeatureService.js:296-315`）。
- 选项最多 20 个、最少 2 个，超限返回 400。

---

## 3. 群搜索

### 做了什么
- 后端 `GET /api/groups/:groupId/search?keyword=&types=&limit=`，权限 = 群成员。
- 关键口径：**只命中用户可见的可渲染文本**，绝不返回 JSON 原文。SQL 只做 `content LIKE` 粗筛（上限 3000 行），随后按消息类型逐类提取可渲染文本再精筛：
  - 纯文本（type 0/5）：原样返回，但若 content 是 JSON 对象/数组字符串则直接跳过（否则搜 `quoted`/`userId` 会命中键名）；
  - 图片（1）：固定 `[图片]`；文件（2）：`name`；群名片（3）：`group_name`；视频（6）/音频（7）：`name`；引用（4）：引用者自己写的 `text` + 被引用消息的可渲染文本。
- 类型参数 `types` 直接映射后端 `SEARCH_TYPES`：text=[0,4,5]、image=[1]、file=[2]、card=[3]、video=[6]、audio=[7]。
- 前端两条入口：`GroupSearchPanel.vue`（走后端接口，群聊页）与 `SearchMessageModal.vue`（多选 chip，本地消息过滤）。

### 改了哪些文件
后端：
- `src/services/groupFeatureService.js:754`（`SEARCH_TYPES`）、`:791` `extractSearchText`（`:794-801` 纯文本 JSON 拦截）、`:841` `searchGroupMessages`
- `src/routes/groupFeature.js:30`（路由）

前端：
- `src/components/GroupFeature/GroupSearchPanel.vue`（323 行）：`:59` import 后端搜索、`:78` `selectedTypes`、`:108-110` 发起搜索
- `src/components/SearchMessageModal.vue:97` `SEARCH_TYPE_OPTIONS`、`:106` `selectedTypes`、`:151` `emit('search', keyword, types)`
- `src/api/groupFeatures.js:67` `searchGroupMessages`（`:71` types 逗号拼接）
- `src/views/GroupChat.vue:164`（`GroupSearchPanel` 挂载）、`:376`（import）

### 怎么验的
真实库冒烟（群 17 / 用户 1，临时脚本已删）：
```
{ "keyword": "群组", "quotedTotal": 0, "userIdTotal": 0, "realTotal": 5,
  "realFirstText": "111 群组17测试：今天的消息", "pass": true }
```
即：搜 JSON 键名 `quoted`/`userId` 命中 0 条，搜真实文本命中 5 条。

### 已知缺陷与限制
- 粗筛是 `LIKE`，单次最多扫 3000 行（`SEARCH_SCAN_LIMIT`，`groupFeatureService.js:25`），超出范围的历史消息搜不到；未做全文索引。
- 前端 `SearchMessageModal` 走本地 localForage 过滤、不经后端接口；群聊页的 `GroupSearchPanel` 才走后端接口，两条入口结果口径不同（本地过滤不区分 JSON 原文）。

---

## 4. 角色徽标

### 做了什么
- 后端 `GET /api/group-members/:groupId` 增加两个字段：`is_owner`（布尔）与 `role`（`owner`/`admin`/`member`）。判定顺序：群主（`scr_groups.creator_id`）> 管理员（`scr_group_members.is_admin=1`）> 普通成员。前端不必再自己比对 `creator_id`。
- 前端 `RoleBadge.vue` 胶囊徽标：群主橙（`#b45309` on `#fef3c7`）、管理员蓝（`#1d4ed8` on `#e0edff`），位置在昵称后、时间前，自己发的消息不显示。

### 改了哪些文件
后端：
- `src/services/groupService.js:535` `getGroupMembers`（`:556` 角色注释、`:565` `is_owner`、`:566` `role`）

前端：
- `src/components/MessageItem/RoleBadge.vue`（45 行）：`:12` role 取值校验、`:16` 文案映射、`:34` `.role-badge.owner`、`:40` `.role-badge.admin`
- `src/components/MessageItem/GroupMessageItem.vue:23`（唯一引用点）、`:121`（import）

### 怎么验的
真实库调用 `getGroupMembers(17)`：
```
{ "memberRoles": [
    { "id": 1, "is_admin": 0, "is_owner": true,  "role": "owner" },
    { "id": 3, "is_admin": 0, "is_owner": false, "role": "member" },
    { "id": 2, "is_admin": 0, "is_owner": false, "role": "member" } ],
  "pass": true }
```
（群 17 的群主是 user1，与 `scr_groups.creator_id` 一致）

### 已知缺陷与限制
- **统一聊天视图（UnifiedChat / 主聊天室）没有角色徽标**：`RoleBadge` 只在 `GroupMessageItem.vue:23` 被引用，主聊天室的 `UnifiedMessageItem.vue` 没有接入。
- `getGroupMembers` 未强制要求调用者是群成员（沿用既有实现），成员名单对任意登录用户可见。

---

## 5. 发送状态（发送中 / 失败 / 重发）

### 做了什么
- 核心修正：气泡去留的判据从「status」改成「**messageId 是否已渲染**」。原因：ack（服务端确认）与真实消息进渲染列表之间存在空档——`groupStore.addGroupMessage` 在 `baseStore.loading` 为真时写的是 `storageStore.getCacheGroup()`（`stores/groupStore.js:27-29`），不进渲染列表；原实现一收到 `sent` 就撤气泡，中间空一帧，列表刷新时尤其明显。
- 三态：`sending`（三点动画）/ `failed`（感叹号，可点重发）/ 成功（动画消失、节点不残留）。重发复用同一个 `clientMsgId`，后端据此幂等（见第 8 项与「已知缺陷」里的幂等契约）。
- 列表刷新不重置动画：列表项 `:key` 仍是 `clientMsgId`，节点不重建；真实 id 渲染出来后才按 messageId 精确清理记录。

### 改了哪些文件
前端：
- `src/stores/messageStatusStore.js:90` `listVisible(scope, targetId, renderedIds)`、`:104` `pruneRendered(scope, targetId, renderedIds)`、`:132-133`（导出）
- `src/utils/chat/messageStatus.js:9` `ACK_KEEP` 由 5000 提到 15000（只作兜底清理）、`:126-130`（兜底定时器与注释）
- `src/components/MessageStatus/PendingBubble.vue:8`（`v-if="status !== 'failed'"`，只有失败态才出重发按钮）、`:2`（根节点按 `status` 切 `is-failed`/`is-sending`）
- `src/views/GroupChat.vue:564`（`groupMessageIds`）、`:565-568`（`pendingMessages` 改用 `listVisible`）、`:570-572`（watch 触发 `pruneRendered`）
- `src/views/PrivateChat.vue:293`、`:294-297`、`:299-301`
- `src/views/UnifiedChat.vue:333`、`:334-336`、`:337-339`

后端配合：
- `scr-backend/src/socket/handlers/messageHandler.js:100-108`（ack 原样回带 `clientMsgId`）
- `scr-backend/src/socket/handlers/privateHandler.js:20-28`（私聊 ack 回带 `clientMsgId`，此前缺失）
- `scr-backend/src/utils/messageIdempotency.js:24` `normalizeClientMsgId`（截断 64 字符）

### 怎么验的
逻辑自测（pinia 直接驱动 store，脚本已删）6 行全过，关键两行：
```
2 sent,not-yet [ 'c1:sent', 'c2:sending' ]   ← 已送达但列表还没有 id=101，气泡仍在
3 sent,rendered[ 'c2' ]                     ← id=101 渲染出来，气泡撤
```
构建与 lint：`vite build --outDir /tmp/scr-web-build-msg` → `EXIT=0`；eslint → `0 errors`（warnings 全为既有 import/order、no-unused-vars）。
后端回执：`private-message-sent` 错误分支实测回带 `clientMsgId`：
```
{ "event": "private-message-sent", "success": false, "code": "INVALID_CONTENT",
  "clientMsgId": "c-test-001", "pass": true }
```

### 已知缺陷与限制
- **浏览器实测已通过**（2026-11-01）：失败气泡 `.pending-message.is-failed` + `.pending-failed`「重发」、发送中 `.is-sending` + `.pending-dot` 三点、重发后库内仅 1 行且全表无 `(user_id, client_msg_id)` 重复组（幂等生效）。详见浏览器实测报告第 7 项。
- 限堆到 768MB 才能构建成功（不限堆被 OOM killer 杀掉，exit 137），属环境问题。

---

## 6. @气泡 / @我标识

### 做了什么
- 高亮机制：`utils/chat/mention.js` 的 `highlightMentions` 只对**已转义**的纯文本做标记，用完整 class 串 `at-mention at-mention-self`（`mention.js:52`），不用 `at-mention-self` 子串——否则用户正文里恰好写「at-mention-self」字样会被误判成 @我。
- 气泡级标识：消息根节点加 `is-mention-me` class，CSS 给气泡加左边框 + 淡底（群聊琥珀色、主聊天室蓝色，刻意区分）。
- 「N 条@我的消息」气泡：群聊页统计 `atUserid` 含当前用户 id 或 `-1` 的消息，按 id 水位持久化到 localStorage，点击滚动定位 + 1.5s 高亮后推进水位。
- 后端配套：`atUserid` 字段补齐与口径统一（见下）。

### 改了哪些文件
前端：
- `src/utils/chat/mention.js:26` `highlightMentions`、`:52` class 判定
- `src/components/MessageItem/UnifiedMessageItem.vue:13`（class）、`:129`（import）、`:542-553` `mentionNicknames`、`:554-566` `selfNicknames`、`:568-573` `applyMentionHighlight`、`:589`（非 Markdown 分支走高亮）、`:705-708` `isMentionMe`、`:969`/`:976`（CSS）
- `src/components/MessageItem/GroupMessageItem.vue:13`（class）、`:701` `applyMentionHighlight`、`:721`（调用点）、`:834-838` `isMentionMe`、`:1109`/`:1116`（CSS）
- `src/views/GroupChat.vue:55`（「N 条@我的消息」文案）、`:458` `isAtMeMessage`、`:469` `atMeMessages`、`:491`（滚动定位）
- `src/stores/storageStore.js:341`、`:348`（归一化保留 `-1`）、`:627-633`（离线 @我 判定补 `|| String(id) === '-1'`）

后端：
- `scr-backend/src/utils/messageFilters.js:66-71`（私聊消息 payload 补 `atUserid`，此前私聊实时消息丢 @ 数据）
- `scr-backend/src/services/messageService.js:113`、`:252`（历史消息同时返回驼峰 `atUserid`，下划线 `at_userid` 保留兼容）
- `scr-backend/src/workers/messageWorker.js:142`、`:273`（同上，worker 是实际生效的拉取路径）
- `scr-backend/src/socket/handlers/messageHandler.js:865`（私聊历史补 `atUserid`）
- `scr-backend/src/socket/handlers/privateHandler.js:147-151`（私聊落库前剔除 `-1`，私聊无 @全体 语义）

### 怎么验的
- 判定口径不误伤（node 直跑 mention.js）：
```
普通 @                    => hit=false
@我                      => hit=true
正文含 at-mention-self 字样 => hit=false
```
- 历史消息键名修复（真实库，临时插入带 `at_userid='[2]'` 的群消息，走 worker 拉取后删除）：
```
{ "insertedId": 1058, "found": true, "atUserid": [2], "at_userid": [2], "cleaned": true, "pass": true }
```
- 私聊剔除 `-1`：输入 `at_userid: [-1,2]` → `{ "storedAtUserid": "[2]", "ackAtUserid": [2], "pass": true }`；群聊 `[-1]` → `{ "storedAtUserid": "[-1]", "ackAtUserid": [-1], "pass": true }`。
- `-1` 口径：群聊 `-1` = @全体，**计入**「@我」（与在线路径与 QA 已验计数一致）；私聊/主聊天室不计入。三条路径（实时 / socket 历史 / 离线）已统一。

### 已知缺陷与限制
- **@我 高亮仅覆盖 `messageType ≠ 5`**：Markdown 消息（type 5）走 marked 解析分支，不经过 `highlightMentions`，正文里的 @ 不高亮（群聊 `GroupMessageItem.vue:708-721` 的非 Markdown 分支才调高亮）。要覆盖需在 marked 产物上再跑一次高亮，存在代码块内误高亮风险，未做。
- **引用消息正文不参与 @我 判定**：引用气泡那段纯文本走 `quotedMessageParsedContent`（`GroupMessageItem.vue:519`），与主聊天室同口径，引用里的 @ 不高亮。
- 主聊天室的 @ 候选昵称取自在线用户列表（`UnifiedMessageItem.vue:542-553`），离线成员不在其中。

---

## 7. 表情面板

### 做了什么
- `EmojiPanel.vue`：绝对定位在输入区上方，点击外部关闭；上栏「最近使用」（localStorage `emoji:recent`，最多 20 个，无记录时整栏隐藏），下栏「全部」网格可滚。
- 插入方式：按钮 `@mousedown.prevent` 保住 contenteditable 光标/选区，父组件用 `document.execCommand('insertText')` 插到光标处；不重建 socket、不上传、不触发发送。
- 三个会话页统一挂载（GroupChat / PrivateChat / UnifiedChat），图标与交互同构。

### 改了哪些文件
前端：
- `src/components/EmojiPanel.vue`（234 行）：`:8` 最近使用栏、`:46` `maxRecent`（默认 20）、`:51` `STORAGE_KEY = 'emoji:recent'`、`:77` `recent`、`:94` 写入、`:101` 去重前插
- `src/views/GroupChat.vue:126`（表情按钮）、`:162`（`EmojiPanel` 挂载）、`:377`（import）
- `src/views/PrivateChat.vue:135`（挂载）、`:233`（import）、`:332` `insertPrivateEmoji`
- `src/views/UnifiedChat.vue:134`（挂载）、`:286`（import）

后端：**无改动**。表情以普通文本（`message_type=0`）发送，落到 `scr_messages.content`，随消息搜索/收藏链路复用。

### 怎么验的
- 代码级：组件编译通过、eslint 0 error、`vite build` EXIT=0；「最近使用」读写与去重逻辑读码核对。
- 浏览器实测：**插入位置已通过**（三处输入框值均为 `A😀B`）；**「面板可点击性」不通过** —— 面板整体渲染在视口外（`rect.y=-261`/`-315`、`inViewport:false`），真实用户点不到 emoji。详见浏览器实测报告第 4 项与「已知缺陷与限制」第 18 条。

### 已知缺陷与限制
- 「最近使用」只存 localStorage，换设备/清缓存即丢失（无服务端同步）。
- emoji 走普通文本消息，因此会命中消息长度限制（10000 字符）。

---

## 8. 正在输入（typing）

### 做了什么
三层防抖 + Redis 分片扇出：
1. 前端节流：同一会话 1500ms 最多发一次 `typing-start`，4s 无输入自动发 `typing-stop`；用户开关关闭后不再发。
2. 服务端去重：`SET NX PX 1200` 按 **(scope, 目标, 用户)** 抢发布令牌（Redis 键 `scr:typing:throttle:<scope>:<target>:<userId>`），同一用户多端/多实例 1.2s 内只发布一条；`typing:false` 先删令牌再发，保证停止状态不被窗口吞掉。
3. 扇出合并：Redis pub/sub 频道 `scr:typing:group:<groupId>` / `scr:typing:user:<userId>`，各进程按 **(房间, 用户)** 做 2s 合并——同群不同用户的 typing 互不覆盖（合并键是 `room|userId`）。
- 状态 TTL 5s（`scr:typing:group:<gid>:<uid>` / `scr:typing:private:<toUid>:<uid>`），服务端不主动补发 `typing:false`，由客户端 5s 本地超时兜底。
- 开关：用户级 `scr_users.show_typing`（默认 1）、群级 `scr_groups.show_typing`（默认 0），改动后立即失效对应 Redis 缓存。

### 改了哪些文件
后端：
- `src/utils/typing/typingHub.js:16` `COALESCE_MS = 2000`、`:55`（合并键 `room|userId`）
- `src/socket/handlers/typingHandler.js:18` `PUBLISH_THROTTLE_MS = 1200`、`:21-22`（键命名）、`:26` `acquirePublishSlot`、`:39` `releasePublishSlot`、`:93-94`（false 先删令牌 / true 抢令牌）
- `src/utils/typing/typingCache.js`（缓存读取与失效，未改逻辑）
- `src/socket/index.js:197-198`（`createTypingHub` + `typingHub.start()`）
- `src/socket/events.js:42-44`（`typing-start`/`typing-stop`/`typing-update`）
- `src/services/groupFeatureService.js:635` `getGroupFeatureSettings`、`:666` `updateGroupFeatureSettings`、`:727` `updateUserTypingSetting`
- `src/routes/groupFeature.js:33-35`（设置与个人 typing 开关路由）

前端：
- `src/utils/chat/typing.js:5` `THROTTLE = 1500`、`:6` `IDLE_STOP = 4000`、`:34` `typingSetting`、`:40` `setTypingSetting`、`:79`（emit）、`:85-99` `notifyTyping`
- `src/stores/typingStore.js`（72 行，typing 状态集中管理）
- `src/views/UserSettings.vue:11`（import）、`:122`（设置项分支）、`:139-140`（同步后端）、`:630`/`:636`（开关 UI）
- `src/components/Sidebar/SettingsSidebar.vue:50`（设置入口）

### 怎么验的
- 合并不互相覆盖（假 io + 真实 Redis pub/sub，两个本地 socket）：
```
{ "afterTwoUsers": [9001, 9002], "s2Count": 4,
  "user9003Deliveries": [true, false], "pass": true }
```
同群两个用户同一 2s 窗口各发一条 → 两条都送达；同一用户连发 true/true/false → 只 1 条 true + 最终 1 条 false。
- 跨 socket 去重（两个 socket 代表同一用户）：
```
{ "publishes": [ {"userId":3,"typing":true,"scope":"private"},
                 {"userId":3,"typing":false,"scope":"private"} ], "pass": true }
```
两个 socket 的 `typing-start` 只产生 1 次发布，`typing-stop` 不被节流吞掉。
- 浏览器实测：**已通过**（私聊接收侧 800/1600/2400/3200ms 均显示「无崖子27 正在输入」；群聊在群 70 显示「压测T01 正在输入」；console/pageerror 均 0）。详见浏览器实测报告第 2/3 项。

### 已知缺陷与限制
- typing 双端联调未验；服务端不补发 `typing:false`，完全依赖客户端本地超时。
- 群级开关默认关闭（`scr_groups.show_typing` 默认 0），需群主/管理员显式打开。

---

## 9. 后端契约速查（12 接口 / socket 事件 / Redis / 权限 / 限流 / 幂等）

完整字段与错误码见 `/www/wuyazi/scr/other/stage1-api-contract.md`（唯一权威口径），此处为速查。

### 9.1 12 个 REST 接口（挂载见 `scr-backend/src/routes/groupFeature.js:18-35`）
| # | 方法 | 路径 | 实现 | 权限 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/groups/:groupId/chains` | `groupFeatureService.js:119` | 群成员 |
| 2 | POST | `/api/groups/:groupId/chains` | `:152` | 群成员 + `allow_chain`（管理员不受限） |
| 3 | POST | `/api/chains/:id/join` | `:198` | 群成员（一人一次） |
| 4 | POST | `/api/chains/:id/close` | `:249` | 发起人或管理员 |
| 5 | GET | `/api/groups/:groupId/votes` | `:387` | 群成员 |
| 6 | POST | `/api/groups/:groupId/votes` | `:409` | 群成员 + `allow_vote`（管理员不受限） |
| 7 | POST | `/api/votes/:id/ballot` | `:505` | 群成员（可改票） |
| 8 | POST | `/api/votes/:id/close` | `:596` | 发起人或管理员 |
| 9 | GET | `/api/groups/:groupId/search` | `:841` | 群成员 |
| 10 | GET | `/api/groups/:groupId/settings` | `:635` | 群成员 |
| 11 | PUT | `/api/groups/:groupId/settings` | `:666` | 群主/管理员 |
| 12 | PUT | `/api/user/settings/typing` | `:727` | 本人 |

鉴权：HTTP 头 `user-id` + `session-token`；socket 每个上行事件体带 `userId` + `sessionToken`（入口事件 `user-joined`）。

### 9.2 socket 事件
| 事件 | 方向 | 载荷要点 |
| --- | --- | --- |
| `send-message` / `message-sent` | C→S / S→C | 回执带 `messageId`、`message`、`clientMsgId`、`success`；幂等命中时 `duplicate:true` |
| `send-private-message` / `private-message-sent` | C→S / S→C | 同上（此前私聊不回带 `clientMsgId`，已补） |
| `message-received` | S→C | 群 `group_<id>` / 全局 `authenticated_users` |
| `private-message-received` | S→C | `user_<id>` |
| `private-message-read` | S→C | `{ fromUserId, friendId }` |
| `typing-start` / `typing-stop` | C→S | `{ userId, sessionToken, scope, groupId?/toUserId? }` |
| `typing-update` | S→C | `{ scope, userId, nickname, typing, at, groupId?/toUserId? }` |
| `group-chain-created` / `group-chain-updated` | S→C | `{ chain }` |
| `group-vote-created` / `group-vote-updated` | S→C | `{ vote }` |
| `group-settings-updated` | S→C | `{ groupId, allowChain, allowVote, showTyping }` |

事件名常量：`scr-backend/src/socket/events.js:42-44`（typing）、`:18`（`message-sent`）、`:27`（`private-message-sent`）。

### 9.3 Redis 扇出
| 通道 / key | 类型 | 说明 |
| --- | --- | --- |
| `broadcast_stream` | Stream | 业务广播队列（MAXLEN ~10000，`scr-backend/src/utils/broadcast/constants.js:4`、`:7`）；消费者按 room 只投递本地连接 |
| room `group_<id>` / `user_<id>` / `authenticated_users` | socket.io room | 业务事件分片 |
| `scr:broadcast_progress:<node>` | Hash | 每进程消费位点（`constants.js:10`） |
| `scr:typing:group:<id>` / `scr:typing:user:<id>` | Pub/Sub | typing 分片频道（`typingHub.js:15` 的 `CHANNEL_PREFIX`） |
| `scr:typing:throttle:<scope>:<target>:<userId>` | String | 发布去重锁，PX 1200（`typingHandler.js:22`） |
| `scr:typing:group:<gid>:<uid>` / `scr:typing:private:<toUid>:<uid>` | String | typing 状态，TTL 5s（`typingHandler.js:21`） |
| `scr:typing:profile:<uid>` / `scr:typing:group-settings:<gid>` / `scr:typing:member:<gid>:<uid>` | String(JSON) | 开关与成员判定缓存，TTL 60s |

装配点：`scr-backend/src/socket/index.js:191`（producer）、`:192`（consumer）、`:197-198`（typingHub 启动）。

### 9.4 权限判定
```
群成员   = scr_group_members(group_id, user_id, deleted_at IS NULL)
群主     = scr_groups.creator_id = user_id
管理员   = 群主 OR scr_group_members.is_admin = 1
```
开关字段与默认值：`scr_users.show_typing`（默认 1）、`scr_groups.allow_chain`（1）、`allow_vote`（1）、`show_typing`（0）；改动后立即 `DEL` 对应 Redis 缓存。

### 9.5 限流参数
| 场景 | 阈值 | 窗口 | 位置 |
| --- | --- | --- | --- |
| socket 发消息/已读/撤回 | 10 次 | 10s | `scr:rate_limit:<uid>:short` |
| socket 发消息/已读/撤回 | 40 次 | 60s | `scr:rate_limit:<uid>:long` |
| typing 前端节流 | 1 次 | 1500ms | `scr-web/src/utils/chat/typing.js:5` |
| typing 前端自动停止 | — | 4000ms | `typing.js:6` |
| typing 服务端发布去重 | 1 次 | 1200ms | `typingHandler.js:18` |
| typing 扇出合并 | 1 条/(房间,用户) | 2000ms | `typingHub.js:16` |
| typing 状态 TTL | — | 5s | `typingHandler.js` 的 `STATE_TTL_SECONDS` |
| 搜索 | 扫描 ≤3000 行，返回 ≤200 条 | — | `groupFeatureService.js:25`（`SEARCH_SCAN_LIMIT`） |
| 接龙/投票/搜索 REST | 无独立限流 | — | 依赖鉴权 + 唯一约束 |

### 9.6 幂等契约
- 幂等键：`clientMsgId`（前端生成，重发复用同一个），落库到 `client_msg_id`。
- 唯一索引：`(user_id, client_msg_id)` / `(sender_id, client_msg_id)`。
- 命中重复（插入前查到 / 并发撞 `ER_DUP_ENTRY`）：回 `success:true` + 首包同 `messageId` + 首包同 `message` 对象 + 同 `clientMsgId` + `duplicate:true`，**绝不下发 `success:false`**；不再 INSERT、不再广播。
- 降级：列不存在时（DDL 未执行）跳过幂等键写入并打一次告警，消息照常发送。

---

## 已有数据库调整语句（仅存量环境执行）

> **本机开发库 `scr-dev` 已于 2026-11-01 执行完毕以下 DDL**（一次性独立脚本经项目自身 `mysql2` 链路执行，
> 执行前打印库标识自证；幂等能力**已启用并实测通过**，当前**不处于降级态**）。
> **其它存量环境（如有）仍需各自执行下面两条语句** —— 下面附有执行后校验 SQL 与回滚语句。
>
> **代码里 0 条 ALTER**：DDL 只写在 `scr-backend/src/index.js` 的 `CREATE TABLE IF NOT EXISTS` 本体里
> （`client_msg_id` 列见 `:266`（私聊）、`:291`（群聊），唯一索引见 `:275`、`:295`），**全新数据库从零初始化即最新结构**，
> 无需执行下面任何语句。下面两条仅供**已存在的存量库**补齐结构使用。
>
> 执行权限：本地开发库的 ALTER 已由用户在任务中单独授权后执行；**其余环境**的 ALTER 仍需用户或具备 DDL 权限者执行
> （agent 沙箱默认禁止 ALTER，对所有 agent 生效；被拦不代表没执行，判断请直接查库）。

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

执行后校验：
```sql
SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'client_msg_id';
SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND INDEX_NAME IN ('unique_messages_client_msg','unique_private_client_msg')
 ORDER BY TABLE_NAME, SEQ_IN_INDEX;
```

回滚（如需）：
```sql
ALTER TABLE scr_messages DROP INDEX unique_messages_client_msg, DROP COLUMN client_msg_id;
ALTER TABLE scr_private_messages DROP INDEX unique_private_client_msg, DROP COLUMN client_msg_id;
```

注意事项：既有存量数据 `client_msg_id` 全为 NULL，MySQL 唯一索引对 NULL 不去重，加索引不会因历史数据失败；
文件上传、REST 发消息等非 socket 路径写入 NULL，同样不受影响。

本机开发库现状（2026-11-01 执行后核对，经项目自身 mysql2 链路读 `scr-dev`）：
```
库/主机 = scr-dev @ HK570060727545:3306
scr_messages.client_msg_id          varchar(64) nullable=YES default=NULL
  UNIQUE KEY unique_messages_client_msg (user_id, client_msg_id)   NON_UNIQUE=0
scr_private_messages.client_msg_id  varchar(64) nullable=YES default=NULL
  UNIQUE KEY unique_private_client_msg (sender_id, client_msg_id) NON_UNIQUE=0
执行前/后行数 = scr_messages 1052 → 1052，scr_private_messages 33 → 33（未变）
isIdempotencyReady('scr_messages') / ('scr_private_messages') = true / true
  （能力探测走进程内 Map + 60s TTL 缓存，列就位后自动生效，无需重启 3100）
```
列位置与本节两条 ALTER 一致：`scr_messages` 的列在 `at_userid` 之后，
`scr_private_messages` 的列在 `sender_id` 之后 —— 与初始化建表代码（`src/index.js:266`/`:291`）一致。

---

## 浏览器实测回写（2026-11-01 14:25）

来源：`/tmp/browser-acceptance-report.md`（测试环境工程师；Playwright 1.64.1 + chromium headless shell，viewport 1440×900，
账号 `user1 gamerunwuyazi`（群 17 群主）/ `user2 gamerunwuyazi1` / `user105 loadtest_typing_01`，
前端 :5173 / 后端 :3100 / 库 `scr-dev`）。原始断言数据 `/tmp/e2e/_t*.json`，脚本 `/tmp/e2e/test_t*.py`。

| 验收项 | 覆盖的八项功能 | 结论 | 关键证据 | 截图 |
| --- | --- | --- | --- | --- |
| 1 @我气泡（滚动 + 1.5s 高亮） | 6 | **PASS** | `scrollTop` 0→534；`.msg-bubble.active`=1、背景 `rgba(76,175,80,0.6)`；1.8s 后高亮与气泡均消失；水位 `localStorage['group_at_me_read_1_17']='1067'` | `t1-at-me-banner.png` / `t1-at-me-highlight.png` |
| 2 私聊 typing | 8 | **PASS** | 800ms 起 `.typing-indicator`=1，文案「无崖子27 正在输入」；1600/2400/3200ms 三个采样点持续存在 | `t2-private-typing.png` |
| 3 群聊 typing | 8 | **PASS**（群 70） | 文案「压测T01 正在输入」；群 17 因 `show_typing=0` 不下发（配置差异，非缺陷） | `t3-group-typing.png` |
| 4 表情插入位置 | 7 | **PASS**（三处）＋**新缺陷** | 三页均得 `A😀B`（光标 offset=1）；但面板整体渲染在视口外（y=-261/-315）不可见 | `t4-*.png` / `t4-panel-visibility-unified.png` |
| 5 搜索类型筛选（两条路径） | 3 | **PASS** | 群内搜索直连 API 复算一致（`text`→5 / `image`→0 / `text,image`→5 / 全选→5）；本地 chip 切换生效 | `t5-*.png` |
| 6 角色徽标 | 4 | 群主 **PASS** / 统一聊天无徽标 **已复现** / 管理员 **未实测** | 群聊 `.role-badge`=3（全为「群主」）；统一聊天 `.role-badge`=0、`.msg-sender-name`=20 | `t6-badge-group.png` / `t6-badge-unified.png` |
| 7 失败气泡 + 重发 | 5 | **PASS**（含幂等） | 断网→`.pending-message.is-failed` + 「重发」→复用同一记录→恢复网络后 UI 1 条；库中匹配行数=1（id=1071） | `t7-failed-bubble.png` |

七项 **console error 0 / pageerror 0**。

**覆盖不到的部分**（重要）：**群接链（功能 1）与群投票（功能 2）本轮完全没有进浏览器验收**，仍只有代码级 + 接口形状证据。

---

## 未实测项清单

浏览器实测报告已产出（`/tmp/browser-acceptance-report.md`，2026-11-01 14:25）。下列条目按报告结论重排，
**实测通过的从清单里移出，但仍在本节留一行标注状态**，便于追溯。

### A. 仅有代码级验证（未浏览器实测）

| # | 项目 | 最新状态 | 证据类型 | 说明 |
| --- | --- | --- | --- | --- |
| A1 | 群接龙：发起/参与/结束、开关拦截、唯一约束 409 | **仍未实测** | 代码级 + 接口形状对 3100 校准 | 本轮浏览器验收未覆盖该功能，无端到端截图 |
| A2 | 群投票：发起/投票/改票/匿名、截止后 409 | **仍未实测** | 代码级 + 接口形状对 3100 校准 | 同上 |
| A3 | 群搜索：JSON 原文不命中 | **已实测** | 浏览器 + 直连 API 复算 4 组 types | 前端两条入口（群内搜索 / 本地 modal）均 PASS |
| A4 | 角色徽标：`is_owner`/`role` 返回值 | **部分实测** | 浏览器目视 + 真实库 `getGroupMembers(17)` | 群主 PASS；**管理员仍未实测**（无样本，需授权提升权限）；统一聊天无徽标已复现 |
| A5 | 发送状态：气泡不提前消失、刷新不重置动画 | **已实测** | 浏览器断网/重发 + 库内幂等核对 | 失败气泡、重发、幂等都 PASS |
| A6 | @我 标识：普通 @ 不误伤、正文含 class 字样不误伤 | **部分实测** | 浏览器目视（`.at-mention-self` 命中 3 处） | 气泡与行内高亮已确认；「不误伤」两类断言未单独执行 |
| A7 | 表情面板：最近使用、光标插入 | **部分实测** | 浏览器（三页 `A😀B`） | 插入位置 PASS；**「最近使用」未目视确认**（面板在视口外，见已知缺陷） |
| A8 | typing：合并不互相覆盖、跨 socket 去重 | **部分实测** | 浏览器双账号互看（私聊 + 群 70） | 双端互看已做；「合并不互相覆盖 / 跨 socket 去重」仍只有假 io 自测，未在浏览器断言 |
| A9 | 重发幂等：命中重复键回首包 | **已实测（群聊 UI + 后端链路）** | 浏览器断网/重发 + 库内匹配行数=1；私聊为 socket 级链路证据 | DDL 已执行，唯一索引生效；**私聊 UI 侧本轮未实测**（见 B10） |
| A10 | 历史消息 `@` 名单双键（`atUserid`/`at_userid`） | **仍未实测** | 真实库临时插消息 → worker 拉取 → 删除 | 仅后端，未在 UI 确认 |

### B. 浏览器实测未通过 / 未执行

| # | 项目 | 状态 | 原因 |
| --- | --- | --- | --- |
| B1 | 7 项功能逐项截图 + console error 计数 | **已执行**（7/7，error 0） | 但七项不含群接龙与群投票 |
| B2 | typing 双账号双上下文互看「正在输入」 | **已执行** | 私聊 PASS、群聊在群 70 PASS；群 17 因 `show_typing=0` 不可用 |
| B3 | 「N 条@我的消息」气泡点击滚动 + 1.5s 高亮 | **已执行 PASS** | — |
| B4 | 真实库上的重发幂等（同一 clientMsgId 连发两次，库里只有 1 条） | **已执行 PASS**（群聊） | DDL 已执行，实测群里 1 行（id=1071）；私聊为 socket 级链路证据，非 UI 证据 |
| B5 | DDL 执行后的回归（消息发送 / 撤回 / 搜索） | **部分执行** | 消息发送 PASS、群搜索 PASS；**撤回未回归** |
| B6 | 群接链 / 群投票 端到端（发起→参与→结束→实时扇出） | **未执行** | 本轮浏览器验收七项不含这两项 |
| B7 | 设置页 typing 开关端到端往返（`PUT /api/user/settings/typing`） | **未执行** | 不在七项范围；仅确认前端调用点存在（`UserSettings.vue:139/631/636/643`） |
| B8 | 「管理员」角色徽标 | **未执行** | 开发库无「非群主的 is_admin=1」成员；造样本需提升权限，被授权拦截 |
| B9 | 表情面板在**真实可见状态**下的交互 | **未执行** | 面板在视口外不可见；插入位置是在「JS 临时修正面板定位」前提下验证的 |
| B10 | 私聊侧失败气泡 + 重发（UI 级） | **未执行** | 浏览器验收第 7 项只验了群聊侧；私聊走 `send-private-message` + `PrivateMessageItem` 的 `PendingBubble`，代码路径对称但未做 UI 验证（后端 socket 级幂等已验） |

### C. 明确不在本轮范围

| # | 项目 | 原因 |
| --- | --- | --- |
| C1 | Markdown（type 5）消息里的 @ 高亮 | 需在 marked 产物上再跑高亮，有代码块内误高亮风险，已记为限制 |
| C2 | 引用消息正文里的 @ 高亮 | 与主聊天室保持同口径，已记为限制 |
| C3 | 表情「最近使用」跨设备同步 | 当前只存 localStorage，未做服务端存储 |
| C4 | 死代码清理（`SearchMessageModal.vue`、`useSearchModal.js`、`useSearchNavigation.js`） | 建议验收通过后再删，避免一次性改动面过大 |

---

## 已知缺陷与限制

### 后端

1. **幂等已启用（DDL 已执行）**：本机开发库 `scr-dev` 只读核对（2026-11-01，验收后复测）：
   ```
   client_msg_id 列数 = 2   （scr_messages、scr_private_messages，均 varchar(64) nullable=YES default=NULL）
   唯一索引数 = 2           （unique_messages_client_msg / unique_private_client_msg，NON_UNIQUE=0）
   重复 (user_id, client_msg_id) 组合数 = 0
   重复 (sender_id, client_msg_id) 组合数 = 0
   scr_messages 行数 = 1052  （max(id)=1056，AUTO_INCREMENT=1074）
   scr_private_messages 行数 = 33  （max(id)=33，AUTO_INCREMENT=36）
   当前 client_msg_id 非空行数 = 0 / 0   （幂等键不落库留存，验收残留已清理）
   ```
   「已有数据库调整语句」章节的 ALTER 已在验收前执行完毕，本文保留该章节供其他环境参考。
2. **幂等键按「同一用户」唯一**：`scr_messages` 的唯一索引是 `(user_id, client_msg_id)`、`scr_private_messages` 是 `(sender_id, client_msg_id)`。若前端把同一个 `clientMsgId` 用在两个不同会话（群 A 与群 B），第二条会被判定为重复并回第一条消息。前端当前「一次发送一个 id」，实际不会触发。
3. **幂等命中只回 ack，不补发广播**：首包已落库但广播消息丢失时，重复命中只回 ack，不补发 `message-received`，其他端可能看不到该消息。
4. **搜索是 LIKE 粗筛 + 应用层精筛**：单次最多扫 3000 行，超出范围的历史消息搜不到；未建全文索引。
5. **投票截止不落库**：`ends_at` 过期只在读取时判定为 closed，没有后台任务更新 `status` 字段。
6. **接龙/投票/搜索 REST 无独立限流**：依赖鉴权 + 唯一约束 + 搜索扫描上限；socket 消息限流为 10 次/10s + 40 次/60s（`RATE_LIMIT_SHORT_LIMIT`/`LONG_LIMIT`）。
7. **私聊 `at_userid` 的 `-1` 被服务端剔除**：客户端塞 `-1` 会被过滤（私聊无 @全体 语义）；群聊 `-1` 原样透传。
8. **成员名单接口未鉴权到群成员**：`GET /api/group-members/:groupId` 沿用既有实现，任意登录用户可读。
9. **群 typing 受「群级开关」支配（配置差异，非缺陷）**：`typingHandler.handle` 在 `scope==='group'` 时读 `getGroupTypingSettings(groupId)`，`show_typing=0` 直接 return，事件根本不进入扇出。实测群 17（`show_typing=0`）不出现「正在输入」，群 70（`show_typing=1`）正常。**结论：群聊 typing 是否可用取决于每个群的开关，不是全局开关**，需要产品侧明确告知用户。

### 前端

10. **@我 高亮仅覆盖 `messageType ≠ 5`**：Markdown 消息（type 5）走 marked 解析分支，不经过 `highlightMentions`，正文里的 @ 不高亮。
11. **引用消息正文里的 @ 不高亮**：引用气泡走 `quotedMessageParsedContent`，与主聊天室同口径。
12. **角色徽标统一聊天视图缺失（已复现）**：`RoleBadge` 只在 `GroupMessageItem.vue:23` 被引用，主聊天室的 `UnifiedMessageItem.vue` 未接入。实测统一聊天内 `.role-badge`=0 而 `.msg-sender-name`=20，即发送者名在、角色标签完全没有。需产品侧决定是否补齐。
13. **`-1` 口径曾三处不一致**：历史曾出现「在线路径把 @全体 计入 @我、离线路径把 `-1` 静默丢掉」的矛盾；现已按后端契约统一为「群聊 `-1` 计入 @我，私聊/主聊天室不计入」，离线判定在 `storageStore.js:627-633` 补齐 `|| String(id) === '-1'`。
14. **群搜索两条入口口径不同**：实测两条路径都 PASS，但口径差异仍在——`GroupSearchPanel`（群聊页）走后端接口、只命中可渲染文本；`SearchMessageModal` 走本地 localForage 过滤、不区分 JSON 原文。
15. **表情「最近使用」只存 localStorage**：换设备或清缓存即丢失。
16. **发送状态**：浏览器实测已通过（失败气泡 + 重发 + 幂等断言），原先「只有 pinia 自测」的限制解除。
17. **本机内存限制**：vite build 需 `NODE_OPTIONS=--max-old-space-size=768`，否则被 OOM killer 杀掉（exit 137）；浏览器实测已在测试环境（内存较足）完成，本机不再承担 Playwright。

### 本轮新发现的缺陷（此前未知）

18. **【功能缺陷·唯一确认的一个】表情面板整体渲染在视口外，用户点不到**：
    `EmojiPanel.vue` 的 `.emoji-panel` 用 `position:absolute; bottom:calc(100% + 8px)` 向上弹出，但它的定位包含块是
    `.chat-content` / `.group-chat-interface` / `.private-chat-interface` 这类**整屏高且 `position:static`** 的容器
    （百分比参照最近的 `position:relative` 祖先），导致面板被推到视口顶部之外：
    `getBoundingClientRect()` = `{x:350, y:-261, w:354, h:253}`（统一聊天）、`y:-315`（群聊/私聊），视口高 900；
    同时祖先 `overflow:hidden` 会把面板裁掉。**三处聊天页几何完全一致，即表情功能实际不可用。**
    建议修法：把 `EmojiPanel` 挂到输入区容器内（`.input-buttons` 的定位父级），或给 `.emoji-panel` 一个高度等于输入框的定位锚点。
    影响面：本轮「插入位置 PASS」是在 JS 临时把面板改成 `position:fixed; top:120px` 的前提下成立的。
19. **typing 事件在 socket 重连窗口可能丢失**：先跑群聊发送再串行跑私聊 typing，接收方 `.typing-indicator` 偶发为 0；
    单独跑私聊两次均稳定通过。观测到 `session-expired` → 前端刷新 token → 重连期间的 typing 事件丢失。
    判定为测试编排与时序问题，**但真实用户「先发群消息再切私聊」可能命中同一窗口**，建议产品侧评估是否在重连后补拉一次 typing 状态。

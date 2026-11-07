<template>
  <!-- type=8 接龙头：保留卡片式（标题/说明/参与状态/按钮） -->
  <div v-if="!isEntryMessage" class="chain-message">
    <div class="chain-head">
      <span class="chain-icon"><i class="fas fa-link" aria-hidden="true"></i></span>
      <span class="chain-title">{{ displayTitle }}</span>
      <span v-if="isClosed" class="chain-status closed">已结束</span>
      <span v-else class="chain-status open">进行中</span>
    </div>

    <div v-if="displayContent" class="chain-desc">{{ displayContent }}</div>

    <div class="chain-entries" v-if="entries.length > 0">
      <div v-for="(entry, index) in entries" :key="entry.id" class="chain-entry-item">
        <span class="entry-index">{{ index + 1 }}.</span>
        <span class="entry-name">{{ entry.nickname || `用户${entry.userId}` }}</span>
        <span v-if="entry.content" class="entry-content">{{ entry.content }}</span>
        <span v-if="isSelfEntry(entry)" class="entry-self-tag">我</span>
      </div>
    </div>
    <div v-else-if="!isClosed" class="chain-empty">还没有人接龙，快来抢占第一</div>

    <div class="chain-meta">
      <span>{{ entryCount }} 人已参与</span>
      <span v-if="creatorNickname" class="dot">·</span>
      <span v-if="creatorNickname">{{ creatorNickname }} 发起</span>
    </div>

    <div class="chain-actions">
      <button
        type="button"
        class="chain-btn"
        :class="{ joined: joined, disabled: joined || isClosed || submitting }"
        :disabled="joined || isClosed || submitting"
        @click="openJoinModal"
      >{{ joined ? '已参与' : (isClosed ? '已结束' : '接龙') }}</button>
    </div>

    <CreateChainModal
      v-model="showJoinModal"
      mode="join"
      :chain-title="displayTitle"
      :submitting="submitting"
      @confirm="handleJoin"
    />
  </div>

  <!-- type=9 参与接龙：微信式累加序号列表（发送者头像/昵称由消息气泡本身展示，卡片内不重复） -->
  <div v-else class="chain-message chain-entry-message">
    <div class="chain-head entry-head">
      <span class="chain-hash">#接龙</span>
      <span class="chain-title">{{ displayTitle }}</span>
    </div>

    <div class="chain-entries entry-list" v-if="sortedEntries.length > 0">
      <div
        v-for="entry in sortedEntries"
        :key="`${entry.seq}-${entry.userId}`"
        class="chain-entry-item"
        :class="{ self: isSelfEntry(entry) }"
      >
        <span class="entry-index">{{ entry.seq }}.</span>
        <span class="entry-name">{{ entry.nickname || `用户${entry.userId}` }}</span>
        <span v-if="entry.content" class="entry-content">{{ entry.content }}</span>
        <span v-if="isSelfEntry(entry)" class="entry-self-tag">我</span>
      </div>
    </div>
    <div v-else class="chain-empty">暂无参与记录</div>

    <div class="chain-actions">
      <button
        type="button"
        class="chain-btn"
        :class="{ joined: joined, disabled: joined || isClosed || submitting }"
        :disabled="joined || isClosed || submitting"
        @click="openJoinModal"
      >{{ joined ? '已参与' : (isClosed ? '已结束' : '参与接龙') }}</button>
    </div>

    <CreateChainModal
      v-model="showJoinModal"
      mode="join"
      :chain-title="displayTitle"
      :submitting="submitting"
      @confirm="handleJoin"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import CreateChainModal from '@/components/GroupFeature/CreateChainModal.vue';
import { useGroupFeatureStore } from '@/stores/groupFeatureStore';
import { useBaseStore } from '@/stores/baseStore';
import toast from '@/utils/toast';

const props = defineProps({
  // 消息壳 content 解析出的 payload：
  // type 8: { chainId, title, content }
  // type 9: { chainId, entryId, title, content, entries?: [{seq,userId,nickname,content}] 快照兜底 }
  payload: { type: Object, required: true },
  // 8 = 接龙头 / 9 = 参与接龙
  messageType: { type: [Number, String], default: 8 }
});

const featureStore = useGroupFeatureStore();
const baseStore = useBaseStore();

const showJoinModal = ref(false);
const submitting = ref(false);
const errorMsg = ref('');

// 动态数据（entries/状态）来自 store；store 没有历史数据时退化为消息 payload 静态展示
const chainData = computed(() => featureStore.chainById(props.payload.chainId));

const displayTitle = computed(() => chainData.value?.title || props.payload.title || '群接龙');
const displayContent = computed(() => chainData.value?.content || props.payload.content || '');
const entries = computed(() => (Array.isArray(chainData.value?.entries) ? chainData.value.entries : []));

const isEntryMessage = computed(() => Number(props.messageType) === 9);

// type=9 累加序号列表：优先用广播/REST 拉到的最新 chain.entries（保持实时性），
// store 没有数据时退化为消息 payload 里的 entries 快照（仅渲染兜底）
const sortedEntries = computed(() => {
  const source = entries.value.length > 0
    ? entries.value
    : (Array.isArray(props.payload.entries) ? props.payload.entries : []);
  return source
    .map((entry, index) => ({ ...entry, seq: Number(entry.seq) || index + 1 }))
    .sort((a, b) => a.seq - b.seq);
});
const entryCount = computed(() => entries.value.length);

const isClosed = computed(() => {
  if (!chainData.value) return false;
  return Boolean(chainData.value.isClosed || chainData.value.closedAt);
});

// 契约：joined 不信任服务端字段（广播是动作发起人视角），一律按 entries 里的 userId 本地计算
const myId = computed(() => baseStore.currentUser?.id ?? null);

function isSelfEntry(entry) {
  return myId.value !== null && String(entry.userId) === String(myId.value);
}

const joined = computed(() => entries.value.some((entry) => isSelfEntry(entry)));

const creatorNickname = computed(() => chainData.value?.creatorNickname || '');

function openJoinModal() {
  if (joined.value || isClosed.value) return;
  errorMsg.value = '';
  showJoinModal.value = true;
}

async function handleJoin({ content }) {
  submitting.value = true;
  errorMsg.value = '';
  try {
    await featureStore.joinChainItem(props.payload.chainId, content);
    showJoinModal.value = false;
    toast.success('接龙成功', 1500);
  } catch (e) {
    const message = e?.response?.data?.message || e?.message || '接龙失败';
    // 409 已参与：关闭弹窗即可（按钮态由 entries 驱动）
    if (e?.response?.status === 409) {
      showJoinModal.value = false;
      toast.info(message, 2000);
    } else {
      toast.error(message, 2500);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.chain-message {
  width: 280px;
  max-width: 100%;
}

.chain-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}

.chain-icon {
  color: #409eff;
  font-size: 13px;
}

.chain-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chain-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  flex-shrink: 0;
}

.chain-status.open {
  color: #067647;
  background: #dcfae6;
}

.chain-status.closed {
  color: #71717a;
  background: #f4f4f5;
}

.chain-desc {
  margin-top: 6px;
  font-size: 12px;
  color: #606266;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chain-entries {
  margin-top: 8px;
  max-height: 150px;
  overflow-y: auto;
  border-top: 1px solid #f0f2f5;
}

.chain-entry-item {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 5px 0;
  border-bottom: 1px solid #f7f8fa;
  font-size: 12px;
  color: #303133;
  line-height: 1.4;
}

.entry-index {
  color: #909399;
  flex-shrink: 0;
}

.entry-name {
  font-weight: 500;
  flex-shrink: 0;
}

.entry-content {
  color: #606266;
  word-break: break-word;
}

.entry-self-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: #409eff;
  background: #eef4ff;
  border-radius: 6px;
  padding: 0 4px;
}

.chain-empty {
  margin-top: 8px;
  padding: 10px 0;
  font-size: 12px;
  color: #a8abb2;
  border-top: 1px solid #f0f2f5;
}

/* type=9 微信式参与接龙 */
.entry-head {
  gap: 6px;
}

.chain-hash {
  color: #409eff;
  font-weight: 600;
  flex-shrink: 0;
}

.entry-list {
  max-height: 220px;
}

.chain-entry-item.self {
  background: #f0f7ff;
  margin: 0 -6px;
  padding-left: 6px;
  padding-right: 6px;
  border-radius: 4px;
}

.chain-meta {
  margin-top: 6px;
  font-size: 11px;
  color: #909399;
  display: flex;
  align-items: center;
  gap: 4px;
}

.dot {
  color: #c0c4cc;
}

.chain-actions {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f0f2f5;
  display: flex;
  justify-content: flex-end;
}

.chain-btn {
  border: 1px solid #409eff;
  background: #409eff;
  color: #fff;
  font-size: 13px;
  padding: 5px 18px;
  border-radius: 6px;
  cursor: pointer;
}

.chain-btn.joined,
.chain-btn.disabled {
  background: #f4f4f5;
  border-color: #e4e7ed;
  color: #a8abb2;
  cursor: not-allowed;
}
</style>

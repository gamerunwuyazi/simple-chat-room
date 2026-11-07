<template>
  <div class="vote-message">
    <div class="vote-head">
      <span class="vote-icon"><i class="fas fa-chart-simple" aria-hidden="true"></i></span>
      <span class="vote-title">{{ displayTitle }}</span>
      <span v-if="isClosed" class="vote-status closed">已结束</span>
      <span v-else class="vote-status open">进行中</span>
    </div>

    <div v-if="displayDescription" class="vote-desc">{{ displayDescription }}</div>

    <div class="vote-meta">
      <span v-if="multiple" class="tag">多选</span>
      <span v-if="anonymous" class="tag">匿名</span>
      <span v-if="isCreator" class="tag creator">我发起的</span>
      <span class="dot">·</span>
      <span>{{ totalVoters }} 人已投</span>
      <span v-if="endsAtText" class="dot">·</span>
      <span v-if="endsAtText">{{ endsAtText }} 截止</span>
    </div>

    <ul class="option-list">
      <li
        v-for="option in options"
        :key="option.id"
        class="option-item"
        :class="{ selected: isSelected(option.id), clickable: optionClickable }"
        @click="handleOptionClick(option.id)"
      >
        <span class="option-mark">{{ isSelected(option.id) ? '✓' : '' }}</span>
        <span class="option-label">{{ option.label }}</span>
        <template v-if="resultVisible">
          <span class="option-count">{{ countOf(option) }} 票</span>
          <span class="option-percent">{{ percentOf(option) }}%</span>
          <div class="option-bar">
            <div class="option-bar-inner" :style="{ width: percentOf(option) + '%' }"></div>
          </div>
        </template>
        <div v-if="expandedOptionId === option.id" class="option-voter-panel">
          <div v-if="voterLoading" class="voter-tip">加载中...</div>
          <template v-else>
            <div class="voter-list">
              <span v-for="v in votersList" :key="v.userId" class="voter-chip">
                <img v-if="v.avatarUrl" :src="v.avatarUrl" class="voter-avatar" alt="">
                <span>{{ v.nickname || `用户${v.userId}` }}</span>
              </span>
              <span v-if="votersList.length === 0" class="voter-tip">暂无投票人</span>
            </div>
            <button v-if="votersHasMore" type="button" class="voter-more" @click.stop="loadMoreVoters(option.id)">加载更多</button>
          </template>
        </div>
      </li>
    </ul>

    <div v-if="isCreator && !isClosed" class="vote-actions">
      <button
        type="button"
        class="vote-btn close-btn"
        :disabled="closing"
        @click="closeVoteAction"
      >{{ closing ? '结束中...' : '结束投票' }}</button>
    </div>
    <div v-else-if="multiple && canVote" class="vote-actions">
      <button
        type="button"
        class="vote-btn"
        :class="{ disabled: submitting || selectedIds.length === 0 || unchanged }"
        :disabled="submitting || selectedIds.length === 0 || unchanged"
        @click="submitSelection"
      >{{ hasVoted ? '修改投票' : '投票' }}</button>
    </div>
    <div v-else-if="hasVoted && !isClosed" class="voted-tip">已投票，点击选项可改投</div>
    <div v-else-if="isClosed && !anonymous" class="voted-tip closed-tip">已结束，点击选项可查看投票人</div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useGroupFeatureStore } from '@/stores/groupFeatureStore';
import { useBaseStore } from '@/stores/baseStore';
import toast from '@/utils/toast';

const props = defineProps({
  // 消息壳 content 解析出的静态 payload：{ voteId, title, description, multiple, anonymous, endsAt, options:[{id,label}] }
  payload: { type: Object, required: true }
});

const featureStore = useGroupFeatureStore();
const baseStore = useBaseStore();

const submitting = ref(false);

// 动态数据（票数/我的选择/发布人）来自 store，按 voteId upsert；store 没有时退化为 payload 静态展示
const voteData = computed(() => featureStore.voteById(props.payload.voteId));

const displayTitle = computed(() => voteData.value?.title || props.payload.title || '群投票');
const displayDescription = computed(() => voteData.value?.description || props.payload.description || '');
const multiple = computed(() => Boolean(voteData.value ? voteData.value.multiple : props.payload.multiple));
const anonymous = computed(() => Boolean(voteData.value ? voteData.value.anonymous : props.payload.anonymous));
const endsAt = computed(() => voteData.value?.endsAt ?? props.payload.endsAt ?? null);

const options = computed(() => {
  const source = voteData.value?.options;
  if (Array.isArray(source) && source.length > 0) return source;
  return Array.isArray(props.payload.options) ? props.payload.options : [];
});

const myOptionIds = computed(() => {
  const raw = voteData.value?.myOptionIds;
  return (Array.isArray(raw) ? raw : []).map(String);
});

const hasVoted = computed(() => myOptionIds.value.length > 0);

const myId = computed(() => baseStore.currentUser?.id ?? null);
const isCreator = computed(() => {
  const creatorId = voteData.value?.creatorId;
  return creatorId !== undefined && creatorId !== null && myId.value !== null
    && String(creatorId) === String(myId.value);
});

const isClosed = computed(() => {
  if (voteData.value) {
    if (voteData.value.status === 'closed') return true;
  }
  const end = endsAt.value;
  if (end) {
    const time = new Date(end).getTime();
    if (!Number.isNaN(time) && time <= Date.now()) return true;
  }
  return false;
});

const canVote = computed(() => !isClosed.value && !isCreator.value && myId.value !== null);

// 计数可见性：结束后全员可见；结束前仅发起人与已投票者可见（后端 resultVisible 为权威，缺省时本地推算）
const resultVisible = computed(() => {
  const raw = voteData.value?.resultVisible;
  if (typeof raw === 'boolean') return raw;
  return isClosed.value || isCreator.value || hasVoted.value;
});

// 已结束后（非匿名）点选项 = 查看该选项投票人明细（分页每页 20）；匿名任何情况不展示
const optionClickable = computed(() => canVote.value || (isClosed.value && !anonymous.value));

// 选项点击选择（多选）；单选点击即投票
const selectedIds = ref([...myOptionIds.value]);

watch(myOptionIds, (next) => {
  selectedIds.value = [...next];
});

// 已投项与新选择完全一致时禁用提交（避免点出 409）
const unchanged = computed(() => {
  if (!hasVoted.value) return false;
  const current = new Set(selectedIds.value.map(String));
  const voted = new Set(myOptionIds.value);
  if (current.size !== voted.size) return false;
  for (const id of current) if (!voted.has(id)) return false;
  return true;
});

function isSelected(id) {
  return selectedIds.value.some((v) => String(v) === String(id));
}

const totalVoters = computed(() => {
  const explicit = Number(voteData.value?.totalVoters);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return 0;
});

function countOf(option) {
  if (!resultVisible.value) return 0;
  const count = Number(option.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

const totalVotes = computed(() => options.value.reduce((sum, option) => sum + countOf(option), 0));

function percentOf(option) {
  if (totalVotes.value <= 0) return 0;
  return Math.round((countOf(option) / totalVotes.value) * 100);
}

const endsAtText = computed(() => {
  if (!endsAt.value) return '';
  const date = new Date(endsAt.value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
});

// ---------------------------------------------------------------- 结束投票（发起人）
const closing = ref(false);

async function closeVoteAction() {
  if (closing.value) return;
  closing.value = true;
  try {
    await featureStore.closeVoteItem(props.payload.voteId);
    toast.success('投票已结束', 1500);
  } catch (e) {
    toast.error(e?.response?.data?.message || e?.message || '结束投票失败', 2500);
  } finally {
    closing.value = false;
  }
}

// ---------------------------------------------------------------- 投票人明细（非匿名 + 已结束，分页）
const expandedOptionId = ref(null);
const votersList = ref([]);
const votersPage = ref(1);
const votersHasMore = ref(false);
const voterLoading = ref(false);

async function toggleVoters(optionId) {
  if (expandedOptionId.value === optionId) {
    expandedOptionId.value = null;
    return;
  }
  expandedOptionId.value = optionId;
  votersList.value = [];
  votersHasMore.value = false;
  await loadVoters(optionId, 1);
}

async function loadVoters(optionId, page) {
  voterLoading.value = true;
  try {
    const data = await featureStore.fetchVoteOptionVoters(props.payload.voteId, optionId, page);
    const list = Array.isArray(data.voters) ? data.voters : [];
    votersList.value = page === 1 ? list : votersList.value.concat(list);
    votersHasMore.value = Boolean(data.hasMore);
    votersPage.value = page;
  } catch (e) {
    toast.error(e?.response?.data?.message || e?.message || '查询投票人失败', 2000);
    expandedOptionId.value = null;
  } finally {
    voterLoading.value = false;
  }
}

function loadMoreVoters(optionId) {
  if (voterLoading.value || !votersHasMore.value) return;
  loadVoters(optionId, votersPage.value + 1);
}

function handleOptionClick(optionId) {
  if (canVote.value) {
    if (!multiple.value) {
      // 单选：点击选项即投票
      submitBallot([optionId]);
      return;
    }
    // 多选：点击切换选择，确认按钮提交
    const index = selectedIds.value.findIndex((v) => String(v) === String(optionId));
    if (index >= 0) selectedIds.value.splice(index, 1);
    else selectedIds.value.push(optionId);
    return;
  }
  // 已结束的非匿名投票：点选项展开/收起该选项投票人明细
  if (isClosed.value && !anonymous.value) toggleVoters(optionId);
}

async function submitSelection() {
  if (!canVote.value || selectedIds.value.length === 0 || unchanged.value) return;
  await submitBallot(selectedIds.value.map(String));
}

async function submitBallot(optionIds) {
  if (submitting.value) return;
  submitting.value = true;
  const wasVoted = hasVoted.value;
  try {
    await featureStore.submitBallotItem(props.payload.voteId, optionIds.map(Number));
    toast.success(wasVoted ? '已修改投票' : '投票成功', 1500);
  } catch (e) {
    const status = e?.response?.status;
    const message = e?.response?.data?.message || e?.message || '投票失败';
    if (status === 409) {
      // 重复提交同一组选项 / 投票已结束：以 store 最新状态为准
      toast.info(message, 2000);
    } else if (status === 403) {
      toast.error(message, 2500);
    } else {
      toast.error(message, 2500);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.vote-message {
  width: 280px;
  max-width: 100%;
}

.vote-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}

.vote-icon {
  color: #409eff;
  font-size: 13px;
}

.vote-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vote-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  flex-shrink: 0;
}

.vote-status.open {
  color: #067647;
  background: #dcfae6;
}

.vote-status.closed {
  color: #71717a;
  background: #f4f4f5;
}

.vote-desc {
  margin-top: 6px;
  font-size: 12px;
  color: #606266;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.vote-meta {
  margin-top: 6px;
  font-size: 11px;
  color: #909399;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  padding: 0 5px;
  border-radius: 6px;
  background: #f2f6ff;
  color: #409eff;
}

.tag.creator {
  background: #fff4e0;
  color: #b45309;
}

.dot {
  color: #c0c4cc;
}

.option-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.option-item {
  position: relative;
  display: grid;
  grid-template-columns: 16px 1fr auto auto;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  border-radius: 6px;
  font-size: 12px;
  color: #303133;
}

.option-item.clickable {
  cursor: pointer;
}

.option-item.clickable:hover {
  background: #f7f9fc;
}

.option-item.selected {
  background: #eef4ff;
}

.option-mark {
  color: #409eff;
  font-weight: 700;
}

.option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-count,
.option-percent {
  color: #909399;
  font-size: 11px;
}

.option-bar {
  grid-column: 1 / -1;
  height: 4px;
  background: #f0f2f5;
  border-radius: 2px;
  overflow: hidden;
}

.option-bar-inner {
  height: 100%;
  background: #409eff;
  transition: width 0.25s ease;
}

.vote-actions {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f0f2f5;
  display: flex;
  justify-content: flex-end;
}

.vote-btn {
  border: 1px solid #409eff;
  background: #409eff;
  color: #fff;
  font-size: 13px;
  padding: 5px 18px;
  border-radius: 6px;
  cursor: pointer;
}

.vote-btn.disabled {
  background: #f4f4f5;
  border-color: #e4e7ed;
  color: #a8abb2;
  cursor: not-allowed;
}

.vote-btn.close-btn {
  background: #fff;
  border-color: #f56c6c;
  color: #f56c6c;
}

.vote-btn.close-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.option-voter-panel {
  grid-column: 1 / -1;
  margin: 4px 0 2px;
  padding: 6px 8px;
  background: #f7f9fc;
  border-radius: 6px;
}

.voter-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.voter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #606266;
  max-width: 100%;
}

.voter-avatar {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  object-fit: cover;
}

.voter-tip {
  font-size: 11px;
  color: #a8abb2;
}

.voter-more {
  margin-top: 4px;
  border: none;
  background: transparent;
  color: #409eff;
  font-size: 11px;
  padding: 0;
  cursor: pointer;
}

.voted-tip.closed-tip {
  color: #909399;
}

.voted-tip {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f0f2f5;
  font-size: 12px;
  color: #67c23a;
  text-align: right;
}

.voted-tip.creator-tip {
  color: #b45309;
}
</style>

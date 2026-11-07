import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  getChains,
  getVotes,
  createChain,
  joinChain,
  createVote,
  submitBallot,
  closeVote,
  getVoteOptionVoters,
  getGroupFeatureSettings
} from '@/api/groupFeatures.js';

/**
 * 群接龙 / 群投票动态数据 store（契约：other/chain-vote-message-contract.md）
 *
 * - 动态数据（参与列表 / 票数 / 已投项）不写死在消息里，按 chainId / voteId 独立 upsert；
 * - 消息列表本身不因这些更新重拉、不重置其他消息的动画/状态；
 * - socket 广播里的 myOptionIds / joined 是「动作发起人」视角，不能覆盖本地自己的已投状态，
 *   只有自己 REST 调用的响应（withMine=true）才允许覆盖。
 */
export const useGroupFeatureStore = defineStore('groupFeature', () => {
  // chainId / voteId（字符串化） -> 数据对象
  const chains = ref({});
  const votes = ref({});
  const currentGroupId = ref(null);
  // groupId -> { loaded, isAdmin, allowChain, allowVote }
  const groupSettings = ref({});

  // ---------------------------------------------------------------- upsert

  function upsertChain(chain) {
    if (!chain || chain.id === undefined || chain.id === null) return;
    const key = String(chain.id);
    chains.value[key] = { ...(chains.value[key] || {}), ...chain };
  }

  function upsertVote(vote, { withMine = false } = {}) {
    if (!vote || vote.id === undefined || vote.id === null) return;
    const key = String(vote.id);
    const prev = votes.value[key];
    const merged = { ...(prev || {}), ...vote };
    if (!withMine && prev && Array.isArray(prev.myOptionIds)) {
      // 广播里的 myOptionIds 是动作发起人的选择，保留本地自己的
      merged.myOptionIds = prev.myOptionIds;
    }
    votes.value[key] = merged;
  }

  function voteById(voteId) {
    return votes.value[String(voteId)] || null;
  }

  function chainById(chainId) {
    return chains.value[String(chainId)] || null;
  }

  // ---------------------------------------------------------------- 进入会话时刷新

  async function hydrate(groupId) {
    // groupId 0 = 公共聊天室（GET /api/votes 公共 scope；公共接龙已下线，不拉接龙列表）
    if (groupId === null || groupId === undefined || groupId === '') return;
    currentGroupId.value = groupId;
    const isPublic = groupId === 0;
    const [chainRes, voteRes] = await Promise.all([
      isPublic ? Promise.resolve(null) : getChains(groupId).catch(() => null),
      getVotes(groupId).catch(() => null)
    ]);
    const chainList = chainRes?.data?.chains || chainRes?.chains || [];
    const voteList = voteRes?.data?.votes || voteRes?.votes || [];
    chainList.forEach((chain) => upsertChain(chain));
    // 列表接口是按请求者算 myOptionIds 的，属于自己的权威数据
    voteList.forEach((vote) => upsertVote(vote, { withMine: true }));
  }

  // ---------------------------------------------------------------- 动作

  async function createChainItem(groupId, payload) {
    const res = await createChain(groupId, payload);
    const data = res?.data ?? res ?? {};
    if (data.chain) upsertChain(data.chain);
    return data;
  }

  async function joinChainItem(chainId, content) {
    const res = await joinChain(chainId, content);
    const data = res?.data ?? res ?? {};
    if (data.chain) upsertChain(data.chain);
    return data;
  }

  async function createVoteItem(groupId, payload) {
    const res = await createVote(groupId, payload);
    const data = res?.data ?? res ?? {};
    if (data.vote) upsertVote(data.vote, { withMine: true });
    return data;
  }

  async function submitBallotItem(voteId, optionIds) {
    const res = await submitBallot(voteId, optionIds);
    const data = res?.data ?? res ?? {};
    if (data.vote) upsertVote(data.vote, { withMine: true });
    return data;
  }

  // 发起人结束投票：成功后用响应里的关闭态 vote 覆盖本地
  async function closeVoteItem(voteId) {
    const res = await closeVote(voteId);
    const data = res?.data ?? res ?? {};
    if (data.vote) upsertVote(data.vote, { withMine: true });
    return data;
  }

  // 非匿名投票结束后分页拉某选项投票人明细（每页 20）
  async function fetchVoteOptionVoters(voteId, optionId, page = 1) {
    const res = await getVoteOptionVoters(voteId, optionId, page);
    return res?.data ?? res ?? {};
  }

  // ---------------------------------------------------------------- 群设置（发起入口开关）

  async function loadSettings(groupId) {
    if (!groupId) return null;
    try {
      const res = await getGroupFeatureSettings(groupId);
      const data = res?.data ?? res ?? {};
      groupSettings.value[String(groupId)] = {
        loaded: true,
        isAdmin: Boolean(data.isAdmin),
        allowChain: data.settings?.allowChain !== false,
        allowVote: data.settings?.allowVote !== false
      };
    } catch (e) {
      // 拉取失败先放行入口，由后端 403 兜底，避免功能整块消失
      groupSettings.value[String(groupId)] = {
        loaded: true,
        isAdmin: false,
        allowChain: true,
        allowVote: true
      };
    }
    return groupSettings.value[String(groupId)];
  }

  function applySettingsUpdate(groupId, payload) {
    const key = String(groupId);
    const prev = groupSettings.value[key] || { loaded: true, isAdmin: false, allowChain: true, allowVote: true };
    groupSettings.value[key] = {
      ...prev,
      ...(payload.allowChain !== undefined ? { allowChain: Boolean(payload.allowChain) } : {}),
      ...(payload.allowVote !== undefined ? { allowVote: Boolean(payload.allowVote) } : {})
    };
  }

  // ---------------------------------------------------------------- socket 事件

  /**
   * 契约第 4 节扇出事件：
   * message-received（type 8/9 带 chain，type 10 带 vote）、
   * group-chain-created / group-chain-updated、
   * group-vote-created / group-vote-updated、
   * group-settings-updated
   */
  function applySocketEvent(eventName, payload) {
    if (!payload) return;
    if (eventName === 'message-received') {
      const type = Number(payload.messageType);
      if (type === 8 || type === 9) {
        if (payload.chain) upsertChain(payload.chain);
      } else if (type === 10) {
        if (payload.vote) upsertVote(payload.vote, { withMine: false });
      }
      return;
    }
    if (eventName === 'group-chain-created' || eventName === 'group-chain-updated') {
      if (payload.chain) upsertChain(payload.chain);
      return;
    }
    if (eventName === 'group-vote-created' || eventName === 'group-vote-updated') {
      if (payload.vote) upsertVote(payload.vote, { withMine: false });
      return;
    }
    if (eventName === 'vote-closed') {
      // 发起人结束投票的扇出：投票关闭、结果对所有人可见
      if (payload.vote) upsertVote(payload.vote, { withMine: false });
      return;
    }
    if (eventName === 'group-settings-updated') {
      if (payload.groupId !== undefined && payload.groupId !== null) {
        applySettingsUpdate(payload.groupId, payload);
      }
    }
  }

  return {
    chains,
    votes,
    currentGroupId,
    groupSettings,
    upsertChain,
    upsertVote,
    voteById,
    chainById,
    hydrate,
    createChainItem,
    joinChainItem,
    createVoteItem,
    submitBallotItem,
    closeVoteItem,
    fetchVoteOptionVoters,
    loadSettings,
    applySettingsUpdate,
    applySocketEvent
  };
});

export default useGroupFeatureStore;

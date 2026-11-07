import request from '@/utils/request.js';

/**
 * 群接龙 / 群投票 / 群搜索 / 群功能开关 REST 封装
 * 契约见后端阶段1：/api/groups/:groupId/{chains,votes,search,settings}
 */

// ---------- 接龙 ----------
// 主聊天室只保留投票：公共 scope 接龙路由（GET/POST /api/chains）已下线，
// 仅群 scope 提供 GET/POST；参与接口 /api/chains/:id/join 群/公共接龙仍可用。
function chainBasePath(groupId) {
  return `/api/groups/${groupId}/chains`;
}

export function getChains(groupId) {
  return request.get(chainBasePath(groupId));
}

export function createChain(groupId, { title, content, clientMsgId }) {
  return request.post(chainBasePath(groupId), { title, content, clientMsgId });
}

export function joinChain(chainId, content, clientMsgId) {
  return request.post(`/api/chains/${chainId}/join`, { content, clientMsgId });
}

// 接龙发布后不可撤销（POST close 一律 410 IRREVOCABLE），前端不提供撤销入口。

// ---------- 投票 ----------
function voteBasePath(groupId) {
  return groupId === 0 || groupId === null || groupId === undefined
    ? '/api/votes'
    : `/api/groups/${groupId}/votes`;
}

export function getVotes(groupId) {
  return request.get(voteBasePath(groupId));
}

export function createVote(groupId, { title, description, multiple, anonymous, options, endsAt, clientMsgId }) {
  return request.post(voteBasePath(groupId), {
    title,
    description,
    multiple,
    anonymous,
    options,
    endsAt,
    clientMsgId
  });
}

export function submitBallot(voteId, optionIds) {
  return request.post(`/api/votes/${voteId}/ballot`, { optionIds });
}

// 发起人结束投票（仅 vote.creatorId 本人，其他人 403）
export function closeVote(voteId) {
  return request.post(`/api/votes/${voteId}/close`);
}

// 非匿名投票结束后查看某选项投票人明细（分页每页 20；匿名/未结束 403）
export function getVoteOptionVoters(voteId, optionId, page = 1) {
  return request.get(`/api/votes/${voteId}/options/${optionId}/voters`, { params: { page } });
}

// ---------- 群设置 / 个人设置 ----------
export function getGroupFeatureSettings(groupId) {
  return request.get(`/api/groups/${groupId}/settings`);
}

export function updateGroupFeatureSettings(groupId, { allowChain, allowVote, showTyping }) {
  return request.put(`/api/groups/${groupId}/settings`, {
    allow_chain: allowChain,
    allow_vote: allowVote,
    show_typing: showTyping
  });
}

export function updateTypingSetting(showTyping) {
  return request.put('/api/user/settings/typing', { show_typing: showTyping });
}

// ---------- 群内搜索 ----------
export function searchGroupMessages(groupId, { keyword, types = [] }) {
  return request.get(`/api/groups/${groupId}/search`, {
    params: {
      keyword,
      types: Array.isArray(types) ? types.join(',') : types
    }
  });
}

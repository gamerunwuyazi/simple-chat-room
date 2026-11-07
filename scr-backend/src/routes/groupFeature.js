import {
  getGroupChains,
  createGroupChain,
  joinGroupChain,
  getGroupVotes,
  createGroupVote,
  submitVoteBallot,
  closeGroupVote,
  getVoteOptionVoters,
  updateGroupFeatureSettings,
  getGroupFeatureSettings,
  updateUserTypingSetting,
  searchGroupMessages
} from '../services/groupFeatureService.js';

// 发布后不可撤销：接龙/投票的关闭接口一律 410 Gone（不区分调用者身份，
// 发布人/群主/管理员都没有撤销路径），产品代码中不存在任何关闭逻辑。
function featureIrrevocable(message) {
  return (req, res) => res.status(410).json({ status: 'error', code: 'IRREVOCABLE', message });
}

export function setupRoutes(app) {
  // 公共聊天室（主聊天室）只保留投票：公共 scope 接龙路由（GET/POST /api/chains）已移除，
  // 公共接龙创建一律不可用；既有公共接龙消息（type 8/9）仍按消息 payload 正常渲染。
  // 公共投票（GET/POST /api/votes，无 groupId 路径 = 公共 scope，登录即可；先于群路径注册）
  app.get('/api/votes', (req, res) => getGroupVotes(req, res));
  app.post('/api/votes', (req, res) => createGroupVote(req, res));

  // 群接龙
  app.get('/api/groups/:groupId/chains', (req, res) => getGroupChains(req, res));
  app.post('/api/groups/:groupId/chains', (req, res) => createGroupChain(req, res));
  app.post('/api/chains/:id/join', (req, res) => joinGroupChain(req, res));
  app.post('/api/chains/:id/close', featureIrrevocable('接龙发布后不可撤销'));

  // 群投票
  app.get('/api/groups/:groupId/votes', (req, res) => getGroupVotes(req, res));
  app.post('/api/groups/:groupId/votes', (req, res) => createGroupVote(req, res));
  app.post('/api/votes/:id/ballot', (req, res) => submitVoteBallot(req, res));
  // 发起人可结束投票（仅 vote.creatorId 本人，其他人 403；群主/管理员不代关）
  app.post('/api/votes/:id/close', (req, res) => closeGroupVote(req, res));
  // 非匿名投票结束后查看某选项投票人明细（分页，每页 20；匿名/未结束一律 403）
  app.get('/api/votes/:id/options/:optionId/voters', (req, res) => getVoteOptionVoters(req, res));

  // 群内搜索
  app.get('/api/groups/:groupId/search', (req, res) => searchGroupMessages(req, res));

  // 群设置 / 个人 typing 设置
  app.get('/api/groups/:groupId/settings', (req, res) => getGroupFeatureSettings(req, res));
  app.put('/api/groups/:groupId/settings', (req, res) => updateGroupFeatureSettings(req, res));
  app.put('/api/user/settings/typing', (req, res) => updateUserTypingSetting(req, res));
}

import request from '@/utils/request.js';

/**
 * 获取离线消息
 */
export function getOfflineMessages(publicAndGroupMinId, privateMinId) {
  return request.get('/api/offline-messages', {
    params: { publicAndGroupMinId, privateMinId }
  });
}

/**
 * 删除已删除的会话
 */
export function deleteDeletedSession(type, id) {
  return request.post('/api/delete-deleted-session', { type, id });
}

/**
 * 消息浏览/查找（查找消息弹窗）
 * scope: public | group | private；group 需 groupId，private 需 peerId
 * types: 类型 key 逗号拼接（text/image/file/card/video/audio），空 = 全部
 * keyword: 可选；为空即「按类型浏览」模式
 * page/pageSize: 分页，后端每页上限 20
 */
export function browseMessages(params) {
  return request.get('/api/messages/browse', { params });
}
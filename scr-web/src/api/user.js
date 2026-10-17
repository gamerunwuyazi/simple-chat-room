import request from '@/utils/request.js';
import axios from 'axios';
import { SERVER_URL } from '@/utils/chat/config.js';

/**
 * 获取当前用户信息
 */
export function getSelfInfo() {
 return request.get('/api/self');
}

/**
 * 刷新 Token（直接使用 axios，不经过 request 拦截器）
 */
export function refreshToken(userId, refreshTokenValue) {
 return axios.post(`${SERVER_URL}/api/refresh-token`, {
  userId: parseInt(userId),
  refreshToken: refreshTokenValue
 });
}

/**
 * 设置好友验证
 */
export function setFriendVerification(requireVerification) {
 return request.post('/api/user/set-friend-verification', { requireVerification });
}

/**
 * 获取收到的好友请求
 */
export function getFriendRequestsReceived() {
 return request.get('/api/user/friend-requests/received');
}

/**
 * 获取发出的好友请求
 */
export function getFriendRequestsSent() {
 return request.get('/api/user/friend-requests/sent');
}

/**
 * 搜索用户
 */
export function searchUsers(keyword) {
 return request.get('/api/user/search', { params: { keyword } });
}

/**
 * 检查用户名是否可用
 */
export function checkUsername(username) {
 return axios.get(`${SERVER_URL}/api/check-username`, { params: { username } });
}

/**
 * 注册
 */
export function register(data, token) {
 return axios.post(`${SERVER_URL}/api/register`, { ...data, token });
}

/**
 * 登录
 */
export function login(account, password, sessionId, nonce) {
 return axios.post(`${SERVER_URL}/api/login`, { username: account, password, sessionId, nonce });
}

/**
 * 使用自动登录 Token 登录（直接使用 axios）
 */
export function autoLogin(account, password, autoLoginToken) {
 return axios.post(`${SERVER_URL}/api/login`, { username: account, password, autoLoginToken });
}

/**
 * 更新昵称
 */
export function updateNickname(nickname) {
 return request.post('/api/user/update-nickname', { nickname });
}

/**
 * 更新个性签名
 */
export function updateSignature(signature) {
 return request.post('/api/update-signature', { signature });
}

/**
 * 更新性别
 */
export function updateGender(gender) {
 return request.post('/api/update-gender', { gender });
}

/**
 * 修改密码
 */
export function changePassword(oldPassword, newPassword, sessionId, nonce) {
 return request.post('/api/user/change-password', { oldPassword, newPassword, sessionId, nonce });
}

/**
 * 接受好友请求
 */
export function acceptFriendRequest(requesterId) {
 return request.post('/api/user/accept-friend-request', { requesterId });
}

/**
 * 拒绝好友请求
 */
export function rejectFriendRequest(requesterId) {
 return request.post('/api/user/reject-friend-request', { requesterId });
}

/**
 * 取消好友请求
 */
export function cancelFriendRequest(friendId) {
 return request.post('/api/user/cancel-friend-request', { friendId });
}

/**
 * 检查用户屏蔽状态
 */
export function checkUserBlockStatus(userId) {
 return request.get(`/api/user/check-block-status/${userId}`);
}

/**
 * 获取黑名单列表
 */
export function getBlockList() {
 return request.get('/api/user/block-list');
}
import {
  handleGetFriends,
  handleSetFriendVerification,
  handleGetFriendRequests,
  handleGetReceivedFriendRequests,
  handleGetSentFriendRequests,
  handleAcceptFriendRequest,
  handleRejectFriendRequest,
  handleCancelFriendRequest,
  handleAddFriend,
  handleRemoveFriend,
  handleBlockUser,
  handleUnblockUser,
  handleCheckBlockStatus,
  handleGetBlockList,
  handleSearchUsers,
  handleSetFriendRemark,
  handleSetFriendDisturb
} from '../services/friendService.js';

export function setupRoutes(app, io) {
  app.get('/api/user/friends', (req, res) => {
    handleGetFriends(req, res, io);
  });

  app.post('/api/user/set-friend-verification', (req, res) => {
    handleSetFriendVerification(req, res, io);
  });

  app.get('/api/user/friend-requests', (req, res) => {
    handleGetFriendRequests(req, res, io);
  });

  app.get('/api/user/friend-requests/received', (req, res) => {
    handleGetReceivedFriendRequests(req, res, io);
  });

  app.get('/api/user/friend-requests/sent', (req, res) => {
    handleGetSentFriendRequests(req, res, io);
  });

  app.post('/api/user/accept-friend-request', (req, res) => {
    handleAcceptFriendRequest(req, res, io);
  });

  app.post('/api/user/reject-friend-request', (req, res) => {
    handleRejectFriendRequest(req, res, io);
  });

  app.post('/api/user/cancel-friend-request', (req, res) => {
    handleCancelFriendRequest(req, res, io);
  });

  app.post('/api/user/add-friend', (req, res) => {
    handleAddFriend(req, res, io);
  });

  app.post('/api/user/remove-friend', (req, res) => {
    handleRemoveFriend(req, res, io);
  });

  app.post('/api/user/block-user', (req, res) => {
    handleBlockUser(req, res, io);
  });

  app.post('/api/user/unblock-user', (req, res) => {
    handleUnblockUser(req, res, io);
  });

  app.get('/api/user/block-list', (req, res) => {
    handleGetBlockList(req, res, io);
  });

  app.get('/api/user/check-block-status/:targetUserId', (req, res) => {
    handleCheckBlockStatus(req, res, io);
  });

  app.get('/api/user/search', (req, res) => {
    handleSearchUsers(req, res, io);
  });

  app.post('/api/user/set-friend-remark', (req, res) => {
    handleSetFriendRemark(req, res, io);
  });

  app.post('/api/user/set-friend-disturb', (req, res) => {
    handleSetFriendDisturb(req, res);
  });
}

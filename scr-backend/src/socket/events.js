// Socket.IO 事件名称常量定义

export const SocketEvents = {
  // 用户连接相关
  USER_JOINED: 'user-joined',
  USER_JOINED_CONFIRMED: 'user-joined-confirmed',
  DISCONNECT: 'disconnect',
  ERROR: 'error',
  
  // 用户列表
  USERS_LIST: 'users-list',
  USER_ONLINE: 'user-online',
  USER_OFFLINE: 'user-offline',
  
  // 消息相关
  SEND_MESSAGE: 'send-message',
  MESSAGE_RECEIVED: 'message-received',
  MESSAGE_SENT: 'message-sent',
  DELETE_MESSAGE: 'delete-message',
  MESSAGE_READ: 'message-read',
  LOAD_MESSAGES: 'load-messages',
  MESSAGES_LOADED: 'messages-loaded',
  
  // 私信相关
  SEND_PRIVATE_MESSAGE: 'send-private-message',
  PRIVATE_MESSAGE_RECEIVED: 'private-message-received',
  PRIVATE_MESSAGE_SENT: 'private-message-sent',
  DELETE_PRIVATE_MESSAGE: 'delete-private-message',
  PRIVATE_MESSAGE_READ: 'private-message-read',
  
  // 系统通知
  SESSION_EXPIRED: 'session-expired',
  ACCOUNT_BANNED: 'account-banned',
  ACCOUNT_LOGGED_IN_ELSEWHERE: 'account-logged-in-elsewhere',
  IP_BANNED: 'ip-banned',
  
  // 清除未读计数
  CLEAR_GROUP_UNREAD: 'clear-group-unread',
  CLEAR_GLOBAL_UNREAD: 'clear-global-unread'
};

export default SocketEvents;

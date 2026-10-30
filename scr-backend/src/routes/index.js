import { setupRoutes as setupHealthRoutes } from './health.js';
import { setupRoutes as setupAdminRoutes } from './admin.js';
import { setupRoutes as setupUserRoutes } from './user.js';
import { setupRoutes as setupFriendRoutes } from './friend.js';
import { setupRoutes as setupGroupRoutes } from './group.js';
import { setupRoutes as setupMessageRoutes } from './message.js';
import { setupRoutes as setupFileRoutes } from './file.js';
import { setupVerifyRoutes } from './verify.js';
import { setupRoutes as setupFavoriteRoutes } from './favorite.js';

export function setupAllRoutes(app, io, broadcastProducer) {
  setupHealthRoutes(app, io);
  setupVerifyRoutes(app);
  setupAdminRoutes(app, io, broadcastProducer);
  setupFriendRoutes(app, io);
  // group 必须先于 user 注册：/api/user/groups 需要先于 /api/user/:id 匹配
  setupGroupRoutes(app, io);
  setupUserRoutes(app, io);
  setupMessageRoutes(app, io);
  setupFileRoutes(app, io);
  setupFavoriteRoutes(app, io);
}

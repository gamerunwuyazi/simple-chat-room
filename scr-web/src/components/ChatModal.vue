<template>
  <!-- 群组信息模态框（盒子IM信息面板样式） -->
  <Teleport to="body" v-if="modalStore.showGroupInfoModal">
    <div id="groupInfoModal" class="modal" :style="modalStyle" @click="modalStore.closeModal('groupInfo')">
      <div class="modal-content" @click.stop>
        <!-- 顶部：群头像 + 群名 + 关闭 -->
        <div class="group-drawer-header">
          <div class="group-drawer-avatar" @click="openGroupInfoAvatarPreview">
            <img v-if="groupInfoAvatarUrl" :src="groupInfoAvatarUrl" :alt="groupInfoName" class="avatar-image" loading="lazy" @error="handleGroupInfoAvatarError">
            <div v-else class="avatar-text">{{ groupInfoInitials }}</div>
          </div>
          <div class="group-drawer-info">
            <div class="group-drawer-name">{{ groupInfoName }}</div>
            <div class="group-drawer-id">群ID: {{ modalStore.modalData.groupInfo?.id || '未知' }}</div>
          </div>
          <span class="close" id="closeGroupInfoModal" @click="modalStore.closeModal('groupInfo')">&times;</span>
        </div>

        <!-- 面板主体 -->
        <div class="chat-group-side">
          <template v-if="modalStore.modalData.groupInfo">
            <template v-if="!isGroupDeleted">
              <!-- 群成员区域 -->
              <div class="member-area">
                <div class="member-header">
                  <div class="member-title">群成员</div>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <i v-if="isCurrentUserGroupOwner || isCurrentUserGroupAdmin" class="fas fa-rotate-right refresh-btn" title="刷新成员列表" @click="loadGroupMembers(modalStore.modalData.groupInfo.id); loadGroupMuteStatus(modalStore.modalData.groupInfo.id)"></i>
                    <div class="more-member-btn" @click="openGroupMembersModal"><span>查看全部 {{ groupMembers.length }}名成员</span><i class="fas fa-chevron-right"></i></div>
                  </div>
                </div>

                <div v-if="groupMembers.length > 0" class="member-items">
                  <div class="group-member-card" v-for="member in previewGroupMembers" :key="member.id"
                       :title="getMuteStatusTooltip(member)"
                       @contextmenu.prevent="(isCurrentUserGroupOwner || isCurrentUserGroupAdmin) ? showMemberContextMenu($event, member) : null">
                    <div class="head-image" @click="showUserAvatarPopupVue($event, member)">
                      <img v-if="getMemberAvatarUrl(member)" :src="getMemberAvatarUrl(member)" :alt="member.nickname" class="avatar-image" loading="lazy">
                      <div v-else class="avatar-text">{{ getMemberInitials(member) }}</div>
                      <div v-if="isMemberOnline(member.id)" class="online" title="用户当前在线"></div>
                    </div>
                    <div class="name">
                      <span class="name-text">{{ getMemberDisplayName(member) }}</span>
                      <span v-if="String(member.id) === String(modalStore.modalData.groupInfo.creator_id)" class="role-tag owner">群主</span>
                      <span v-else-if="member.is_admin" class="role-tag admin">管理</span>
                    </div>
                    <span v-if="member.muteStatusText" class="mute-badge" :class="{ permanent: member.isPermanentMute }">{{ member.muteStatusText }}</span>
                  </div>
                  <!-- 邀请工具（仅群主/管理员） -->
                  <div class="member-tools" v-if="isCurrentUserGroupOwner || isCurrentUserGroupAdmin" @click="handleAddGroupMembers">
                    <div class="tool-btn"><i class="fas fa-user-plus"></i></div>
                    <div class="tool-text">邀请</div>
                  </div>
                </div>
                <div v-else style="text-align: center; color: #999; padding: 16px;">加载成员列表中...</div>

                <!-- 右键菜单遮罩层（Teleport 到 body，确保在所有模态框之上显示） -->
                <Teleport to="body">
                <div v-if="contextMenu.visible"
                     @click="hideContextMenu"
                     :style="{
                       position: 'fixed',
                       left: '0',
                       top: '0',
                       width: '100vw',
                       height: '100vh',
                       zIndex: 9999,
                       background: 'transparent'
                     }">
                </div>

                <!-- 右键菜单 -->
                <div v-if="contextMenu.visible"
                     class="context-menu-active"
                     :style="{
                       position: 'fixed',
                       left: contextMenu.x + 'px',
                       top: contextMenu.y + 'px',
                       zIndex: 10000,
                       background: 'white',
                       borderRadius: '8px',
                       boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                       padding: '6px 0',
                       minWidth: '160px'
                     }"
                     @click.stop>
                  <div style="padding: 8px 16px; color: #666; font-size: 12px; font-weight: 600; border-bottom: 1px solid #f0f0f0;">
                    {{ contextMenu.member?.nickname || contextMenu.member?.username }} (ID: {{ contextMenu.member?.id }})
                  </div>

                  <!-- 踢出成员 -->
                  <div v-if="(isCurrentUserGroupOwner && String(contextMenu.member?.id) !== String(baseStore.currentUser?.id)) ||
                           (isCurrentUserGroupAdmin && !contextMenu.member?.is_admin && String(contextMenu.member?.id) !== String(modalStore.modalData.groupInfo.creator_id) && String(contextMenu.member?.id) !== String(baseStore.currentUser?.id))"
                       @click="handleContextAction('remove')"
                       style="padding: 10px 16px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;"
                       @mouseenter="$event.currentTarget.style.background='#f5f5f5'"
                       @mouseleave="$event.currentTarget.style.background='white'">
                    <span>踢出成员</span>
                  </div>

                  <!-- 设置/取消管理员（仅群主） -->
                  <div v-if="isCurrentUserGroupOwner && String(contextMenu.member?.id) !== String(baseStore.currentUser?.id) && String(contextMenu.member?.id) !== String(modalStore.modalData.groupInfo.creator_id)"
                       @click="handleContextAction('admin')"
                       style="padding: 10px 16px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;"
                       @mouseenter="$event.currentTarget.style.background='#f5f5f5'"
                       @mouseleave="$event.currentTarget.style.background='white'">
                    <span>{{ contextMenu.member?.is_admin ? '取消管理员' : '设为管理员' }}</span>
                  </div>

                  <!-- 禁言/解禁 -->
                  <div v-if="(isCurrentUserGroupOwner || isCurrentUserGroupAdmin) &&
                                String(contextMenu.member?.id) !== String(baseStore.currentUser?.id) &&
                                String(contextMenu.member?.id) !== String(modalStore.modalData.groupInfo.creator_id) &&
                                (!contextMenu.member?.is_admin || isCurrentUserGroupOwner)"
                       @click="handleContextAction('mute')"
                       style="padding: 10px 16px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 8px;"
                       @mouseenter="$event.currentTarget.style.background='#f5f5f5'"
                       @mouseleave="$event.currentTarget.style.background='white'">
                    <span>{{ contextMenu.member?.is_muted ? '解除禁言' : '禁言成员' }}</span>
                  </div>
                </div>
                </Teleport>
              </div>

              <!-- 开关设置（消息免打扰 / 全员禁言） -->
              <div class="switch-setting">
                <div class="switch-item">
                  <div class="label"><span>消息免打扰</span></div>
                  <label class="switch">
                    <input type="checkbox" :checked="groupInfoIsMuted" @change="handleGroupInfoToggleMute">
                    <span class="slider round"></span>
                  </label>
                </div>
                <div class="switch-item" v-if="isCurrentUserGroupOwner || isCurrentUserGroupAdmin">
                  <div class="label"><span>全员禁言</span></div>
                  <label class="switch">
                    <input type="checkbox" :checked="isMuteAllEnabled" @change="handleToggleMuteAll($event)">
                    <span class="slider round"></span>
                  </label>
                </div>
              </div>

              <!-- 群信息 -->
              <div class="group-info-section">
                <div class="info-item">
                  <div class="info-label"><span>群聊名称</span></div>
                  <div class="info-content">
                    <template v-if="!editingGroupName">
                      <div class="info-display" @click="(isCurrentUserGroupOwner || isCurrentUserGroupAdmin) && startEditGroupName()">
                        <span class="info-text">{{ groupInfoName }}</span>
                        <i v-if="isCurrentUserGroupOwner || isCurrentUserGroupAdmin" class="fas fa-pen-to-square icon-edit-outline"></i>
                      </div>
                    </template>
                    <template v-else>
                      <input type="text" v-model="tempGroupName" ref="groupNameInput" class="drawer-input" maxlength="50" @keyup.enter="saveGroupName" @keyup.esc="cancelEditGroupName" @blur="handleGroupNameBlur">
                    </template>
                  </div>
                </div>
                <div class="info-item">
                  <div class="info-label"><span>备注名</span></div>
                  <div class="info-content">
                    <template v-if="!editingGroupRemark">
                      <div class="info-display" @click="startEditGroupRemark">
                        <span class="info-text" :class="{ 'info-placeholder': !groupUserRemark }">{{ groupUserRemark || '点击设置备注名' }}</span>
                        <i class="fas fa-pen-to-square icon-edit-outline"></i>
                      </div>
                    </template>
                    <template v-else>
                      <input type="text" v-model="tempGroupRemark" ref="groupRemarkInput" class="drawer-input" placeholder="输入备注名称" maxlength="100" @keyup.enter="saveGroupRemark" @keyup.esc="cancelEditGroupRemark" @blur="handleGroupRemarkBlur">
                    </template>
                  </div>
                </div>
                <div class="info-item">
                  <div class="info-label"><span>我在本群的昵称</span></div>
                  <div class="info-content">
                    <template v-if="!editingGroupNickname">
                      <div class="info-display" @click="startEditGroupNickname">
                        <span class="info-text" :class="{ 'info-placeholder': !groupNickname }">{{ groupNickname || '点击设置昵称' }}</span>
                        <i class="fas fa-pen-to-square icon-edit-outline"></i>
                      </div>
                    </template>
                    <template v-else>
                      <input type="text" v-model="tempGroupNickname" ref="groupNicknameInput" class="drawer-input" placeholder="输入群内昵称" maxlength="50" @keyup.enter="saveGroupNickname" @keyup.esc="cancelEditGroupNickname" @blur="handleGroupNicknameBlur">
                    </template>
                  </div>
                </div>
              </div>

              <!-- 群公告 -->
              <div class="notice-section">
                <div class="notice-header">
                  <span>群公告</span>
                  <i v-if="isCurrentUserGroupOwner || isCurrentUserGroupAdmin" class="fas fa-pen-to-square icon-edit-outline" title="编辑群公告" @click="startEditGroupNotice"></i>
                </div>
                <div class="notice-content">
                  <template v-if="!editingGroupNotice">
                    <div class="notice-display">
                      <div class="notice-text">{{ groupInfoDescription }}</div>
                    </div>
                  </template>
                  <template v-else>
                    <textarea v-model="tempGroupNotice" ref="groupNoticeInput" class="drawer-textarea" @keyup.esc="cancelEditGroupNotice" @blur="handleGroupNoticeBlur"></textarea>
                  </template>
                </div>
              </div>

              <!-- 退出/解散群组 -->
              <div class="btn-group">
                <div v-if="isCurrentUserGroupOwner" class="text-btn danger" @click="handleDissolveGroup">解散群组</div>
                <div v-else class="text-btn danger" @click="handleLeaveGroup">退出群组</div>
              </div>
            </template>
            <template v-else>
              <div style="text-align: center; padding: 40px 20px;">
                <i class="fas fa-trash-can" style="font-size: 48px; color: #ccc; margin-bottom: 16px;"></i>
                <div style="font-size: 18px; font-weight: 600; color: #555; margin-bottom: 8px;">该群组已被删除</div>
                <div style="font-size: 14px; color: #999;">您可以删除该群组的本地记录</div>
                <div class="btn-group" style="margin-top: 20px;">
                  <div class="text-btn danger" @click="handleDeleteGroupLocalRecord">删除会话</div>
                </div>
              </div>
            </template>
          </template>
          <template v-else>
            <div style="text-align: center; color: #999; padding: 30px;">
              加载群组信息中...
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 群成员完整列表模态框（查看全部成员） -->
  <Teleport to="body" v-if="modalStore.showGroupMembersModal">
    <div id="groupMembersModal" class="modal" :style="modalStyle" @click="modalStore.closeModal('groupMembers')">
      <div class="modal-content" @click.stop>
        <div class="group-members-header">
          <i class="fas fa-arrow-left back-btn" title="返回" @click="modalStore.closeModal('groupMembers')"></i>
          <h3 class="title">群成员</h3>
          <span class="member-count">{{ groupMembers.length }}人</span>
        </div>
        <div class="search-section">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" v-model="groupMemberSearchKeyword" placeholder="搜索群成员" class="search-input">
          </div>
        </div>
        <div class="member-list">
          <div class="group-member-bar" v-for="member in visibleGroupMembers" :key="member.id"
               @contextmenu.prevent="(isCurrentUserGroupOwner || isCurrentUserGroupAdmin) ? showMemberContextMenu($event, member) : null">
            <div class="head-image" @click="showUserAvatarPopupVue($event, member)">
              <img v-if="getMemberAvatarUrl(member)" :src="getMemberAvatarUrl(member)" :alt="member.nickname" class="avatar-image" loading="lazy">
              <div v-else class="avatar-text">{{ getMemberInitials(member) }}</div>
              <div v-if="isMemberOnline(member.id)" class="online" title="用户当前在线"></div>
            </div>
            <div class="name">
              <div class="name-text">{{ getMemberDisplayName(member) }}</div>
              <span v-if="String(member.id) === String(baseStore.currentUser?.id)" class="el-tag self">我</span>
              <span v-if="String(member.id) === String(modalStore.modalData.groupInfo.creator_id)" class="el-tag owner">群主</span>
              <span v-else-if="member.is_admin" class="el-tag admin">管理员</span>
            </div>
          </div>
          <div v-if="visibleGroupMembers.length === 0" class="empty-tip">未找到相关成员</div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 创建群组模态框 -->
  <Teleport to="body" v-if="modalStore.showCreateGroupModal">
    <div id="createGroupModal" class="modal" :style="modalStyle" @click="modalStore.closeModal('createGroup')">
      <div class="modal-content" style="max-height: 100vh; max-width: 450px; width: 90%; display: flex; flex-direction: column;" @click.stop>
        <div class="modal-header" style="flex-shrink: 0; padding: 12px 16px;">
          <h2 style="font-size: 18px; font-weight: 700; margin: 0;">创建群组</h2>
          <span class="close" id="closeCreateGroupModal" @click="modalStore.closeModal('createGroup')" style="font-size: 24px;">&times;</span>
        </div>
        <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 12px 16px;">
          <div class="form-group" style="margin-bottom: 12px;">
            <label for="groupNameInput" style="display: block; font-weight: 600; color: #444; margin-bottom: 6px; font-size: 14px;">群组名称 *</label>
            <input type="text" id="groupNameInput" v-model="newGroupName" placeholder="请输入群组名称" required style="width: 100%; padding: 10px 14px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; box-sizing: border-box;">
          </div>
          <div class="form-group" style="margin-bottom: 12px;">
            <label for="groupDescriptionInput" style="display: block; font-weight: 600; color: #444; margin-bottom: 6px; font-size: 14px;">群组公告</label>
            <textarea id="groupDescriptionInput" v-model="newGroupDesc" placeholder="请输入群组公告（可选）" style="width: 100%; padding: 10px 14px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; box-sizing: border-box; min-height: 80px; resize: vertical;"></textarea>
          </div>
          <div class="form-group" style="margin-bottom: 12px;">
            <label style="display: block; font-weight: 600; color: #444; margin-bottom: 8px; font-size: 14px;">选择其他群成员</label>
            <div class="select-all-container" style="display: flex; align-items: center; margin-bottom: 8px;">
              <input type="checkbox" id="selectAllGroupMembers" @change="handleSelectAllMembers" style="width: 18px; height: 18px; cursor: pointer;">
              <label for="selectAllGroupMembers" style="margin-left: 6px; margin-bottom: 3px; font-weight: 500; cursor: pointer; font-size: 14px;">全选</label>
            </div>
            <div class="member-list" id="groupMembersList" style="max-height: 180px; overflow-y: auto; border: 2px solid #e0e0e0; border-radius: 8px; padding: 10px; background: #f9f9f9;">
              <div v-if="loadingMembers" style="text-align: center; color: #999; padding: 20px; font-size: 14px;">加载中...</div>
              <div v-else-if="availableMembers.length === 0" style="text-align: center; color: #999; padding: 20px; font-size: 14px;">暂无可用成员</div>
              <div v-else v-for="user in availableMembers" :key="user.id" class="member-item" style="display: flex; align-items: center; padding: 8px; margin-bottom: 4px; background: white; border: 1px solid #e0e0e0; border-radius: 6px; cursor: pointer;">
                <input type="checkbox" :id="'member-' + user.id" :value="user.id" v-model="selectedMembers" style="width: 16px; height: 16px; cursor: pointer; flex-shrink: 0;">
                <div style="display: flex; align-items: center; position: relative; margin-left: 8px;">
                  <div style="width: 32px; height: 32px; border-radius: 50%; background: #3498db; display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden;">
                    <img v-if="getMemberAvatarUrl(user)" :src="getMemberAvatarUrl(user)" :alt="user.nickname || user.username" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">
                    <span v-else style="font-size: 14px; color: white; font-weight: bold;">{{ (user.nickname || user.username || 'U').charAt(0).toUpperCase() }}</span>
                  </div>
                  <!-- 在线状态指示器 -->
                  <div v-if="isMemberOnline(user.id)" style="position: absolute; bottom: -2px; right: -6px; width: 10px; height: 10px; background: #2ed573; border: 2px solid white; border-radius: 50%;"></div>
                </div>
                <label :for="'member-' + user.id" style="flex: 1; margin-left: 8px; margin-bottom: 0px; cursor: pointer; font-weight: 500; text-align: left; font-size: 14px; display: flex; align-items: center; line-height: 1.4;">
                  <span style="display: inline-block;">{{ user.nickname || user.username }}</span>
                  <span style="color: #666; font-size: 12px; margin-left: 6px;">ID: {{ user.id }}</span>
                </label>
              </div>
            </div>
          </div>
          <div id="createGroupMessage" v-if="createGroupMessage" :style="{ color: createGroupMessageType === 'success' ? '#2ed573' : '#ff4757', fontSize: '14px', marginTop: '10px' }">{{ createGroupMessage }}</div>
        </div>
        <div class="modal-footer" style="flex-shrink: 0; gap: 10px; padding: 12px 16px;">
          <button id="cancelCreateGroup" class="cancel-btn" @click="modalStore.closeModal('createGroup')" style="background: #ff4757; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 600;">取消</button>
          <button id="submitCreateGroup" class="save-btn" @click="handleCreateGroup" :disabled="isCreatingGroup" style="background: #2ed573; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 600;">{{ isCreatingGroup ? '创建中...' : '创建群组' }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 发送群名片模态框（单选） -->
  <Teleport to="body" v-if="modalStore.showSendGroupCardModal">
    <div id="sendGroupCardModal" class="modal" :style="modalStyle" @click="modalStore.closeModal('sendGroupCard')">
      <div class="modal-content" style="width: 400px;" @click.stop>
        <div class="modal-header">
          <h2>选择群名片</h2>
          <span class="close" id="closeSendGroupCardModal" @click="modalStore.closeModal('sendGroupCard')">&times;</span>
        </div>
        <div class="modal-body">
          <p>选择要发送的群名片：</p>
          <div class="send-group-card-container" style="max-height: 300px; overflow-y: auto; margin: 15px 0;">
            <div v-if="loadingSendGroupCardList" style="text-align: center; color: #666; padding: 20px;">加载中...</div>
            <div v-else-if="sendGroupCardList.length === 0" style="text-align: center; color: #666; padding: 20px;">你还没有加入任何群组</div>
            <div v-else>
              <div 
                v-for="group in sendGroupCardList" 
                :key="group.id"
                class="send-group-card-item"
                :style="{
                  display: 'flex',
                  alignItems: 'center',
                  margin: '10px 0',
                  padding: '10px',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  border: '1px solid',
                  borderColor: selectedGroupIdForSendCard === group.id ? '#3498db' : '#ddd',
                  backgroundColor: selectedGroupIdForSendCard === group.id ? '#e8f5e8' : 'transparent',
                  transition: 'background-color 0.3s'
                }"
                @click="selectGroupForSendCard(group.id)"
              >
                <input 
                  type="radio" 
                  name="selectedGroup" 
                  :value="group.id" 
                  :id="`group-${group.id}`"
                  class="send-group-card-radio"
                  :checked="selectedGroupIdForSendCard === group.id"
                  @click.stop
                >
                <img
                  v-if="group.avatar_url || group.avatarUrl"
                  :src="getGroupAvatarUrl(group)"
                  :alt="group.group_name || group.name"
                  style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; margin-left: 10px; flex-shrink: 0;"
                  @error="$event.target.style.display='none'"
                >
                <div
                  v-else
                  style="width: 32px; height: 32px; border-radius: 50%; background-color: #3498db; color: white !important; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; margin-left: 10px; flex-shrink: 0;"
                >{{ (group.group_name || group.name || 'G').charAt(0).toUpperCase() }}</div>
                <label 
                  :for="`group-${group.id}`"
                  style="margin-left: 10px; cursor: pointer; flex: 1;"
                >{{ group.group_name || group.name || '未命名群组' }}</label>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button id="cancelSendGroupCard" class="cancel-btn" @click="modalStore.closeModal('sendGroupCard')">取消</button>
          <button id="confirmSendGroupCard" class="save-btn" :disabled="!selectedGroupIdForSendCard" @click="handleSendGroupCard">发送</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 用户资料模态框（私聊信息面板，盒子IM风格） -->
  <Teleport to="body" v-if="modalStore.showUserProfileModal">
    <div id="userProfileModal" class="modal" :style="modalStyle" @click="modalStore.closeModal('userProfile')">
      <div class="modal-content" @click.stop>
        <span class="close" id="closeUserProfileModal" @click="modalStore.closeModal('userProfile')">&times;</span>
        <div v-if="modalStore.modalData.userProfile" class="chat-private-side">
          <template v-if="!isFriendDeleted">
            <!-- 顶部个人卡 -->
            <div class="friend-info-section">
              <div class="friend-card">
                <div class="friend-avatar" @click="openUserProfileAvatarPreview">
                  <img v-if="userProfileAvatarUrl" :src="userProfileAvatarUrl" alt="用户头像" class="avatar-image" loading="lazy" @error="handleUserProfileAvatarError">
                  <span v-else class="avatar-text">{{ getUserInitials(modalStore.modalData.userProfile.nickname) }}</span>
                  <div v-if="isUserOnline(modalStore.modalData.userProfile.id)" class="online" title="用户当前在线"></div>
                </div>
                <div class="friend-details">
                  <div class="friend-name-row">
                    <h4 class="friend-name">{{ modalStore.modalData.userProfile.nickname }}</h4>
                    <i v-if="modalStore.modalData.userProfile.gender === 1 || modalStore.modalData.userProfile.gender === 2" class="gender-icon fas" :class="modalStore.modalData.userProfile.gender === 1 ? 'fa-mars male' : 'fa-venus female'"></i>
                  </div>
                  <div class="friend-id-row">
                    <span class="friend-id">ID: {{ userProfileDisplayId }}</span>
                    <i class="copy-btn fas fa-copy" title="复制用户ID" @click="copyUserId"></i>
                  </div>
                </div>
              </div>
            </div>

            <!-- 设置开关卡片 -->
            <div class="personal-setting">
              <div class="switch-item">
                <div class="label"><i class="fas fa-bell-slash"></i><span>消息免打扰</span></div>
                <label class="switch">
                  <input type="checkbox" :checked="userProfileIsMuted" @change="handleUserProfileToggleMute">
                  <span class="slider round"></span>
                </label>
              </div>
              <div v-if="userProfileIsFriend" class="switch-item">
                <div class="label"><i class="fas fa-ban"></i><span>加入黑名单</span></div>
                <label class="switch">
                  <input type="checkbox" v-model="userProfileIsBlocked" @change="handleUserProfileToggleBlockUser" :disabled="userProfileBlockingLoading">
                  <span class="slider round"></span>
                </label>
              </div>
            </div>

            <!-- 备注卡片 -->
            <div v-if="userProfileIsFriend" class="friend-info-section-card">
              <div class="info-item">
                <div class="info-label"><i class="fas fa-pen"></i><span>备注名</span></div>
                <div class="info-content">
                  <template v-if="!isEditingRemark">
                    <div class="info-display" @click="startEditRemark">
                      <span class="info-text">{{ userProfileRemark || modalStore.modalData.userProfile.nickname }}</span>
                      <i class="fas fa-pen-to-square icon-edit-outline"></i>
                    </div>
                  </template>
                  <template v-else>
                    <input type="text" v-model="tempRemark" placeholder="输入备注名称" maxlength="100" @keyup.enter="saveRemark" @keyup.esc="cancelEditRemark" @blur="handleRemarkBlur" ref="remarkInput" class="remark-input">
                  </template>
                </div>
              </div>
            </div>

            <!-- 文字按钮组 -->
            <div class="btn-group">
              <div id="deleteFriendButton" class="text-btn danger" @click="handleDeleteFriend"> 删除好友 </div>
            </div>
          </template>
          <template v-else>
            <div style="text-align: center; padding: 40px 20px;">
              <i class="fas fa-trash-can" style="font-size: 48px; color: #ccc; margin-bottom: 16px;"></i>
              <div style="font-size: 18px; font-weight: 600; color: #555; margin-bottom: 8px;">该好友已被删除</div>
              <div style="font-size: 14px; color: #999;">您可以删除该好友的本地记录</div>
              <div class="btn-group" style="justify-content: center; margin-top: 20px;">
                <div id="deleteFriendLocalRecordButton" class="text-btn danger" @click="handleDeleteFriendLocalRecord"> 删除会话 </div>
              </div>
            </div>
          </template>
        </div>
        <div v-else class="chat-private-side">
          <span>加载用户资料中...</span>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 用户搜索模态框 -->
  <Teleport to="body" v-if="modalStore.showUserSearchModal">
    <div id="userSearchModal" class="modal" :style="modalStyle" @click="modalStore.closeModal('userSearch')">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h2>搜索用户</h2>
          <span class="close" id="closeUserSearchModal" @click="modalStore.closeModal('userSearch')">&times;</span>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="searchKeyword">搜索关键词:</label>
            <input type="text" id="searchKeyword" placeholder="输入用户名或昵称" required v-model="searchKeyword">
          </div>
          <div id="searchResults" class="search-results" style="max-height: 300px; overflow-y: auto; margin-top: 15px;">
            <div v-if="searching" style="text-align: center; color: #999; padding: 20px;">搜索中...</div>
            <div v-else-if="searchResults.length === 0 && hasSearched" style="text-align: center; color: #999; padding: 20px;">未找到匹配的用户</div>
            <div v-else v-for="user in searchResults" :key="user.id" style="display: flex; align-items: center; padding: 12px; margin-bottom: 8px; background: white; border: 1px solid #e0e0e0; border-radius: 8px;">
              <div class="user-avatar-small" style="width: 40px; height: 40px; border-radius: 50%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-right: 12px;">
                <img v-if="user.avatarUrl || user.avatar_url || user.avatar" :src="getFullAvatarUrl(user.avatarUrl || user.avatar_url || user.avatar)" :alt="user.nickname" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                <span v-else style="font-size: 16px; font-weight: 600; color: #666;">{{ getUserInitials(user.nickname) }}</span>
              </div>
              <div class="user-details" style="flex: 1;">
                <div class="user-nickname" style="font-weight: 600; font-size: 15px;">{{ user.nickname }}</div>
                <div class="user-username" style="color: #666; font-size: 13px;">@{{ user.username }}</div>
              </div>
              <button v-if="isSearchResultUserFriend(user.id)" class="message-friend-btn" @click="handleMessageFriendFromSearch(user)" style="width: 32px; height: 32px; border-radius: 50%; background: #27ae60; color: white; border: none; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="发消息"><i class="fas fa-comment-dots" style="font-size: 16px;"></i></button>
              <button v-else class="add-friend-btn" @click="handleAddFriend(user)" style="width: 32px; height: 32px; border-radius: 50%; background: #3498db; color: white; border: none; font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="添加好友">+</button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button id="cancelUserSearch" class="cancel-btn" @click="modalStore.closeModal('userSearch')">取消</button>
          <button id="confirmUserSearch" class="save-btn" @click="handleUserSearch">搜索</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 图片预览模态框 -->
  <Teleport to="body" v-if="modalStore.showImagePreviewModal">
    <div id="imagePreviewModal" class="modal" :style="imagePreviewModalStyle" @click="modalStore.closeModal('imagePreview')" @keydown="handleImagePreviewKeydown" tabindex="0" ref="imagePreviewRef">
      <div style="position: relative; max-width: 90%; max-height: 90%;" @click.stop>
        <img id="previewImgElement" :src="modalStore.modalData.imagePreviewUrl" alt="图片预览" style="width: 100%; height: auto; max-width: 90vw; max-height: 90vh; aspect-ratio: 16/9; object-fit: contain;" loading="lazy">
        <span class="close" id="closeImagePreviewModal" style="position: absolute; top: -30px; right: -30px; color: #f1f1f1; font-size: 40px; font-weight: bold; cursor: pointer;" @click="modalStore.closeModal('imagePreview')">&times;</span>
      </div>
    </div>
  </Teleport>

  <!-- 头像预览模态框 -->
  <Teleport to="body" v-if="modalStore.showAvatarPreviewModal">
    <div id="avatarPreviewModal" class="modal" :style="avatarPreviewModalStyle" @click="modalStore.closeModal('avatarPreview')">
      <div style="position: relative; max-width: 300px; max-height: 300px;" @click.stop>
        <img id="previewAvatarElement" :src="modalStore.modalData.avatarPreviewUrl" alt="头像预览" style="width: 300px; height: 300px; border-radius: 50%; object-fit: cover;">
        <span class="close" id="closeAvatarPreviewModal" style="position: absolute; top: -30px; right: -30px; color: #f1f1f1; font-size: 40px; font-weight: bold; cursor: pointer;" @click="modalStore.closeModal('avatarPreview')">&times;</span>
      </div>
    </div>
  </Teleport>

  <!-- 添加成员模态框 -->
  <Teleport to="body" v-if="showAddGroupMembersModal">
    <div id="addGroupMembersModal" class="modal" :style="modalStyle" @click="showAddGroupMembersModal = false">
      <div class="modal-content" style="max-height: 90vh; max-width: 500px; width: 90%; display: flex; flex-direction: column;" @click.stop>
        <div class="modal-header" style="flex-shrink: 0;">
          <h2>添加成员</h2>
          <span class="close" @click="showAddGroupMembersModal = false">&times;</span>
        </div>
        <div class="modal-body" style="flex: 1; overflow-y: auto;">
          <div id="availableMembersList" style="max-height: 400px; overflow-y: auto;">
            <div v-if="availableFriendsForAdd.length === 0" style="text-align: center; color: #999; padding: 30px;">没有可添加的好友</div>
            <div v-else v-for="friend in availableFriendsForAdd" :key="friend.id" class="member-item" style="display: flex; align-items: center; padding: 10px; margin-bottom: 8px; background: white; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer;">
              <input type="checkbox" :id="'friend-' + friend.id" :value="friend.id" v-model="selectedFriendIdsForAdd" style="width: 20px; height: 20px; cursor: pointer; flex-shrink: 0;">
              <div style="display: flex; align-items: center; position: relative; margin-left: 12px;">
                <div style="width: 36px; height: 36px; border-radius: 50%; background: #3498db; display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden;">
                  <img v-if="getMemberAvatarUrl(friend)" :src="getMemberAvatarUrl(friend)" :alt="friend.nickname || friend.username" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">
                  <span v-else style="font-size: 16px; color: white; font-weight: bold;">{{ (friend.nickname || friend.username || 'U').charAt(0).toUpperCase() }}</span>
                </div>
                <!-- 在线状态指示器 -->
                <div v-if="isMemberOnline(friend.id)" style="position: absolute; bottom: -2px; right: -6px; width: 10px; height: 10px; background: #2ed573; border: 2px solid white; border-radius: 50%;"></div>
              </div>
              <label :for="'friend-' + friend.id" style="flex: 1; margin-left: 12px; cursor: pointer; font-weight: 500; text-align: left;">{{ friend.nickname || friend.username }} <span style="color: #666; font-size: 14px;">ID: {{ friend.id }}</span></label>
            </div>
          </div>
          <div id="addMembersMessage" style="margin-top: 10px;"></div>
        </div>
        <div class="modal-footer" style="flex-shrink: 0; gap: 12px;">
          <button class="cancel-btn" @click="showAddGroupMembersModal = false" style="background: #ff4757; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 14px; cursor: pointer;">取消</button>
          <button class="save-btn" @click="confirmAddGroupMembers" style="background: #2ed573; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 14px; cursor: pointer;">添加成员</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 用户头像小弹窗 -->
  <Teleport to="body" v-if="modalStore.showUserAvatarPopup">
    <div 
      style="position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 9999; pointer-events: none;"
      @click="modalStore.closeModal('userAvatarPopup')"
    >
      <div 
        id="userAvatarPopup" 
        :style="userAvatarPopupStyle"
        @click.stop
        style="pointer-events: auto;"
      >
        <div class="popup-header">
            <div class="user-avatar-wrapper">
              <div class="popup-avatar">
                <img 
                  id="popupAvatarImg" 
                  :key="userAvatarPopupUserId"
                  :src="userAvatarPopupAvatarUrl" 
                  alt="用户头像"
                  :style="{ display: userAvatarPopupAvatarUrl ? 'block' : 'none' }"
                  @click="openUserAvatarPopupAvatarPreview"
                  @error="handleUserAvatarPopupAvatarError"
                >
                <span 
                  id="popupInitials" 
                  :style="{ display: userAvatarPopupAvatarUrl ? 'none' : 'block' }"
                >{{ userAvatarPopupInitials }}</span>
              </div>
              <div v-if="isUserOnline(modalStore.modalData.userAvatarPopup?.id)" class="online-indicator"></div>
            </div>
          <div class="popup-info">
            <div class="popup-info-top">
              <div id="popupNickname">{{ userAvatarPopupNickname }}</div>
              <span 
                v-if="userAvatarPopupGender && userAvatarPopupGender !== 0" 
                class="gender-icon" 
                :class="userAvatarPopupGender === 1 ? 'male' : 'female'"
                :title="userAvatarPopupGender === 1 ? '男' : '女'"
              >
                <i class="fas" :class="userAvatarPopupGender === 1 ? 'fa-mars' : 'fa-venus'"></i>
              </span>
            </div>
            <div 
              id="popupUsername" 
              :style="{ display: userAvatarPopupUsername ? 'block' : 'none' }"
            >{{ userAvatarPopupUsername }}</div>
          </div>
        </div>
        <div 
          v-if="userAvatarPopupSignature" 
          class="popup-signature-section"
        >
          <div class="signature-label">个性签名</div>
          <div id="popupSignature" class="signature-content">{{ userAvatarPopupSignature }}</div>
        </div>
        <div class="popup-actions">
          <button 
            id="popupAddFriend" 
            :style="userAvatarPopupAddFriendButtonStyle"
            :disabled="userAvatarPopupAddFriendButtonDisabled"
            @click="handleUserAvatarPopupAddFriend"
            v-if="userAvatarPopupAddFriendButtonText !== '已添加'"
          >{{ userAvatarPopupAddFriendButtonText }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 群名片小弹窗 -->
  <Teleport to="body" v-if="modalStore.showGroupCardPopup">
    <div 
      style="position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 9999; pointer-events: none;"
      @click="closeGroupCardPopup"
    >
      <div 
        id="groupCardPopup" 
        :style="groupCardPopupStyle"
        @click.stop
        style="pointer-events: auto;"
      >
        <div class="popup-header">
          <div class="popup-avatar">
            <img 
              v-if="groupCardPopupAvatarUrl" 
              :src="groupCardPopupAvatarUrl" 
              :alt="groupCardPopupData?.group_name"
              :style="{ display: groupCardPopupAvatarUrl ? 'block' : 'none' }"
              @click="openGroupCardPopupAvatarPreview"
              @error="handleGroupCardPopupAvatarError"
            >
            <span 
              :style="{ display: groupCardPopupAvatarUrl ? 'none' : 'block' }"
            >{{ groupCardPopupInitials }}</span>
          </div>
          <div class="popup-info">
            <div class="popup-info-top">
              <div class="popup-nickname">{{ groupCardPopupData?.group_name || '未知群组' }}</div>
            </div>
            <div class="popup-username">ID: {{ groupCardPopupData?.group_id || '未知' }}</div>
          </div>
        </div>
        <div v-if="groupCardPopupData?.group_description" class="popup-signature-section">
          <div class="signature-label">公告</div>
          <div class="signature-content">{{ groupCardPopupData.group_description }}</div>
        </div>
        <div class="popup-actions">
          <button 
            v-if="groupCardPopupIsInGroup"
            class="add-friend-btn"
            @click="handleGroupCardPopupSendMessage"
          >发消息</button>
          <button 
            v-else
            class="add-friend-btn"
            @click="handleGroupCardPopupJoinGroup"
            :disabled="!groupCardPopupData?.invite_token"
          >加入群组</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 好友申请留言对话框 -->
  <Teleport to="body" v-if="friendRequestDialogVisible">
    <div class="modal" :style="modalStyle" @click="cancelFriendRequestDialog">
      <div class="modal-content" style="width: 360px;" @click.stop>
        <div class="modal-header">
          <span>发送好友申请</span>
        </div>
        <div class="modal-body">
          <p style="margin: 0 0 10px 0; font-size: 14px; color: #666;">
            给 <strong>{{ friendRequestDialogTargetNickname }}</strong> 留言
          </p>
          <textarea
            v-model="friendRequestDialogMessage"
            rows="3"
            style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; resize: none; box-sizing: border-box; outline: none;"
            placeholder="请输入留言..."
          ></textarea>
        </div>
        <div class="modal-footer">
          <button class="cancel-btn" @click="cancelFriendRequestDialog">取消</button>
          <button class="save-btn" @click="confirmFriendRequest">发送</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 20px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  transition: .4s;
  border-radius: 20px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background-color: white;
  transition: .4s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: #e74c3c;
}

input:checked + .slider:before {
  transform: translateX(20px);
}

input:disabled + .slider {
  opacity: 0.5;
  cursor: not-allowed;
}

#userAvatarPopup {
  position: fixed;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 15px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  z-index: 10001;
  min-width: 250px;
  opacity: 0;
  transition: opacity 0.1s;
}

#userAvatarPopup.visible {
  opacity: 1;
}

#userAvatarPopup .popup-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

#userAvatarPopup .user-avatar-wrapper {
  position: relative;
  display: inline-flex;
}

#userAvatarPopup .popup-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #3498db;
  color: white;
  font-weight: bold;
}

#userAvatarPopup .online-indicator {
  position: absolute;
  right: -2px;
  bottom: 0;
  width: 10px;
  height: 10px;
  background: limegreen;
  border-radius: 50%;
  border: 2px solid white;
  z-index: 1;
}

#userAvatarPopup .popup-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;
}

#userAvatarPopup .popup-avatar span {
  font-size: 18px;
}

#userAvatarPopup .popup-info {
  flex: 1;
}

#userAvatarPopup .popup-info-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

#userAvatarPopup .popup-info #popupNickname {
  font-weight: bold;
  font-size: 16px;
}

#userAvatarPopup .popup-info #popupUsername {
  font-size: 14px;
  color: #666;
}

#userAvatarPopup .gender-icon {
  font-size: 14px;
  font-weight: bold;
}

#userAvatarPopup .gender-icon.male {
  color: #3498db;
}

#userAvatarPopup .gender-icon.female {
  color: #e91e63;
}

#userAvatarPopup .popup-actions {
  margin-top: 10px;
  display: flex;
  gap: 10px;
}

#userAvatarPopup .popup-actions button {
  flex: 1;
  padding: 8px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

#userAvatarPopup .popup-signature-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #eee;
}

#userAvatarPopup .signature-label {
  font-size: 12px;
  color: #999;
  margin-bottom: 4px;
}

#userAvatarPopup .signature-content {
  font-size: 13px;
  color: #666;
  word-break: break-word;
}

#groupCardPopup {
  position: fixed;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 15px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  z-index: 10001;
  min-width: 250px;
  max-width: 300px;
  opacity: 0;
  transition: opacity 0.1s;
}

#groupCardPopup.visible {
  opacity: 1;
}

#groupCardPopup .popup-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

#groupCardPopup .popup-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #3498db;
  color: white;
  font-weight: bold;
  flex-shrink: 0;
}

#groupCardPopup .popup-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;
}

#groupCardPopup .popup-avatar span {
  font-size: 18px;
}

#groupCardPopup .popup-info {
  flex: 1;
  min-width: 0;
}

#groupCardPopup .popup-info-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

#groupCardPopup .popup-nickname {
  font-weight: bold;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#groupCardPopup .popup-username {
  font-size: 13px;
  color: #666;
}

#groupCardPopup .popup-signature-section {
  margin: 10px 0;
  padding-top: 10px;
  border-top: 1px solid #eee;
}

#groupCardPopup .signature-label {
  font-size: 12px;
  color: #999;
  margin-bottom: 4px;
}

#groupCardPopup .signature-content {
  font-size: 13px;
  color: #666;
  word-break: break-word;
  max-height: 60px;
  overflow-y: auto;
}

#groupCardPopup .popup-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #eee;
}

#groupCardPopup .add-friend-btn {
  flex: 1;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: #3498db;
  color: white;
  transition: background-color 0.2s;
}

#groupCardPopup .add-friend-btn:hover {
  background: #2980b9;
}

#groupCardPopup .add-friend-btn:disabled {
  background: #bdc3c7;
  cursor: not-allowed;
}

:global(body.dark-mode) .group-members-panel,
:global(body.dark-mode) .member-list {
  background: #0d1117 !important;
  border-color: #30363d !important;
}

:global(body.dark-mode) .group-member-row,
:global(body.dark-mode) .member-item,
:global(body.dark-mode) .user-search-result {
  background: #161b22 !important;
  border-color: #30363d !important;
  color: #c9d1d9 !important;
}

:global(body.dark-mode) .user-search-result .user-avatar-small {
  background: #21262d !important;
}

:global(body.dark-mode) .user-search-result .user-username,
:global(body.dark-mode) .member-item span[style*="color: #666"] {
  color: #8b949e !important;
}

:global(body.dark-mode) #userAvatarPopup,
:global(body.dark-mode) #groupCardPopup {
  background: #161b22;
  border-color: #30363d;
  color: #c9d1d9;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

:global(body.dark-mode) #userAvatarPopup .popup-info #popupUsername,
:global(body.dark-mode) #userAvatarPopup .signature-content,
:global(body.dark-mode) #groupCardPopup .popup-username,
:global(body.dark-mode) #groupCardPopup .signature-content {
  color: #8b949e;
}

:global(body.dark-mode) #userAvatarPopup .popup-signature-section,
:global(body.dark-mode) #groupCardPopup .popup-signature-section,
:global(body.dark-mode) #groupCardPopup .popup-actions {
  border-color: #30363d;
}
</style>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import localForage from 'localforage';

import { useBaseStore } from "@/stores/baseStore";
import { useUserStore } from "@/stores/userStore";
import { useFriendStore } from "@/stores/friendStore";
import { useGroupStore } from "@/stores/groupStore";
import { usePublicStore } from "@/stores/publicStore";
import { useModalStore } from "@/stores/modalStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useStorageStore } from "@/stores/storageStore";
import { useUnreadStore } from "@/stores/unreadStore";
import { useDraftStore } from "@/stores/draftStore";
import { useInputStore } from "@/stores/inputStore";
import { registerPopupFunctions } from "@/stores/index.js";
import { 
  addFriend, 
  switchToGroupChat, 
  switchToPrivateChat, 
  loadGroupList, 
  loadFriendsList,
  joinGroupWithToken,
  sendGroupCard
} from "@/utils/chat";
import modal from "@/utils/modal";
import toast from "@/utils/toast";
import request from '@/utils/request.js';
import { searchUsers, checkUserBlockStatus, cancelFriendRequest } from '@/api/user.js';
import { getUserInfo, removeFriend, setFriendRemark, setFriendDisturb } from '@/api/friend.js';
import { getGroupMembers, getGroupInfo, createGroup, setGroupRemark, updateGroupName, setGroupNickname, getGroupNickname, updateGroupDescription, removeGroupMember, setGroupAdmin, muteGroupMember, unmuteGroupMember, setAllMute, getGroupMuteStatus, dissolveGroup, leaveGroup, addGroupMembers, setGroupDisturb } from '@/api/group.js';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

const baseStore = useBaseStore();
const userStore = useUserStore();
const friendStore = useFriendStore();
const groupStore = useGroupStore();
const publicStore = usePublicStore();
const modalStore = useModalStore();
const sessionStore = useSessionStore();
const storageStore = useStorageStore();
const unreadStore = useUnreadStore();
const draftStore = useDraftStore();
const inputStore = useInputStore();

const searchKeyword = ref('');
const searching = ref(false);
const hasSearched = ref(false);
const searchResults = ref([]);
const selectedGroupIdForSendCard = ref(null);
const sendGroupCardList = ref([]);
const loadingSendGroupCardList = ref(false);
const groupMembers = ref([]);
const loadingMembers = ref(false);
const currentTime = ref(Date.now()); // 用于触发 computed 重新计算的时间戳
// 服务器时钟偏移（serverNow - 客户端now），禁言倒计时用它校准，
// 避免客户端时钟偏差导致徽标提前归零但服务器仍在禁言
const serverTimeOffset = ref(0);

// 好友申请留言对话框
const friendRequestDialogVisible = ref(false);
const friendRequestDialogMessage = ref('');
const friendRequestDialogTargetUserId = ref(null);
const friendRequestDialogTargetNickname = ref('');

function showFriendRequestDialog(targetUserId, targetNickname) {
  const myNickname = baseStore.currentUser?.nickname || '用户';
  friendRequestDialogMessage.value = `我是${myNickname}`;
  friendRequestDialogTargetUserId.value = targetUserId;
  friendRequestDialogTargetNickname.value = targetNickname;
  friendRequestDialogVisible.value = true;
}

function confirmFriendRequest() {
  if (friendRequestDialogTargetUserId.value) {
    addFriend(friendRequestDialogTargetUserId.value, friendRequestDialogMessage.value);
  }
  friendRequestDialogVisible.value = false;
  friendRequestDialogMessage.value = '';
  friendRequestDialogTargetUserId.value = null;
  friendRequestDialogTargetNickname.value = '';
}

function cancelFriendRequestDialog() {
  friendRequestDialogVisible.value = false;
  friendRequestDialogMessage.value = '';
  friendRequestDialogTargetUserId.value = null;
  friendRequestDialogTargetNickname.value = '';
}

const availableMembers = ref([]);
const selectedMembers = ref([]);
const activeTab = ref('info');
const newGroupDescription = ref('');
const newGroupName = ref('');
const newGroupDesc = ref('');
const createGroupMessage = ref('');
const createGroupMessageType = ref('');
const isCreatingGroup = ref(false);
const showAddGroupMembersModal = ref(false);
const groupMemberSearchKeyword = ref('');
const groupNameInput = ref(null);
const groupNoticeInput = ref(null);
const groupRemarkInput = ref(null);
const remarkInput = ref(null);
const editingGroupName = ref(false);
const editingGroupNotice = ref(false);
const editingGroupRemark = ref(false);
const tempGroupName = ref('');
const tempGroupNotice = ref('');
const tempGroupRemark = ref('');
const groupUserRemark = ref('');
const editingGroupNickname = ref(false);
const tempGroupNickname = ref('');
const groupNickname = ref('');
const groupNicknameInput = ref(null);
const availableFriendsForAdd = ref([]);
const selectedFriendIdsForAdd = ref([]);

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  member: null
});

const userAvatarPopupLeft = ref(0);
const userAvatarPopupTop = ref(0);
const userAvatarPopupUserId = ref(null);
const userAvatarPopupEvent = ref(null);
const userAvatarPopupAvatarLoadFailed = ref(false);
const userProfileAvatarLoadFailed = ref(false);
const userProfileIsBlocked = ref(false);
const userProfileBlockingLoading = ref(false);
const userProfileRemark = ref('');
const isEditingRemark = ref(false);
const tempRemark = ref('');
const userProfileRemarkLoading = ref(false);
const groupInfoAvatarLoadFailed = ref(false);

let muteTimer = null;

const modalStyle = computed(() => ({
  display: 'flex',
  position: 'fixed',
  zIndex: 1000,
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  justifyContent: 'center',
  alignItems: 'center'
}));

const imagePreviewModalStyle = computed(() => ({
  display: 'flex',
  position: 'fixed',
  zIndex: 10001,
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  overflow: 'auto',
  backgroundColor: 'rgba(0,0,0,0.9)',
  justifyContent: 'center',
  alignItems: 'center'
}));

const imagePreviewRef = ref(null);

function handleImagePreviewKeydown(e) {
  if (e.key === 'Escape') {
    modalStore.closeModal('imagePreview');
  }
}

watch(() => modalStore.showImagePreviewModal, (newVal) => {
  if (newVal) {
    nextTick(() => {
      if (imagePreviewRef.value) {
        imagePreviewRef.value.focus();
      }
    });
  }
});

const avatarPreviewModalStyle = computed(() => ({
  display: 'flex',
  position: 'fixed',
  zIndex: 10001,
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  overflow: 'auto',
  backgroundColor: 'rgba(0,0,0,0.9)',
  justifyContent: 'center',
  alignItems: 'center'
}));

const userAvatarPopupStyle = computed(() => ({
  left: userAvatarPopupLeft.value + 'px',
  top: userAvatarPopupTop.value + 'px',
  position: 'fixed',
  zIndex: '10001',
  maxWidth: '300px',
}));

const groupCardPopupLeft = ref(0);
const groupCardPopupTop = ref(0);
const groupCardPopupEvent = ref(null);

const groupCardPopupStyle = computed(() => ({
  left: groupCardPopupLeft.value + 'px',
  top: groupCardPopupTop.value + 'px',
  position: 'fixed',
  zIndex: '10001',
  maxWidth: '300px',
}));



const userAvatarPopupNickname = computed(() => {
  const nickname = modalStore.modalData.userAvatarPopup?.nickname || '未知昵称';
  return nickname;
});

const userAvatarPopupUsername = computed(() => {
  return modalStore.modalData.userAvatarPopup?.username || '';
});

const userAvatarPopupSignature = computed(() => {
  const signature = modalStore.modalData.userAvatarPopup?.signature || '';
  return signature;
});

const userAvatarPopupGender = computed(() => {
  return modalStore.modalData.userAvatarPopup?.gender || 0;
});

const userAvatarPopupInitials = computed(() => {
  const nickname = userAvatarPopupNickname.value;
  return nickname ? nickname.charAt(0).toUpperCase() : 'U';
});

const userAvatarPopupAvatarUrl = computed(() => {
  if (userAvatarPopupAvatarLoadFailed.value) return '';
  
  const user = modalStore.modalData.userAvatarPopup;
  if (!user) return '';
  
  let url = '';
  if (user.avatarUrl && typeof user.avatarUrl === 'string') {
    url = user.avatarUrl.trim();
  } else if (user.avatar_url && typeof user.avatar_url === 'string') {
    url = user.avatar_url.trim();
  } else if (user.avatar && typeof user.avatar === 'string') {
    url = user.avatar.trim();
  }
  
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
});

function handleUserAvatarPopupAvatarError() {
  userAvatarPopupAvatarLoadFailed.value = true;
}

function handleUserProfileAvatarError() {
  userProfileAvatarLoadFailed.value = true;
}

function handleGroupInfoAvatarError() {
  groupInfoAvatarLoadFailed.value = true;
}

const userProfileAvatarUrl = computed(() => {
  if (userProfileAvatarLoadFailed.value) return '';
  
  const user = modalStore.modalData.userProfile;
  if (!user) return '';
  
  let url = '';
  if (user.avatarUrl && typeof user.avatarUrl === 'string') {
    url = user.avatarUrl.trim();
  } else if (user.avatar_url && typeof user.avatar_url === 'string') {
    url = user.avatar_url.trim();
  } else if (user.avatar && typeof user.avatar === 'string') {
    url = user.avatar.trim();
  }
  
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
});

const userAvatarPopupIsFriend = computed(() => {
  const userId = userAvatarPopupUserId.value;
  if (!userId) return false;
  return friendStore.friendsList.some(friend => String(friend.id) === String(userId) && friend.deleted_at == null);
});

const userAvatarPopupIsCurrentUser = computed(() => {
  const userId = userAvatarPopupUserId.value;
  if (!userId || !baseStore.currentUser) return false;
  return String(baseStore.currentUser.id) === String(userId);
});

const userAvatarPopupHasSentRequest = computed(() => {
  const userId = userAvatarPopupUserId.value;
  if (!userId || !baseStore.sentFriendRequests) return false;
  return baseStore.sentFriendRequests.some(req => String(req.id) === String(userId));
});

const userAvatarPopupAddFriendButtonText = computed(() => {
  if (userAvatarPopupIsCurrentUser.value) {
    return '已添加';
  }
  if (userAvatarPopupIsFriend.value) {
    return '发消息';
  }
  if (userAvatarPopupHasSentRequest.value) {
    return '撤销好友申请';
  }
  return '添加好友';
});

const userAvatarPopupAddFriendButtonDisabled = computed(() => {
  return userAvatarPopupIsCurrentUser.value;
});

const userAvatarPopupAddFriendButtonStyle = computed(() => {
  if (userAvatarPopupIsCurrentUser.value) {
    return {
      backgroundColor: '#ccc',
      color: 'white',
      cursor: 'not-allowed'
    };
  }
  if (userAvatarPopupHasSentRequest.value) {
    return {
      backgroundColor: '#f0ad4e',
      color: 'white',
      cursor: 'pointer'
    };
  }
  return {
    backgroundColor: '#3498db',
    color: 'white',
    cursor: 'pointer'
  };
});

const isCurrentUserGroupOwner = computed(() => {
  if (!modalStore.modalData.groupInfo || !baseStore.currentUser) {
    return false;
  }
  return String(modalStore.modalData.groupInfo.creator_id) === String(baseStore.currentUser.id);
});

// 检查当前用户是否是群管理员（包括群主）
const isCurrentUserGroupAdmin = computed(() => {
  if (isCurrentUserGroupOwner.value) return true;
  
  const currentUserId = baseStore.currentUser?.id;
  const groupId = modalStore.modalData.groupInfo?.id;
  
  if (!currentUserId || !groupId || !groupMembers.value.length) {
    return false;
  }
  
  // 在成员列表中查找当前用户是否是管理员
  const currentUserMember = groupMembers.value.find(m => String(m.id) === String(currentUserId));
  return currentUserMember && currentUserMember.is_admin === 1;
});

const isGroupDeleted = computed(() => {
  return modalStore.modalData.groupInfo?.deleted_at != null;
});

const isFriendDeleted = computed(() => {
  return modalStore.modalData.userProfile?.deleted_at != null;
});

const userProfileDisplayId = computed(() => {
  const profile = modalStore.modalData.userProfile;
  if (!profile) return '';
  return profile.username || profile.id || '';
});

const userProfileIsMuted = computed(() => {
  const userId = modalStore.modalData.userProfile?.id;
  if (!userId) return false;
  const friend = friendStore.friendsList.find(f => String(f.id) === String(userId));
  return friend ? friend.is_disturb == 1 : false;
});

const userProfileIsFriend = computed(() => {
  const userId = modalStore.modalData.userProfile?.id;
  if (!userId || !baseStore.currentUser) return false;
  if (String(baseStore.currentUser.id) === String(userId)) return false;
  return friendStore.friendsList.some(friend => String(friend.id) === String(userId) && friend.deleted_at == null);
});

const groupInfoName = computed(() => {
  const name = modalStore.modalData.groupInfo?.name || '';
  return name;
});

const groupInfoDescription = computed(() => {
  const desc = modalStore.modalData.groupInfo?.description || '暂无公告';
  return desc;
});

const groupInfoInitials = computed(() => {
  const name = groupInfoName.value;
  return name ? name.charAt(0).toUpperCase() : 'G';
});

// 群组信息面板：当前群组是否免打扰（使用store中的is_disturb，与会话列表右键逻辑一致）
const groupInfoIsMuted = computed(() => {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) return false;
  const group = groupStore.groupsList.find(g => String(g.id) === String(groupId));
  return group ? group.is_disturb == 1 : false;
});

const groupCardPopupData = computed(() => {
  return modalStore.modalData.groupCardPopup;
});

const groupCardPopupInitials = computed(() => {
  const name = groupCardPopupData.value?.group_name || '';
  return name ? name.charAt(0).toUpperCase() : 'G';
});

const groupCardPopupAvatarLoadFailed = ref(false);

const groupCardPopupAvatarUrl = computed(() => {
  if (groupCardPopupAvatarLoadFailed.value) return '';
  
  const data = groupCardPopupData.value;
  if (!data) return '';
  
  let url = data.avatar_url || data.avatarUrl || '';
  if (!url) return '';
  
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
});

const groupCardPopupIsInGroup = computed(() => {
  return groupStore.groupsList && groupStore.groupsList.some(g => String(g.id) === String(groupCardPopupData.value?.group_id) && g.deleted_at == null);
});

function closeGroupCardPopup() {
  modalStore.closeModal('groupCardPopup');
  document.removeEventListener('click', closeGroupCardPopup);
  document.removeEventListener('contextmenu', closeGroupCardPopup);
  window.removeEventListener('scroll', closeGroupCardPopup);
}

function handleGroupCardPopupAvatarError() {
  groupCardPopupAvatarLoadFailed.value = true;
}

function openGroupCardPopupAvatarPreview() {
  if (groupCardPopupAvatarUrl.value) {
    modalStore.openModal('imagePreview', groupCardPopupAvatarUrl.value);
  }
}

function updateGroupCardPopupPosition(event) {
  const popup = document.getElementById('groupCardPopup');
  if (!popup) return;
  
  const popupRect = popup.getBoundingClientRect();
  const popupWidth = popupRect.width || 250;
  const popupHeight = popupRect.height || 150;
  
  let left = event.clientX;
  let top = event.clientY;
  
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  if (left + popupWidth > viewportWidth) {
    left = viewportWidth - popupWidth - 10;
  }
  
  if (top + popupHeight > viewportHeight) {
    top = event.clientY - popupHeight - 10;
  }
  
  if (left < 0) {
    left = 10;
  }
  
  if (top < 0) {
    top = 10;
  }
  
  groupCardPopupLeft.value = left;
  groupCardPopupTop.value = top;
}

async function showGroupCardPopupVue(event, groupData) {
  event.stopPropagation();
  
  groupCardPopupEvent.value = event;
  groupCardPopupLeft.value = event.clientX;
  groupCardPopupTop.value = event.clientY;
  
  modalStore.openModal('groupCardPopup', groupData);
  
  await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  updateGroupCardPopupPosition(event);
  
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  const popup = document.getElementById('groupCardPopup');
  if (popup) {
    popup.classList.add('visible');
  }
  
  setTimeout(() => {
    document.addEventListener('click', closeGroupCardPopup);
    document.addEventListener('contextmenu', closeGroupCardPopup);
    window.addEventListener('scroll', closeGroupCardPopup);
  }, 0);
}

function handleGroupCardPopupSendMessage() {
  const data = groupCardPopupData.value;
  if (data) {
    switchToGroupChat(data.group_id, data.group_name, data.avatar_url || data.avatarUrl || '');
    setTimeout(() => {
      groupStore.updateGroupSessionTime(data.group_id);
    }, 200);
  }
  closeGroupCardPopup();
}

function handleGroupCardPopupJoinGroup() {
  const data = groupCardPopupData.value;
  if (data && data.invite_token) {
    joinGroupWithToken(data.invite_token, data.group_id, data.group_name, null, true);
  }
  closeGroupCardPopup();
}

const groupInfoAvatarUrl = computed(() => {
  if (groupInfoAvatarLoadFailed.value) return '';
  
  const group = modalStore.modalData.groupInfo;
  if (!group) return '';
  
  let url = '';
  if (group.avatar_url && typeof group.avatar_url === 'string') {
    url = group.avatar_url.trim();
  } else if (group.avatarUrl && typeof group.avatarUrl === 'string') {
    url = group.avatarUrl.trim();
  } else if (group.avatar && typeof group.avatar === 'string') {
    url = group.avatar.trim();
  }
  
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
});

function getFullAvatarUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${baseStore.SERVER_URL}${url}`;
}

function getUserInitials(name) {
  if (!name) return 'U';
  return name.charAt(0).toUpperCase();
}

function getGenderText(gender) {
  if (gender === 1) return '男';
  if (gender === 2) return '女';
  return '保密';
}

function isUserOnline(userId) {
  return userStore.onlineUsers.some(user => String(user.id) === String(userId));
}

async function handleUserSearch() {
  if (!searchKeyword.value.trim()) {
    return;
  }
  
  searching.value = true;
  hasSearched.value = true;
  
  try {
    const user = baseStore.currentUser;
    const sessionToken = baseStore.currentSessionToken;
    
    const response = await searchUsers(searchKeyword.value.trim());
    const data = response.data;
    const users = data.users || [];
    
    searchResults.value = users.filter(u => {
      const isCurrentUser = String(u.id) === String(user?.id);
      return !isCurrentUser;
    });
  } catch (error) {
    console.error('搜索用户失败:', error);
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

function handleAddFriend(user) {
  if (user && user.friend_verification === false) {
    // 对方明确未开启好友验证，无需留言，直接发送
    const myNickname = baseStore.currentUser?.nickname || '用户';
    addFriend(user.id, `我是${myNickname}`);
    return;
  }
  // 对方开启了好友验证（或信息未知时回退为弹窗留言，避免遗漏）
  showFriendRequestDialog(user.id, user.nickname || user.username);
}

function isSearchResultUserFriend(userId) {
  return friendStore.friendsList.some(friend => String(friend.id) === String(userId) && !friend.deleted_at);
}

function handleMessageFriendFromSearch(user) {
  modalStore.closeModal('userSearch');
  switchToPrivateChat(
    user.id,
    user.nickname || user.username,
    user.username,
    user.avatarUrl || user.avatar_url || user.avatar
  );
  setTimeout(() => {
    friendStore.updateFriendSessionTime(user.id);
  }, 200);
}

function getGroupAvatarUrl(group) {
  const url = group.avatar_url || group.avatarUrl || '';
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
}

function handleSendGroupCard() {
  if (selectedGroupIdForSendCard.value) {
    sessionStore.selectedGroupIdForCard = selectedGroupIdForSendCard.value;
    sendGroupCard();
  }
}

watch(() => modalStore.showSendGroupCardModal, (newVal) => {
  if (newVal) {
    selectedGroupIdForSendCard.value = null;
    sendGroupCardList.value = (groupStore.groupsList || []).filter(g => !g.deleted_at);
  }
});

watch(() => modalStore.showUserAvatarPopup, (newVal) => {
  if (newVal) {
    userAvatarPopupAvatarLoadFailed.value = false;
  }
});

watch(() => modalStore.showUserProfileModal, (newVal) => {
  if (newVal) {
    userProfileAvatarLoadFailed.value = false;
    userProfileIsBlocked.value = false;
    isEditingRemark.value = false;
    tempRemark.value = '';
    userProfileRemarkLoading.value = false;

    const userId = modalStore.modalData.userProfile?.id;
    if (userId && friendStore.friendsList) {
      const currentFriend = friendStore.friendsList.find(f => String(f.id) === String(userId));
      userProfileRemark.value = currentFriend?.remark || '';
    } else {
      userProfileRemark.value = '';
    }

    if (userId && userProfileIsFriend.value) {
      checkUserBlockStatus(userId)
      .then(res => {
        const data = res.data;
        userProfileIsBlocked.value = data.isBlocked;
      })
      .catch(e => {
        console.error('查询拉黑状态失败:', e);
      });
    }
  }
});

watch(() => modalStore.showGroupInfoModal, (newVal) => {
  if (newVal) {
    groupInfoAvatarLoadFailed.value = false;
  }
});

function selectGroupForSendCard(groupId) {
  selectedGroupIdForSendCard.value = groupId;
  sessionStore.selectedGroupIdForCard = groupId;
}

async function loadGroupMembers(groupId) {
  if (!groupId) return;
  
  try {
    const response = await getGroupMembers(groupId);
    const data = response.data;
    if (data.members) {
      // 1. 更新本地状态（用于模态框显示）
      // 保留现有禁言状态，等待 loadGroupMuteStatus 返回权威数据，避免刷新期间徽标闪烁
      groupMembers.value = data.members.map(member => {
        const existing = groupMembers.value.find(m => String(m.id) === String(member.id));
        return {
          ...member,
          nickname: member.nickname || member.username || '',
          is_muted: existing ? existing.is_muted : false,
          muted_until: existing ? existing.muted_until : null,
          isPermanentMuted: existing ? existing.isPermanentMuted : false
        };
      });
      
      // 2. 同步更新 groupStore.currentGroupMembers（确保数据一致性）
      
      // 构建完整的成员对象（包含群昵称等字段）
      const storeMembers = data.members.map(member => ({
        id: Number(member.id),
        nickname: member.nickname || member.username || '',
        avatarUrl: member.avatarUrl || '',
        is_admin: Number(member.is_admin) || 0,
        is_muted: member.is_muted || null,
        group_nickname: member.group_nickname || null  // 确保包含群昵称字段
      }));
      
      // 更新 groupStore（触发响应式）
      groupStore.currentGroupMembers = storeMembers;
      
      // 检测群昵称变更并更新消息列表中的 stored groupNickname
      
      // 3. 同步更新 IndexedDB 中的成员列表（可选，用于离线访问）
      try {
        const userId = baseStore.currentUser?.id || 'guest';
        const prefix = `chats-${userId}`;
        const key = `${prefix}-group-${groupId}-members`;
        
        await localForage.setItem(key, {
          members: storeMembers,
          updatedAt: new Date().toISOString()
        });
        
        } catch (e) {
        console.warn('⚠️ [loadGroupMembers] IndexedDB 存储失败:', e);
      }
      
      // 加载禁言状态
      loadGroupMuteStatus(groupId);
    }
  } catch (error) {
    console.error('加载群组成员失败:', error);
  }
}

// 群组成员排序：在线成员在前，按ID排序
const sortedGroupMembers = computed(() => {
  const online = [];
  const offline = [];
  
  for (const member of groupMembers.value) {
    if (isMemberOnline(member.id)) {
      online.push(member);
    } else {
      offline.push(member);
    }
  }
  
  // 按ID排序
  online.sort((a, b) => a.id - b.id);
  offline.sort((a, b) => a.id - b.id);
  
  return [...online, ...offline];
});

// 计算每个成员的禁言状态显示
const membersWithMuteStatus = computed(() => {
  // 访问 currentTime 来建立依赖关系，确保时间变化时重新计算
  // 加上服务器时钟偏移，使倒计时基于服务器时间
  const now = currentTime.value + serverTimeOffset.value;
  
  return sortedGroupMembers.value.map(member => {
    // 首先检查是否有禁言标记
    if (!member.is_muted) {
      return {
        ...member,
        muteStatusText: '',
        isPermanentMute: false
      };
    }
    
    // 检查是否是永久禁言（优先于 muted_until 检查，因为永久禁言的 muted_until 可能为 null）
    if (member.isPermanentMuted) {
      return {
        ...member,
        muteStatusText: '🔒 永久禁言',
        isPermanentMute: true
      };
    }
    
    // 通过 mutedUntil 值检测永久禁言（9999年或超过100年）
    if (member.muted_until && isPermanentMute(member.muted_until)) {
      return {
        ...member,
        muteStatusText: '🔒 永久禁言',
        isPermanentMute: true
      };
    }
    
    // 如果没有 muted_until 时间，且不是永久禁言，则显示未禁言
    if (!member.muted_until) {
      return {
        ...member,
        muteStatusText: '',
        isPermanentMute: false
      };
    }
    
    // 临时禁言
    const mutedTime = parseMuteTime(member.muted_until);
    const diffMs = mutedTime.getTime() - now;
    
    // 已过期
    if (diffMs <= 0) {
      return {
        ...member,
        muteStatusText: '',
        isPermanentMute: false
      };
    }
    
    // 计算剩余时间显示
    const timeStr = formatMuteTimeWithNow(mutedTime, now);
    return {
      ...member,
      muteStatusText: `⏰ ${timeStr}`,
      isPermanentMute: false
    };
  });
});

// 群信息面板预览成员：最多展示 3 行 × 4 个 = 12 个，其余通过“查看全部”进入完整列表
const previewGroupMembers = computed(() => membersWithMuteStatus.value.slice(0, 12));

// 群成员完整列表：按关键字过滤
const filteredGroupMembers = computed(() => {
  const keyword = groupMemberSearchKeyword.value.trim().toLowerCase();
  if (!keyword) return membersWithMuteStatus.value;
  return membersWithMuteStatus.value.filter(member => {
    const name = (getMemberDisplayName(member) || '').toLowerCase();
    const username = (member.username || '').toLowerCase();
    return name.includes(keyword) || username.includes(keyword);
  });
});

// 群成员完整列表可见项（当前展示全部；后续做分页时在此按 page/pageSize 切片即可）
const visibleGroupMembers = computed(() => filteredGroupMembers.value);

// 打开群成员完整列表
function openGroupMembersModal() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) return;
  groupMemberSearchKeyword.value = '';
  modalStore.openModal('groupMembers');
  loadGroupMembers(groupId);
}

// 判断成员是否在线
function isMemberOnline(memberId) {
  if (!userStore.onlineUsers) return false;
  return userStore.onlineUsers.some(u => String(u.id) === String(memberId));
}

// 获取成员头像URL
function getMemberAvatarUrl(member) {
  let url = '';
  if (member.avatarUrl && typeof member.avatarUrl === 'string') {
    url = member.avatarUrl.trim();
  } else if (member.avatar_url && typeof member.avatar_url === 'string') {
    url = member.avatar_url.trim();
  } else if (member.avatar && typeof member.avatar === 'string') {
    url = member.avatar.trim();
  }
  
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
}

// 获取成员昵称首字母
function getMemberInitials(member) {
  const name = member.nickname || member.username || 'U';
  return name.charAt(0).toUpperCase();
}

async function loadAvailableMembers() {
  loadingMembers.value = true;
  try {
    const user = baseStore.currentUser;
    
    if (friendStore.friendsList && Array.isArray(friendStore.friendsList)) {
      availableMembers.value = friendStore.friendsList
        .filter(friend => {
          const isNotCurrentUser = String(friend.id) !== String(user?.id);
          const isNotDeleted = !friend.deleted_at;
          return isNotCurrentUser && isNotDeleted;
        })
        .map(friend => ({
          id: friend.id,
          nickname: friend.nickname || friend.username || '',
          avatarUrl: friend.avatar_url || friend.avatarUrl || ''
        }));
    } else {
      availableMembers.value = [];
    }
  } catch (error) {
    console.error('加载可用成员失败:', error);
    availableMembers.value = [];
  } finally {
    loadingMembers.value = false;
  }
}

function handleSelectAllMembers(event) {
  if (event.target.checked) {
    selectedMembers.value = availableMembers.value.map(user => user.id);
  } else {
    selectedMembers.value = [];
  }
}

async function handleCreateGroup() {
  if (isCreatingGroup.value) return;
  const groupName = newGroupName.value.trim();
  const groupDescription = newGroupDesc.value.trim();
  const selectedMemberIds = selectedMembers.value;

  if (!groupName) {
    createGroupMessage.value = '群组名称不能为空';
    createGroupMessageType.value = 'error';
    return;
  }

  createGroupMessage.value = '';
  isCreatingGroup.value = true;

  try {
    const user = baseStore.currentUser;
    const sessionToken = baseStore.currentSessionToken;

    if (!user || !sessionToken) {
      createGroupMessage.value = '未登录，请先登录';
      createGroupMessageType.value = 'error';
      return;
    }

    const response = await createGroup({
        userId: user.id,
        groupName: groupName,
        description: groupDescription,
        memberIds: selectedMemberIds
      });
      const data = response.data;

    createGroupMessage.value = '群组创建成功';
    createGroupMessageType.value = 'success';

    if (data.createMessage && data.createMessage.groupId) {
      groupStore.addGroupMessage(data.createMessage.groupId, data.createMessage);
    }

    setTimeout(() => {
      modalStore.closeModal('createGroup');
      newGroupName.value = '';
      newGroupDesc.value = '';
      selectedMembers.value = [];
      createGroupMessage.value = '';
      isCreatingGroup.value = false;
    }, 1000);
  } catch (error) {
    console.error('创建群组失败:', error);
    createGroupMessage.value = error.response?.data?.message || error.message || '群组创建失败';
    createGroupMessageType.value = 'error';
    isCreatingGroup.value = false;
  }
}

watch(() => modalStore.showGroupInfoModal, (newVal) => {
  if (newVal && modalStore.modalData.groupInfo) {
    if (modalStore.modalData.groupInfo.deleted_at == null) {
      loadGroupMembers(modalStore.modalData.groupInfo.id);
    }
    // 启动或重启倒计时定时器
    startMuteTimer();
  } else {
    groupMembers.value = [];
    // 关闭模态框时停止定时器，节省资源
    stopMuteTimer();
  }
});

watch(() => modalStore.showCreateGroupModal, (newVal) => {
  if (newVal) {
    selectedMembers.value = [];
    newGroupName.value = '';
    newGroupDesc.value = '';
    createGroupMessage.value = '';
    loadAvailableMembers();
  }
});

watch(() => modalStore.showGroupInfoModal, (newVal) => {
  if (newVal && modalStore.modalData.groupInfo) {
    activeTab.value = 'info';
    newGroupDescription.value = modalStore.modalData.groupInfo.description || '';
    editingGroupName.value = false;
    editingGroupNotice.value = false;
    tempGroupName.value = modalStore.modalData.groupInfo.name || '';
    tempGroupNotice.value = modalStore.modalData.groupInfo.description || '';
    editingGroupRemark.value = false;
    tempGroupRemark.value = '';
    
    // 加载当前用户的群组备注
    const groupId = modalStore.modalData.groupInfo?.id;
    if (groupId) {
      // 先从本地store中查找
      const currentGroup = groupStore.groupsList?.find(g => String(g.id) === String(groupId));
      if (currentGroup && currentGroup.user_remark) {
        groupUserRemark.value = currentGroup.user_remark;
      } else {
        // 如果本地没有，从服务器获取
        request.get(`/api/group-remark/${groupId}`)
        .then(res => {
          const data = res.data;
          groupUserRemark.value = data.remark || '';
        })
        .catch(e => {
          console.error('获取群组备注失败:', e);
        });
      }
      
      // 加载当前用户的群昵称
      loadGroupNickname();
    } else {
      groupUserRemark.value = '';
      groupNickname.value = '';
    }
  }
});

watch(() => modalStore.showGroupCardPopup, (newVal) => {
  if (newVal) {
    groupCardPopupAvatarLoadFailed.value = false;
  }
});

function startEditGroupName() {
  tempGroupName.value = modalStore.modalData.groupInfo.name || '';
  editingGroupName.value = true;
  nextTick(() => {
    if (groupNameInput.value) {
      groupNameInput.value.focus();
      groupNameInput.value.select();
    }
  });
}

function cancelEditGroupName() {
  editingGroupName.value = false;
  tempGroupName.value = modalStore.modalData.groupInfo.name || '';
}

async function handleGroupNameBlur() {
  // 只有当值变化时才保存
  if (tempGroupName.value.trim() !== modalStore.modalData.groupInfo.name) {
    await saveGroupName();
  } else {
    editingGroupName.value = false;
  }
}

async function saveGroupName() {
  if (!tempGroupName.value.trim()) {
    toast.error('群组名称不能为空');
    return;
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await updateGroupName(Number(groupId), tempGroupName.value.trim());
    const data = response.data;
    toast.success('群组名称已更新');
    modalStore.modalData.groupInfo.name = tempGroupName.value.trim();
    editingGroupName.value = false;
  } catch (error) {
    console.error('更新群组名称失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '更新群组名称失败';
    toast.error(errorMessage);
  }
}

function startEditGroupNotice() {
  tempGroupNotice.value = modalStore.modalData.groupInfo.description || '';
  editingGroupNotice.value = true;
  nextTick(() => {
    if (groupNoticeInput.value) {
      groupNoticeInput.value.focus();
      groupNoticeInput.value.select();
    }
  });
}

function cancelEditGroupNotice() {
  editingGroupNotice.value = false;
  tempGroupNotice.value = modalStore.modalData.groupInfo.description || '';
}

async function handleGroupNoticeBlur() {
  // 只有当值变化时才保存
  if (tempGroupNotice.value !== modalStore.modalData.groupInfo.description) {
    await saveGroupNotice();
  } else {
    editingGroupNotice.value = false;
  }
}

function startEditGroupRemark() {
  tempGroupRemark.value = groupUserRemark.value || '';
  editingGroupRemark.value = true;
  nextTick(() => {
    if (groupRemarkInput.value) {
      groupRemarkInput.value.focus();
      groupRemarkInput.value.select();
    }
  });
}

function cancelEditGroupRemark() {
  editingGroupRemark.value = false;
  tempGroupRemark.value = groupUserRemark.value || '';
}

async function saveGroupRemark() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) return;

  const newRemark = tempGroupRemark.value.trim();
  
  try {
    const response = await setGroupRemark(Number(groupId), newRemark || null);
    const data = response.data;

    groupUserRemark.value = newRemark;

    // 更新群组列表中的备注
    const currentGroup = groupStore.groupsList?.find(g => String(g.id) === String(groupId));
    if (currentGroup) {
      currentGroup.user_remark = newRemark || null;
    }

    // 同步更新 IndexedDB 中的备注数据
    try {
      const userId = baseStore.currentUser?.id || 'guest';
      const prefix = `chats-${userId}`;
      const key = `${prefix}-group-${groupId}`;
      const existingData = await localForage.getItem(key);
      if (existingData) {
        const updatedData = { ...existingData };
        updatedData.user_remark = newRemark || null;
        await localForage.setItem(key, updatedData);
      }
    } catch (e) {
      console.error('更新IndexedDB中的群组备注失败:', e);
    }

    toast.success(newRemark ? `已设置群组备注：${newRemark}` : '已清除群组备注');
    editingGroupRemark.value = false;
  } catch (e) {
    console.error('设置群组备注失败:', e);
    const errorMessage = e.response?.data?.message || e.message || '设置群组备注失败';
    toast.error(errorMessage);
  }
}

async function handleGroupRemarkBlur() {
  // 只有当值变化时才保存
  const newRemark = tempGroupRemark.value.trim();
  const oldRemark = groupUserRemark.value || '';
  if (newRemark !== oldRemark) {
    await saveGroupRemark();
  } else {
    editingGroupRemark.value = false;
  }
}

function startEditGroupNickname() {
  tempGroupNickname.value = groupNickname.value || '';
  editingGroupNickname.value = true;
  nextTick(() => {
    if (groupNicknameInput.value) {
      groupNicknameInput.value.focus();
      groupNicknameInput.value.select();
    }
  });
}

function cancelEditGroupNickname() {
  editingGroupNickname.value = false;
  tempGroupNickname.value = groupNickname.value || '';
}

async function saveGroupNickname() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) return;

  const newNickname = tempGroupNickname.value.trim();

  try {
    const response = await setGroupNickname(Number(groupId), newNickname || null);
    const data = response.data;

    groupNickname.value = newNickname;

    toast.success(newNickname ? `已设置群昵称：${newNickname}` : '已清除群昵称');
    editingGroupNickname.value = false;

    // 刷新成员列表以获取最新的群昵称数据
    if (groupId) {
      await loadGroupMembers(groupId);
    }
  } catch (e) {
    console.error('设置群昵称失败:', e);
    const errorMessage = e.response?.data?.message || e.message || '设置群昵称失败';
    toast.error(errorMessage);
  }
}

async function handleGroupNicknameBlur() {
  const newNickname = tempGroupNickname.value.trim();
  const oldNickname = groupNickname.value || '';
  if (newNickname !== oldNickname) {
    await saveGroupNickname();
  } else {
    editingGroupNickname.value = false;
  }
}

async function loadGroupNickname() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) return;

  try {
    const response = await getGroupNickname(groupId);
    const data = response.data;
    const newNickname = data.group_nickname || '';
    
    // 1. 更新本地状态
    groupNickname.value = newNickname;
    
    // 2. 更新 groupStore 中的成员列表（如果存在）
    if (groupStore.currentGroupMembers) {
      const currentUserId = baseStore.currentUser?.id;
      if (currentUserId) {
        const memberIndex = groupStore.currentGroupMembers.findIndex(
          m => String(m.id) === String(currentUserId)
        );
        
        if (memberIndex !== -1) {
          groupStore.currentGroupMembers[memberIndex].group_nickname = newNickname || null;
          // 触发响应式更新
          groupStore.currentGroupMembers = [...groupStore.currentGroupMembers];
        }
      }
    }
    
    // 3. 同步更新 IndexedDB 中的群组会话数据
    try {
      const userId = baseStore.currentUser?.id || 'guest';
      const prefix = `chats-${userId}`;
      const key = `${prefix}-group-${groupId}`;
      const existingData = await localForage.getItem(key);
      
      if (existingData) {
        const updatedData = { ...existingData };
      }
    } catch (e) {
      console.error('⚠️ [loadGroupNickname] IndexedDB操作失败:', e);
    }
  } catch (e) {
    console.error('加载群昵称失败:', e);
  }
}

function getMemberDisplayName(member) {
  // 如果是当前用户，显示其设置的群昵称
  if (String(member.id) === String(baseStore.currentUser?.id)) {
    return groupNickname.value || member.nickname || '我';
  }

  // 如果是好友且有备注，优先显示备注
  const friend = friendStore.friendsList?.find(f => String(f.id) === String(member.id));
  if (friend && friend.remark?.trim()) {
    return friend.remark.trim();
  }

  // 其他成员如果有群昵称则显示群昵称，否则显示全局昵称
  return member.group_nickname || member.nickname || member.username || '未知';
}

async function saveGroupNotice() {
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await updateGroupDescription(Number(groupId), tempGroupNotice.value);
    const data = response.data;
    toast.success('群组公告已更新');
    modalStore.modalData.groupInfo.description = tempGroupNotice.value;
    editingGroupNotice.value = false;
  } catch (error) {
    console.error('更新群组公告失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '更新群组公告失败';
    toast.error(errorMessage);
  }
}

async function handleRemoveGroupMember(member) {
  const confirmed = await modal.confirm(`确定要踢出成员 ${member.nickname || member.username} 吗？`, '踢出成员');
  if (!confirmed) {
    return;
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await removeGroupMember(Number(groupId), Number(member.id));
    const data = response.data;
    toast.success(`已成功踢出成员 ${member.nickname || member.username}`);
    loadGroupMembers(groupId);
  } catch (error) {
    console.error('踢出成员失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '踢出成员失败';
    toast.error(errorMessage);
  }
}

async function handleSetGroupAdmin(member) {
  const action = member.is_admin ? '取消' : '设置';
  const confirmed = await modal.confirm(`确定要${action} ${member.nickname || member.username} 的管理员权限吗？`, `${action}管理员`);
  if (!confirmed) {
    return;
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await setGroupAdmin(Number(groupId), Number(member.id), !member.is_admin);
    const data = response.data;
    toast.success(data.message || `已${action}管理员权限`);
    loadGroupMembers(groupId);
  } catch (error) {
    console.error(`${action}管理员失败:`, error);
    const errorMessage = error.response?.data?.message || error.message || `${action}管理员失败`;
    toast.error(errorMessage);
  }
}

async function handleMuteGroupMember(member) {
  const durationOptions = [
    { label: '10分钟', value: 10 },
    { label: '30分钟', value: 30 },
    { label: '1小时', value: 60 },
    { label: '24小时', value: 1440 },
    { label: '7天', value: 10080 },
    { label: '30天', value: 43200 },
    { label: '永久禁言', value: 0 },
    { label: '⏰ 自定义时间...', value: -1 }
  ];
  
  const durationText = await modal.select(
    `选择禁言时长 - ${member.nickname || member.username}`,
    durationOptions.map(opt => opt.label),
    '选择禁言时长'
  );
  
  if (!durationText) {
    return;
  }
  
  const selectedOption = durationOptions.find(opt => opt.label === durationText);
  let duration = selectedOption ? selectedOption.value : 0;
  
  // 如果选择了自定义时间，弹出日期时间选择器
  if (duration === -1) {
    const customDateTime = await showCustomMuteTimePicker(member);
    if (!customDateTime) {
      return; // 用户取消选择
    }
    
    // customDateTime 是用户选择的截止时间的ISO字符串
    // 计算分钟数
    const selectedTime = new Date(customDateTime);
    const now = new Date();
    const diffMs = selectedTime.getTime() - now.getTime();
    const diffMinutes = Math.ceil(diffMs / (1000 * 60));
    
    if (diffMinutes <= 0) {
      toast.error('选择的解禁时间必须大于当前时间');
      return;
    }
    
    // 如果超过100年（52560000分钟），自动设为永久禁言
    if (diffMinutes > 52560000) {
      const confirmed = await modal.confirm(
        '您选择的时间超过100年，将自动设置为永久禁言。是否继续？',
        '提示',
        'warning'
      );
      
      if (!confirmed) {
        return;
      }
      
      duration = 0; // 永久禁言
    } else {
      duration = diffMinutes;
    }
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await muteGroupMember(Number(groupId), Number(member.id), duration);
    const data = response.data;
    // 用服务器时间校准时钟偏移，保证倒计时与服务器解禁时刻一致
    if (typeof data.serverNow === 'number') {
      serverTimeOffset.value = data.serverNow - Date.now();
    }
    if (duration > 0) {
      const mutedUntil = parseMuteTime(data.mutedUntil);
      const timeStr = formatMuteTime(mutedUntil, Date.now() + serverTimeOffset.value);
      toast.success(`已禁言 ${member.nickname || member.username}，解禁时间：${timeStr}`);
    } else {
      toast.success(`已永久禁言 ${member.nickname || member.username}`);
    }
    // 立即用服务器返回的截止时间更新本地状态并重启倒计时，
    // 避免等待成员列表重新拉取期间徽标显示陈旧时间或冻结
    const memberIndex = groupMembers.value.findIndex(m => String(m.id) === String(member.id));
    if (memberIndex !== -1) {
      groupMembers.value[memberIndex] = {
        ...groupMembers.value[memberIndex],
        is_muted: true,
        muted_until: data.mutedUntil,
        isPermanentMuted: !duration || duration <= 0
      };
    }
    currentTime.value = Date.now();
    startMuteTimer();
    loadGroupMembers(groupId);
  } catch (error) {
    console.error('禁言成员失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '禁言失败';
    toast.error(errorMessage);
  }
}

async function handleUnmuteGroupMember(member) {
  const confirmed = await modal.confirm(`确定要解除 ${member.nickname || member.username} 的禁言吗？`, '解除禁言');
  if (!confirmed) {
    return;
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await unmuteGroupMember(Number(groupId), Number(member.id));
    const data = response.data;
    toast.success(`已解除 ${member.nickname || member.username} 的禁言`);
    loadGroupMembers(groupId);
  } catch (error) {
    console.error('解除禁言失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '解除禁言失败';
    toast.error(errorMessage);
  }
}

// 自定义时间选择器
async function showCustomMuteTimePicker(member) {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    container.id = 'custom-mute-time-picker';
    container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10001;
    `;
    
    const modal = document.createElement('div');
    modal.style.cssText = `
      background: white;
      border-radius: 12px;
      padding: 24px;
      min-width: 350px;
      max-width: 450px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      animation: slideIn 0.2s ease;
    `;
    
    const now = new Date();
    const defaultTime = new Date(now.getTime() + 60 * 60 * 1000); // 默认1小时后
    
    // 格式化日期时间为datetime-local输入格式
    const formatDateTimeLocal = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    };
    
    modal.innerHTML = `
      <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #333;">自定义解禁时间</h3>
      <p style="color: #666; font-size: 14px; margin-bottom: 16px;">
        为 ${member.nickname || member.username} 设置自定义解禁时间
      </p>
      <div style="margin-bottom: 20px;">
        <label style="display: block; font-weight: 600; color: #444; margin-bottom: 8px; font-size: 14px;">
          解禁时间：
        </label>
        <input 
          type="datetime-local" 
          id="customMuteDateTime" 
          value="${formatDateTimeLocal(defaultTime)}"
          min="${formatDateTimeLocal(now)}"
          style="
            width: 100%;
            padding: 10px 14px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.3s;
          "
        />
        <p id="timeWarning" style="color: #ff4757; font-size: 12px; margin-top: 8px; display: none;">
          ⚠️ 超过100年将自动设置为永久禁言
        </p>
      </div>
      <div style="display: flex; gap: 12px;">
        <button id="cancelCustomMute" style="
          flex: 1;
          padding: 10px 20px;
          border: 1px solid #d9d9d9;
          border-radius: 6px;
          background: white;
          color: #666;
          font-size: 14px;
          cursor: pointer;
          transition: all 0.3s;
        ">取消</button>
        <button id="confirmCustomMute" style="
          flex: 1;
          padding: 10px 20px;
          border: none;
          border-radius: 6px;
          background: #3498db;
          color: white;
          font-size: 14px;
          cursor: pointer;
          transition: all 0.3s;
        ">确认</button>
      </div>
    `;
    
    container.appendChild(modal);
    document.body.appendChild(container);
    
    const dateTimeInput = modal.querySelector('#customMuteDateTime');
    const warningEl = modal.querySelector('#timeWarning');
    const cancelBtn = modal.querySelector('#cancelCustomMute');
    const confirmBtn = modal.querySelector('#confirmCustomMute');
    
    // 监听时间变化，显示警告
    dateTimeInput.addEventListener('change', () => {
      const selectedTime = new Date(dateTimeInput.value);
      const diffMs = selectedTime.getTime() - now.getTime();
      const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000);
      
      if (diffYears > 100) {
        warningEl.style.display = 'block';
        dateTimeInput.style.borderColor = '#ff4757';
      } else {
        warningEl.style.display = 'none';
        dateTimeInput.style.borderColor = '#e0e0e0';
      }
    });
    
    // 聚焦效果
    dateTimeInput.addEventListener('focus', () => {
      dateTimeInput.style.borderColor = '#3498db';
    });
    
    dateTimeInput.addEventListener('blur', () => {
      if (warningEl.style.display !== 'block') {
        dateTimeInput.style.borderColor = '#e0e0e0';
      }
    });
    
    function cleanup() {
      container.remove();
    }
    
    function handleConfirm() {
      const selectedValue = dateTimeInput.value;
      if (!selectedValue) {
        toast.error('请选择解禁时间');
        return;
      }
      
      const selectedTime = new Date(selectedValue);
      cleanup();
      resolve(selectedTime.toISOString());
    }
    
    function handleCancel() {
      cleanup();
      resolve(null);
    }
    
    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    
    container.addEventListener('click', (e) => {
      if (e.target === container) handleCancel();
    });
    
    // 键盘事件
    const handleKeyDown = (e) => {
      if (e.key === 'Enter') {
        handleConfirm();
        document.removeEventListener('keydown', handleKeyDown);
      } else if (e.key === 'Escape') {
        handleCancel();
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    
    // 添加动画样式（如果不存在）
    if (!document.querySelector('#modal-animations-style')) {
      const style = document.createElement('style');
      style.id = 'modal-animations-style';
      style.textContent = `
        @keyframes slideIn {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes slideOut {
          from { transform: translateY(0); opacity: 1; }
          to { transform: translateY(-20px); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
  });
}

// 格式化禁言时间显示（nowMs 可选：传入服务器校准时间戳）
function formatMuteTime(dateTime, nowMs = Date.now()) {
  if (!dateTime) return '';

  const diffMs = dateTime.getTime() - nowMs;
  const diffSeconds = Math.ceil(diffMs / 1000);
  
  // 检查是否已过期（负数或零）
  if (diffSeconds <= 0) {
    return '已过期';
  }
  
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  // 检查是否超过100年
  const diffYears = diffDays / 365.25;
  if (diffYears > 100) {
    return '永久禁言';
  }
  
  // 根据时间长度返回友好的格式
  if (diffSeconds < 60) {
    return `${diffSeconds}秒后`;
  } else if (diffMinutes < 60) {
    const remainingSeconds = diffSeconds % 60;
    return `${diffMinutes}分${remainingSeconds}秒后`;
  } else if (diffHours < 24) {
    const remainingMinutes = diffMinutes % 60;
    return `${diffHours}小时${remainingMinutes}分后`;
  } else if (diffDays < 30) {
    const remainingHours = diffHours % 24;
    return `${diffDays}天${remainingHours}小时后`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    const remainingDays = diffDays % 30;
    return `${months}个月${remainingDays}天后`;
  } else {
    const years = Math.floor(diffDays / 365);
    const remainingDays = Math.floor(diffDays % 365);
    const months = Math.floor(remainingDays / 30);
    return `${years}年${months}个月后 (${dateTime.toLocaleString('zh-CN')})`;
  }
}

// 使用指定的 now 时间来格式化禁言时间（用于 computed）
function formatMuteTimeWithNow(dateTime, now) {
  if (!dateTime || !now) return '';
  
  const diffMs = dateTime.getTime() - now;
  const diffSeconds = Math.ceil(diffMs / 1000);
  
  // 检查是否已过期（负数或零）
  if (diffSeconds <= 0) {
    return '已过期';
  }
  
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  // 根据时间长度返回友好的格式
  if (diffSeconds < 60) {
    return `${diffSeconds}秒后`;
  } else if (diffMinutes < 60) {
    const remainingSeconds = diffSeconds % 60;
    return `${diffMinutes}分${remainingSeconds}秒后`;
  } else if (diffHours < 24) {
    const remainingMinutes = diffMinutes % 60;
    return `${diffHours}小时${remainingMinutes}分后`;
  } else if (diffDays < 30) {
    const remainingHours = diffHours % 24;
    return `${diffDays}天${remainingHours}小时后`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    const remainingDays = diffDays % 30;
    return `${months}个月${remainingDays}天后`;
  } else {
    const years = Math.floor(diffDays / 365);
    const remainingDays = Math.floor(diffDays % 365);
    const months = Math.floor(remainingDays / 30);
    return `${years}年${months}个月后 (${dateTime.toLocaleString('zh-CN')})`;
  }
}

// 解析禁言时间：后端统一存储 UTC（YYYY-MM-DD HH:mm:ss），显式按 UTC 解析，与浏览器时区无关
function parseMuteTime(value) {
  if (!value) return null;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// 检查是否为永久禁言（超过100年或存储值为9999年）
function isPermanentMute(mutedUntil) {
  if (!mutedUntil) return false;

  const mutedTime = parseMuteTime(mutedUntil);
  const now = new Date();
  const diffMs = mutedTime.getTime() - now.getTime();
  const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000);
  
  // 超过100年或者存储值包含9999
  return diffYears > 100 || String(mutedUntil).includes('9999');
}

// 获取禁言状态显示文本
function getMuteStatusText(member) {
  if (!member.is_muted) return '';
  
  // 使用 isPermanentMute 函数检测（支持超过100年自动判断）
  if (isPermanentMute(member.muted_until) || member.isPermanentMuted) {
    return '🔒 永久禁言';
  }
  
  // 如果有截止时间，检查是否已过期
  if (member.muted_until) {
    const mutedTime = parseMuteTime(member.muted_until);
    // 使用服务器校准时间判断过期
    const diffMs = mutedTime.getTime() - (Date.now() + serverTimeOffset.value);
    
    // 如果已过期，返回空文本（这样禁言标识不会显示，按钮会显示为"禁言"）
    if (diffMs <= 0) {
      return '';
    }
    
    const timeStr = formatMuteTime(mutedTime, Date.now() + serverTimeOffset.value);
    return `⏰ ${timeStr}`;
  }
  
  return '已禁言';
}

// 获取禁言状态提示信息（鼠标悬停显示）
function getMuteStatusTooltip(member) {
  if (!member.is_muted) return '';
  
  if (isPermanentMute(member.muted_until) || member.isPermanentMuted) {
    return '该成员已被永久禁言，无法发送消息';
  }
  
  if (member.muted_until) {
    const mutedTime = parseMuteTime(member.muted_until);
    const formattedTime = mutedTime.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    return `解禁时间：${formattedTime}\n点击查看详情`;
  }
  
  return '该成员已被禁言，无法发送消息';
}

const isMuteAllEnabled = ref(false);

async function handleToggleMuteAll(event) {
  const action = isMuteAllEnabled.value ? '关闭' : '开启';
  const confirmed = await modal.confirm(`确定要${action}全员禁言吗？${!isMuteAllEnabled.value ? '开启后只有群主和管理员可以发言' : '关闭后所有成员都可以发言'}`, `${action}全员禁言`);
  if (!confirmed) {
    // 取消确认时恢复开关显示状态
    if (event && event.target) {
      event.target.checked = isMuteAllEnabled.value;
    }
    return;
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await setAllMute(Number(groupId), !isMuteAllEnabled.value);
    const data = response.data;
    isMuteAllEnabled.value = !isMuteAllEnabled.value;
    toast.success(data.message || `已${action}全员禁言`);
  } catch (error) {
    console.error(`${action}全员禁言失败:`, error);
    const errorMessage = error.response?.data?.message || error.message || `${action}全员禁言失败`;
    toast.error(errorMessage);
  }
}

async function loadGroupMuteStatus(groupId) {
  try {
    const response = await getGroupMuteStatus(groupId);
    const data = response.data;
    isMuteAllEnabled.value = data.isMuteAll;

    // 用服务器时间校准时钟偏移，保证徽标归零时刻与服务器解禁时刻一致
    if (typeof data.serverNow === 'number') {
      serverTimeOffset.value = data.serverNow - Date.now();
    }
      
    // 更新成员的禁言状态
    if (groupMembers.value.length > 0 && data.members) {
      groupMembers.value = groupMembers.value.map(member => {
        const muteInfo = data.members.find(m => String(m.id) === String(member.id));
        if (muteInfo && muteInfo.isMuted) {
          const mutedUntil = muteInfo.mutedUntil;
          
          // 使用 isPermanentMute 函数检测是否超过100年（双重保障）
          const autoDetectedPermanent = isPermanentMute(mutedUntil);
          
          // 前端二次验证：检查临时禁言是否已过期（防止后端漏检或时区差异）
          if (!autoDetectedPermanent && !muteInfo.isPermanent && mutedUntil) {
            const mutedTime = parseMuteTime(mutedUntil);
            // 使用服务器校准时间判断过期
            const diffMs = mutedTime.getTime() - (Date.now() + serverTimeOffset.value);
            
            // 如果已过期，返回未禁言状态
            if (diffMs <= 0) {
              return {
                ...member,
                is_muted: false,
                muted_until: null,
                isPermanentMuted: false
              };
            }
          }
          
          return {
            ...member,
            is_muted: true,
            muted_until: mutedUntil,
            isPermanentMuted: muteInfo.isPermanent || autoDetectedPermanent  // 优先使用后端判断，但前端也会自动检测
          };
        }
        return {
          ...member,
          is_muted: false,
          muted_until: null,
          isPermanentMuted: false
        };
      });

      // 立即刷新当前时间并切回秒级倒计时节奏，
      // 否则 computed 会使用陈旧的 currentTime，徽标剩余时间偏大且冻结到下一次 tick
      currentTime.value = Date.now();
      startMuteTimer();
    }
  } catch (error) {
    console.error('获取禁言状态失败:', error);
  }
}

async function handleDissolveGroup() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) {
    toast.error('群组信息不存在');
    return;
  }
  
  const confirmed = await modal.confirm('确定要解散这个群组吗？此操作不可撤销！', '解散群组', 'error');
  if (!confirmed) {
    return;
  }
  
  try {
    const response = await dissolveGroup(baseStore.currentUser?.id, groupId);
    const data = response.data;
    toast.success('群组已解散');
    modalStore.closeModal('groupInfo');
    sessionStore.setCurrentGroupId(null);
    
    await groupStore.markGroupAsDeleted(groupId, true);
    
    loadGroupList();
  } catch (error) {
    console.error('解散群组失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '解散群组失败';
    toast.error(errorMessage);
  }
}

async function handleLeaveGroup() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) {
    toast.error('群组信息不存在');
    return;
  }
  
  const confirmed = await modal.confirm('确定要退出这个群组吗？', '退出群组');
  if (!confirmed) {
    return;
  }
  
  try {
    const response = await leaveGroup(groupId);
    const data = response.data;
    toast.success('已退出群组');
    modalStore.closeModal('groupInfo');
    sessionStore.setCurrentGroupId(null);
    
    await groupStore.markGroupAsDeleted(groupId, true);
    
    loadGroupList();
  } catch (error) {
    console.error('退出群组失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '退出群组失败';
    toast.error(errorMessage);
  }
}

async function handleDeleteFriend() {
  const friendId = modalStore.modalData.userProfile?.id;
  if (!friendId) {
    toast.error('用户信息不存在');
    return;
  }
  
  const confirmed = await modal.confirm('确定要删除这个好友吗？', '删除好友');
  if (!confirmed) {
    return;
  }
  
  try {
    const response = await removeFriend(friendId);
    const data = response.data;
    toast.success('删除好友成功');
    modalStore.closeModal('userProfile');
    
    // 彻底删除会话（含聊天记录、已删除快照），不留已删除标记
    await storageStore.deleteSingleDeletedSession('private', friendId);
    
    loadFriendsList();
  } catch (error) {
    console.error('删除好友失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '删除好友失败';
    toast.error(errorMessage);
  }
}

async function copyUserId() {
  const profile = modalStore.modalData.userProfile;
  if (!profile) return;
  const text = profile.username || String(profile.id || '');
  try {
    await navigator.clipboard.writeText(text);
    toast.success('用户ID已复制');
  } catch (e) {
    console.error('复制失败:', e);
    toast.error('复制失败');
  }
}

async function handleAddGroupMembers() {
  selectedFriendIdsForAdd.value = [];
  showAddGroupMembersModal.value = true;
  await loadAvailableFriendsForAdd();
}

async function loadAvailableFriendsForAdd() {
  try {
    const user = baseStore.currentUser;
    const sessionToken = baseStore.currentSessionToken;
    const groupId = modalStore.modalData.groupInfo.id;
    
    const membersResponse = await getGroupMembers(groupId);
    const membersData = membersResponse.data;
    const groupMemberIds = new Set((membersData.members || []).map(m => String(m.id)));
    
    if (friendStore.friendsList && Array.isArray(friendStore.friendsList)) {
      availableFriendsForAdd.value = friendStore.friendsList
        .filter(friend => {
          const friendId = String(friend.id);
          const isNotCurrentUser = friendId !== String(user?.id);
          const isNotInGroup = !groupMemberIds.has(friendId);
          const isNotDeleted = !friend.deleted_at;
          return isNotCurrentUser && isNotInGroup && isNotDeleted;
        })
        .map(friend => ({
          id: friend.id,
          nickname: friend.nickname || friend.username || '',
          avatarUrl: friend.avatar_url || friend.avatarUrl || ''
        }));
    } else {
      availableFriendsForAdd.value = [];
    }
  } catch (error) {
    console.error('加载好友列表失败:', error);
    availableFriendsForAdd.value = [];
  }
}

async function confirmAddGroupMembers() {
  if (selectedFriendIdsForAdd.value.length === 0) {
    toast.error('请选择至少1名成员');
    return;
  }
  
  try {
    const groupId = modalStore.modalData.groupInfo.id;
    const response = await addGroupMembers(groupId, selectedFriendIdsForAdd.value);
    const data = response.data;
    toast.success('成员添加成功');
    showAddGroupMembersModal.value = false;
    loadGroupMembers(groupId);
  } catch (error) {
    console.error('添加成员失败:', error);
    const errorMessage = error.response?.data?.message || error.message || '添加成员失败';
    toast.error(errorMessage);
  }
}

async function handleDeleteGroupLocalRecord() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) {
    toast.error('群组信息不存在');
    return;
  }
  
  const confirmed = await modal.confirm('确定要删除该群组的会话记录吗？\n这将同时删除服务器和本地的记录。', '删除会话');
  if (!confirmed) {
    return;
  }
  
  try {
    await storageStore.deleteSingleDeletedSession('group', groupId);
    toast.success('会话记录已删除');
    modalStore.closeModal('groupInfo');
    sessionStore.setCurrentGroupId(null);
  } catch (error) {
    console.error('删除会话记录失败:', error);
    toast.error('删除会话记录失败: ' + error.message);
  }
}

async function handleDeleteFriendLocalRecord() {
  const friendId = modalStore.modalData.userProfile?.id;
  if (!friendId) {
    toast.error('用户信息不存在');
    return;
  }
  
  const confirmed = await modal.confirm('确定要删除该好友的会话记录吗？\n这将同时删除服务器和本地的记录。', '删除会话');
  if (!confirmed) {
    return;
  }
  
  try {
    await storageStore.deleteSingleDeletedSession('private', friendId);
    toast.success('会话记录已删除');
    modalStore.closeModal('userProfile');
    sessionStore.setCurrentPrivateChatUserId(null);
  } catch (error) {
    console.error('删除会话记录失败:', error);
    toast.error('删除会话记录失败: ' + error.message);
  }
}

function unescapeHtml(html) {
  const text = document.createElement('textarea');
  text.innerHTML = html;
  return text.value;
}

async function fetchUserInfo(userId) {
  try {
    const response = await getUserInfo(userId);
    const data = response.data;
    if (data.user) {
      return {
        id: data.user.id,
        username: data.user.username,
        nickname: data.user.nickname || '',
        signature: data.user.signature || '',
        gender: data.user.gender,
        friend_verification: data.user.friend_verification,
        avatarUrl: data.user.avatar_url || data.user.avatarUrl || data.user.avatar
      };
    }
  } catch (error) {
    console.error('获取用户信息失败:', error);
  }
  return null;
}

function updateUserAvatarPopupPosition(event) {
  const popup = document.getElementById('userAvatarPopup');
  if (!popup) return;
  
  const popupRect = popup.getBoundingClientRect();
  const popupWidth = popupRect.width || 250;
  const popupHeight = popupRect.height || 150;
  
  let left = event.clientX;
  let top = event.clientY;
  
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  if (left + popupWidth > viewportWidth) {
    left = viewportWidth - popupWidth - 10;
  }
  
  if (top + popupHeight > viewportHeight) {
    top = event.clientY - popupHeight - 10;
  }
  
  if (left < 0) {
    left = 10;
  }
  
  if (top < 0) {
    top = 10;
  }
  
  userAvatarPopupLeft.value = left;
  userAvatarPopupTop.value = top;
}

function hideUserAvatarPopupVue(event) {
  // 点击落在弹窗内部（如加好友按钮）时不关闭
  if (event && event.target) {
    const popup = document.getElementById('userAvatarPopup');
    if (popup && popup.contains(event.target)) return;
  }
  const popup = document.getElementById('userAvatarPopup');
  if (popup) {
    popup.classList.remove('visible');
  }
  modalStore.closeModal('userAvatarPopup');
  document.removeEventListener('click', hideUserAvatarPopupVue, true);
  document.removeEventListener('contextmenu', hideUserAvatarPopupVue);
  window.removeEventListener('scroll', hideUserAvatarPopupVue);
}

async function showUserAvatarPopupVue(event, user) {
  event.stopPropagation();
  
  // 先关闭之前的弹窗
  hideUserAvatarPopupVue();
  
  userAvatarPopupEvent.value = event;
  userAvatarPopupUserId.value = user.id;
  
  userAvatarPopupLeft.value = event.clientX;
  userAvatarPopupTop.value = event.clientY;
  
  const displayPopup = async (displayUser) => {
    modalStore.openModal('userAvatarPopup', displayUser);
    
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    
    updateUserAvatarPopupPosition(event);
    
    await new Promise(resolve => requestAnimationFrame(resolve));
    
    const popup = document.getElementById('userAvatarPopup');
    if (popup) {
      popup.classList.add('visible');
    }
    
    setTimeout(() => {
      document.addEventListener('click', hideUserAvatarPopupVue, true);
      document.addEventListener('contextmenu', hideUserAvatarPopupVue);
      window.addEventListener('scroll', hideUserAvatarPopupVue);
    }, 0);
  };
  
  if (user.id && user.username) {
    await displayPopup(user);
  } else {
    const fullUser = await fetchUserInfo(user.id);
    if (fullUser) {
      await displayPopup(fullUser);
    } else {
      await displayPopup(user);
    }
  }
}

function openUserAvatarPopupAvatarPreview() {
  if (userAvatarPopupAvatarUrl.value) {
    modalStore.openModal('avatarPreview', userAvatarPopupAvatarUrl.value);
  }
}

function openUserProfileAvatarPreview() {
  if (userProfileAvatarUrl.value) {
    modalStore.openModal('avatarPreview', userProfileAvatarUrl.value);
  }
}

async function handleUserProfileToggleBlockUser() {
  const targetUserId = modalStore.modalData.userProfile?.id;
  if (!targetUserId || userProfileBlockingLoading.value) return;
  
  // 注意：由于 v-model 先于 @change 执行，此时 userProfileIsBlocked.value 已经是新值
  // 所以要取反得到操作前的状态来判断应该调用哪个API
  const willBeBlocked = userProfileIsBlocked.value; // 这是操作后的状态
  const isCurrentlyBlocked = !willBeBlocked; // 操作前的状态
  
  userProfileBlockingLoading.value = true;
  
  try {
    // 根据操作前的状态决定调用哪个API
    // 如果操作前已拉黑(isCurrentlyBlocked=true)，现在要取消拉黑
    // 如果操作前未拉黑(isCurrentlyBlocked=false)，现在要拉黑
    const apiUrl = isCurrentlyBlocked ? '/api/user/unblock-user' : '/api/user/block-user';
    const response = await request.post(apiUrl, { targetUserId });
    const data = response.data;
    
    // 刷新好友列表
    if (typeof loadFriendsList === 'function') {
      loadFriendsList();
    }
    
    toast.success(data.message);
  } catch (e) {
    console.error('拉黑操作失败:', e);
    // 异常时也需要恢复状态
    userProfileIsBlocked.value = !userProfileIsBlocked.value;
    const errorMessage = e.response?.data?.message || e.message || (isCurrentlyBlocked ? '取消拉黑失败' : '拉黑失败');
    toast.error(errorMessage);
  } finally {
    userProfileBlockingLoading.value = false;
  }
}

function startEditRemark() {
  tempRemark.value = userProfileRemark.value || '';
  isEditingRemark.value = true;
  nextTick(() => {
    if (remarkInput.value) {
      remarkInput.value.focus();
      remarkInput.value.select();
    }
  });
}

async function handleUserProfileToggleMute() {
  const targetUserId = modalStore.modalData.userProfile?.id;
  if (!targetUserId) return;
  const friend = friendStore.friendsList.find(f => String(f.id) === String(targetUserId));
  if (!friend) return;

  const newIsDisturb = !(friend.is_disturb == 1);
  try {
    const res = await setFriendDisturb(targetUserId, newIsDisturb);
    friend.is_disturb = res.data.is_disturb;
    if (newIsDisturb) {
      unreadStore.clearPrivateUnread(targetUserId);
    }
  } catch (e) {
    console.error('设置好友免打扰失败:', e);
    const errorMessage = e.response?.data?.message || e.message || '设置好友免打扰失败';
    toast.error(errorMessage);
  }
}

// 群组信息面板：切换群组免打扰（与会话列表右键逻辑一致：setGroupDisturb + 更新store + 清未读）
async function handleGroupInfoToggleMute() {
  const groupId = modalStore.modalData.groupInfo?.id;
  if (!groupId) return;
  const group = groupStore.groupsList.find(g => String(g.id) === String(groupId));
  if (!group) return;

  const newIsDisturb = !(group.is_disturb == 1);
  try {
    const res = await setGroupDisturb(groupId, newIsDisturb);
    group.is_disturb = res.data.is_disturb;
    if (newIsDisturb) {
      unreadStore.clearGroupUnread(groupId);
    }
  } catch (e) {
    console.error('设置群组免打扰失败:', e);
    const errorMessage = e.response?.data?.message || e.message || '设置群组免打扰失败';
    toast.error(errorMessage);
  }
}

async function saveRemark() {
  const targetUserId = modalStore.modalData.userProfile?.id;
  if (!targetUserId || userProfileRemarkLoading.value) return;

  const newRemark = tempRemark.value.trim();
  
  if (newRemark === userProfileRemark.value) {
    isEditingRemark.value = false;
    return;
  }

  userProfileRemarkLoading.value = true;

  try {
    const response = await setFriendRemark(Number(targetUserId), newRemark || null);
    const data = response.data;

    userProfileRemark.value = newRemark;
    
    const currentFriend = friendStore.friendsList.find(f => String(f.id) === String(targetUserId));
    if (currentFriend) {
      currentFriend.remark = newRemark || null;
    }

    if (typeof loadFriendsList === 'function') {
      loadFriendsList();
    }

    toast.success(newRemark ? `已设置备注：${newRemark}` : '已清除备注');
    isEditingRemark.value = false;
  } catch (e) {
    console.error('设置备注失败:', e);
    const errorMessage = e.response?.data?.message || e.message || '设置备注失败';
    toast.error(errorMessage);
  } finally {
    userProfileRemarkLoading.value = false;
  }
}

function cancelEditRemark() {
  tempRemark.value = userProfileRemark.value || '';
  isEditingRemark.value = false;
}

async function handleRemarkBlur() {
  // 只有当值变化时才保存
  const newRemark = tempRemark.value.trim();
  const oldRemark = userProfileRemark.value || '';
  if (newRemark !== oldRemark) {
    await saveRemark();
  } else {
    isEditingRemark.value = false;
  }
}

function openGroupInfoAvatarPreview() {
  if (groupInfoAvatarUrl.value) {
    modalStore.openModal('avatarPreview', groupInfoAvatarUrl.value);
  }
}

function handleUserAvatarPopupAddFriend() {
  if (userAvatarPopupAddFriendButtonDisabled.value || !userAvatarPopupUserId.value) return;

  if (userAvatarPopupIsFriend.value) {
    const user = modalStore.modalData.userAvatarPopup;
    if (user) {
      hideUserAvatarPopupVue();
      switchToPrivateChat(
        userAvatarPopupUserId.value,
        user.nickname || user.username,
        user.username,
        user.avatarUrl || user.avatar_url || user.avatar
      );
      setTimeout(() => {
        friendStore.updateFriendSessionTime(userAvatarPopupUserId.value);
      }, 200);
    }
    return;
  }

  if (userAvatarPopupHasSentRequest.value) {
    handleCancelFriendRequest(userAvatarPopupUserId.value);
    return;
  }

  const user = modalStore.modalData.userAvatarPopup;
  if (user) {
    if (user.friend_verification === false) {
      // 对方明确未开启好友验证，无需留言，直接发送
      const myNickname = baseStore.currentUser?.nickname || '用户';
      addFriend(userAvatarPopupUserId.value, `我是${myNickname}`);
    } else {
      // 对方开启了好友验证（或信息未知时回退为弹窗留言，避免遗漏）
      showFriendRequestDialog(
        userAvatarPopupUserId.value,
        user.nickname || user.username
      );
    }
  }
  hideUserAvatarPopupVue();
}

async function handleCancelFriendRequest(friendId) {
  const userId = baseStore.currentUser?.id;
  const sessionToken = baseStore.currentSessionToken;
  if (!userId || !sessionToken) return;

  try {
    const response = await cancelFriendRequest(friendId);
    const data = response.data;

    await baseStore.loadFriendRequests();
    hideUserAvatarPopupVue();
    toast.success('已撤销好友申请');
  } catch (error) {
    console.error('撤销好友请求失败:', error);
  }
}

function showMemberContextMenu(event, member) {
  event.preventDefault();
  
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    member: member
  };
  
  // 调整菜单位置，防止超出屏幕
  setTimeout(() => {
    const menuEl = document.querySelector('.context-menu-active');
    if (menuEl) {
      const rect = menuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        contextMenu.value.x = window.innerWidth - rect.width - 10;
      }
      if (rect.bottom > window.innerHeight) {
        contextMenu.value.y = window.innerHeight - rect.height - 10;
      }
    }
  }, 0);
}

function hideContextMenu() {
  contextMenu.value = {
    visible: false,
    x: 0,
    y: 0,
    member: null
  };
}

async function handleContextAction(action) {
  const member = contextMenu.value.member;
  if (!member) return;

  hideContextMenu();

  switch (action) {
    case 'remove':
      await handleRemoveGroupMember(member);
      break;
    case 'admin':
      await handleSetGroupAdmin(member);
      break;
    case 'mute':
      if (member.is_muted) {
        await handleUnmuteGroupMember(member);
      } else {
        await handleMuteGroupMember(member);
      }
      break;
  }
}

function updateMuteCountdowns() {
  if (!groupMembers.value || groupMembers.value.length === 0) return false;

  // 使用服务器校准时间，保证到期判断与后端解禁时刻一致
  const now = Date.now() + serverTimeOffset.value;
  let hasActiveMutes = false;
  
  // 检查是否有成员禁言已过期，如果有则更新状态
  const updatedMembers = groupMembers.value.map(member => {
    if (!member.is_muted || !member.muted_until) {
      return member;
    }
    
    if (isPermanentMute(member.muted_until) || member.isPermanentMuted) {
      hasActiveMutes = true;
      return member;
    }
    
    const mutedTime = parseMuteTime(member.muted_until);
    const diffMs = mutedTime.getTime() - now;
    
    if (diffMs <= 0) {
      // 禁言已过期，更新状态
      return {
        ...member,
        is_muted: false,
        muted_until: null,
        isPermanentMuted: false
      };
    }
    
    hasActiveMutes = true;
    return member;
  });
  
  // 检查是否有成员状态发生变化
  const hasChanges = JSON.stringify(updatedMembers) !== JSON.stringify(groupMembers.value);
  if (hasChanges) {
    groupMembers.value = updatedMembers;
  }
  
  // 存原始本机时间戳（serverTimeOffset 由各消费处自行加一次，此处不能预加，否则偏移会被重复计算）
  currentTime.value = Date.now();

  return hasActiveMutes;
}

function startMuteTimer() {
  stopMuteTimer();
  
  function tick() {
    const hasActiveMutes = updateMuteCountdowns();
    muteTimer = setTimeout(tick, hasActiveMutes ? 1000 : 30000);
  }
  
  // 立即执行第一次更新
  tick();
}

function stopMuteTimer() {
  if (muteTimer) {
    clearTimeout(muteTimer);
    muteTimer = null;
  }
}

function handleGlobalClick(event) {
  // 现在我们主要依靠blur事件来处理保存/取消
  // 这个函数可以保持简单，不需要特殊处理
  // blur事件会自动触发handleXXXBlur函数
}

onMounted(() => {
  document.addEventListener('click', handleGlobalClick);
});

onUnmounted(() => {
  stopMuteTimer();
  document.removeEventListener('click', handleGlobalClick);
});

registerPopupFunctions(showUserAvatarPopupVue, hideUserAvatarPopupVue, showGroupCardPopupVue);
</script>
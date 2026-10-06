import localForage from 'localforage';

import modal from '../modal.js';

import { SERVER_URL, toast } from './config.js';
import {
  getGroupList,
  leaveGroup,
  dissolveGroup as apiDissolveGroup,
  getGroupMembers,
  removeGroupMember,
  addGroupMembers,
  updateGroupName as apiUpdateGroupName,
  updateGroupDescription,
  uploadGroupAvatar as apiUploadGroupAvatar,
  joinGroupWithToken as apiJoinGroupWithToken,
  getGroupInfo,
  generateGroupToken
} from '@/api/group.js';
import {
  useBaseStore,
  useSessionStore,
  useGroupStore,
  useModalStore,
  useUnreadStore,
  useDraftStore,
  getChatSocket,
  openGroupCardPopup
} from '@/stores/index.js';
import {
  updateUnreadCountsDisplay,
  setActiveChatDirect,
  updateGroupListDisplay
} from './ui.js';
import { navigateTo } from './routerInstance.js';


let groupsList = [];
let currentSharedGroup = null;
let switchingGroupWithExistingMessages = false;
let groupChatAllLoaded = {};

// 已删除会话快照（存 localStorage，独立于 IndexedDB 消息缓存）。
// 用途：清空 IndexedDB 后首次拉取时，仍能根据快照识别并显示已删除会话，
// 避免"必须第二次拉取才能看到已删除的会话"。
function getDeletedGroupSnapshot() {
  const baseStore = useBaseStore();
  const userId = baseStore.currentUser?.id || 'guest';
  try {
    const v = localStorage.getItem(`chats-${userId}-deleted-groups`);
    return (v && JSON.parse(v)) || {};
  } catch {
    return {};
  }
}

function saveDeletedGroupSnapshot(snapshot) {
  const baseStore = useBaseStore();
  const userId = baseStore.currentUser?.id || 'guest';
  try {
    localStorage.setItem(`chats-${userId}-deleted-groups`, JSON.stringify(snapshot));
  } catch {}
}

async function loadGroupList() {
    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    if (!currentUser || !currentSessionToken) return;

    try {
        const res = await getGroupList();
        const data = res.data;
        await updateGroupList(data.groups);
    } catch (e) {
        console.error('加载群组列表失败:', e);
    }
}

function getMutedGroups() {
    const mutedGroups = localStorage.getItem('mutedGroups');
    return mutedGroups ? JSON.parse(mutedGroups) : [];
}

function isGroupMuted(groupId) {
    try {
      const groupStore = useGroupStore();
      const group = groupStore.groupsList.find(g => String(g.id) === String(groupId));
      return group ? group.is_disturb == 1 : false;
    } catch {
      return false;
    }
}

function toggleGroupMute(groupId) {
    const mutedGroups = getMutedGroups();
    const groupIdStr = groupId.toString();
    let updatedGroups;

    if (mutedGroups.includes(groupIdStr)) {
        updatedGroups = mutedGroups.filter(id => id !== groupIdStr);
    } else {
        updatedGroups = [...mutedGroups, groupIdStr];
    }

    localStorage.setItem('mutedGroups', JSON.stringify(updatedGroups));
    updateGroupListDisplay();
    updateUnreadCountsDisplay();
    return !mutedGroups.includes(groupIdStr);
}

async function handleDissolveGroup(groupId) {
    const confirmed = await modal.confirm('确定要解散该群组吗？此操作不可恢复，所有群消息将被删除。', '解散群组', 'error');
    if (confirmed) {
        dissolveGroup(groupId);
    }
}

async function handleLeaveGroup(groupId) {
    const baseStore = useBaseStore();
    const sessionStore = useSessionStore();
    const groupStore = useGroupStore();
    const modalStore = useModalStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    const confirmed = await modal.confirm('确定要退出该群组吗？', '退出群组');
    if (!confirmed) {
        return;
    }
    
    try {
        const res = await leaveGroup(groupId);
        const data = res.data;
        toast.success('已成功退出群组');
        loadGroupList();

        if (modalStore) {
            modalStore.closeModal('groupInfo');
        }
        if (sessionStore) {
            sessionStore.setCurrentGroupId(null);
        }
        
        if (groupStore) {
            await groupStore.markGroupAsDeleted(groupId, true);
        }

        const groupEmptyState = document.getElementById('groupEmptyState');
        const groupChatInterface = document.getElementById('groupChatInterface');
        const currentGroupNameElement = document.getElementById('currentGroupName');

        if (groupEmptyState) {
            groupEmptyState.style.display = 'flex';
        }
        if (groupChatInterface) {
            groupChatInterface.style.display = 'none';
        }
        if (currentGroupNameElement) {
            currentGroupNameElement.textContent = '群组名称';
        }
    } catch (error) {
        console.error('退出群组失败:', error);
        const errorMessage = error.response?.data?.message || error.message || '未知错误';
        toast.error('退出群组失败: ' + errorMessage);
    }
}

async function dissolveGroup(groupId) {
    const baseStore = useBaseStore();
    const sessionStore = useSessionStore();
    const groupStore = useGroupStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    if (!currentUser || !currentSessionToken) {
        toast.error('请先登录');
        return;
    }

    const confirmed = await modal.confirm('确定要解散本群组吗？此操作不可恢复，所有群消息将被删除。', '解散群组', 'error');
    if (!confirmed) {
        return;
    }

    apiDissolveGroup(currentUser.id, groupId)
        .then(res => { const data = res.data;
            toast.success('群组已成功解散，所有群消息已删除');

            if (sessionStore) {
                sessionStore.setCurrentGroupId(null);
                sessionStore.currentGroupName = '';
                sessionStore.setCurrentActiveChat('main');
            }
            
            if (groupStore) {
                groupStore.markGroupAsDeleted(groupId, true);
            }

            loadGroupList();
        })
        .catch(err => {
            toast.error('解散群组失败: ' + (err.response?.data?.message || err.message || '网络错误'));
        });
}

function loadGroupMembers(groupId, isOwner) {

    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;

    const groupMembersContainer = document.getElementById('groupMembersContainer');
    const modalGroupMemberCount = document.getElementById('modalGroupMemberCount');
    if (!groupMembersContainer) {
        return;
    }

    groupMembersContainer.innerHTML = '<div class="loading-members">正在加载成员列表...</div>';


    getGroupMembers(groupId)
        .then(res => { const data = res.data;

            updateGroupMembersList(data.members, isOwner, groupId);
            modalGroupMemberCount.textContent = data.members.length;
        })
        .catch(err => {
            const errorMsg = err.response?.data?.message || err.message || '未知错误';
            groupMembersContainer.innerHTML = `<div class="loading-members">加载成员列表失败: ${errorMsg}</div>`;
        });
}

function updateGroupMembersList(members, isOwner, groupId) {

    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;

    const groupMembersContainer = document.getElementById('groupMembersContainer');
    if (!groupMembersContainer) {
        return;
    }

    if (!members || !Array.isArray(members) || members.length === 0) {

        groupMembersContainer.innerHTML = '<div class="loading-members">没有可用的成员</div>';
        return;
    }


    let membersHtml = '';
    members.forEach((member) => {
        const isMemberOwner = String(member.id) === String(currentUser.id);

        membersHtml += `
            <div class="group-member-item">
                <div class="group-member-info">
                    <span class="group-member-name">${member.nickname}</span>
                    <span class="group-member-id">ID: ${member.id}</span>
                    ${isMemberOwner ? '<span class="group-member-role">（我）</span>' : ''}
                </div>
                ${isOwner && !isMemberOwner ? `
                    <button class="kick-member-btn" data-group-id="${groupId}" data-member-id="${member.id}" data-member-name="${member.nickname}">
                        踢出
                    </button>
                ` : ''}
            </div>
        `;
    });


    groupMembersContainer.innerHTML = membersHtml;

    if (isOwner) {
        const kickButtons = groupMembersContainer.querySelectorAll('.kick-member-btn');


        kickButtons.forEach(button => {
            button.addEventListener('click', function() {
                const groupId = this.getAttribute('data-group-id');
                const memberId = this.getAttribute('data-member-id');
                const memberName = this.getAttribute('data-member-name');


                removeMemberFromGroup(groupId, memberId, memberName);
            });
        });
    }


}

async function removeMemberFromGroup(groupId, memberId, memberName) {
    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    const confirmed = await modal.confirm(`确定要踢出成员 ${memberName} 吗？`, '踢出成员');
    if (!confirmed) return;
    if (!currentUser || !currentSessionToken) {
        toast.error('请先登录');
        return;
    }

    removeGroupMember(groupId, memberId)
        .then(res => { const data = res.data;

            toast.success(`已成功踢出成员 ${memberName}`);
            loadGroupMembers(groupId, true);
        })
        .catch(error => {
            console.error('踢出成员失败:', error);
            toast.error('踢出成员失败: ' + (error.response?.data?.message || error.message || '网络错误'));
        });
}

let currentAddingGroupId = null;
    
    function showAddGroupMemberModal(groupId) {
        const baseStore = useBaseStore();
        const sessionStore = useSessionStore();
        const modalStore = useModalStore();
        const currentUser = baseStore.currentUser;
        const currentSessionToken = baseStore.currentSessionToken;
        if (!groupId || !currentUser || !currentSessionToken) {
            return;
        }
        currentAddingGroupId = groupId;
        if (modalStore) {
            modalStore.openModal('addGroupMember');
        }
        setTimeout(() => {
            document.body.style.overflow = 'hidden';
        }, 100);
    }
    
    function hideAddGroupMemberModal() {
        const modalStore = useModalStore();
        if (modalStore) {
            modalStore.closeModal('addGroupMember');
        }
    }
    
    function confirmAddGroupMembers() {
        const baseStore = useBaseStore();
        const sessionStore = useSessionStore();
        const modalStore = useModalStore();
        const currentUser = baseStore.currentUser;
        const currentSessionToken = baseStore.currentSessionToken;
        const groupId = currentAddingGroupId;
        if (!groupId || !currentUser || !currentSessionToken) {
            return;
        }

    const availableMembersList = document.getElementById('availableMembersList');
    const addMembersMessage = document.getElementById('addMembersMessage');

    if (!availableMembersList || !addMembersMessage) {
        console.error('❌ [添加成员] 找不到必要的DOM元素');
        return;
    }

    const checkboxes = availableMembersList.querySelectorAll('.available-member-checkbox:checked');
    const selectedMemberIds = Array.from(checkboxes).map(checkbox => checkbox.value);

    if (selectedMemberIds.length === 0) {
        addMembersMessage.textContent = '请选择至少1名成员';
        addMembersMessage.className = 'create-group-message error';
        return;
    }

    addMembersMessage.textContent = '';
    addMembersMessage.className = 'create-group-message';



    addGroupMembers(groupId, selectedMemberIds)
        .then(res => { const data = res.data;

            addMembersMessage.textContent = '成员添加成功';
            addMembersMessage.className = 'create-group-message success';

            setTimeout(() => {
                if (modalStore) {
                    modalStore.closeModal('addGroupMember');
                }
                loadGroupMembers(groupId, true);
            }, 1000);
        })
        .catch(error => {
            console.error(`❌ [添加成员] 添加成员到群组 ${groupId} 失败:`, error);
            addMembersMessage.textContent = error.response?.data?.message || error.message || '添加成员失败';
            addMembersMessage.className = 'create-group-message error';
        });
}

function updateGroupName(groupId, newGroupName) {
    const baseStore = useBaseStore();
    const sessionStore = useSessionStore();
    const groupStore = useGroupStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    if (!currentUser || !currentSessionToken) {
        toast.error('请先登录');
        return;
    }

    apiUpdateGroupName(groupId, newGroupName)
        .then(async res => { const data = res.data;
            const groupName = data.newGroupName;
            const currentGroupNameElement = document.getElementById('currentGroupName');
            if (currentGroupNameElement) {
                currentGroupNameElement.textContent = groupName;
            }
            const modalGroupName = document.getElementById('modalGroupName');
            if (modalGroupName) {
                modalGroupName.textContent = `${groupName} - 群组信息`;
            }
            
            if (sessionStore && String(sessionStore.currentGroupId) === String(groupId)) {
                sessionStore.currentGroupName = groupName;
            }
            
            if (groupStore && groupStore.groupsList) {
                const group = groupStore.groupsList.find(g => String(g.id) === String(groupId));
                if (group) {
                    group.name = groupName;
                }
            }
            
            try {
                const userId = currentUser.id;
                const prefix = `chats-${userId}`;
                const key = `${prefix}-group-${groupId}`;
                const existingData = await localForage.getItem(key);
                if (existingData) {
                    const updatedSessionData = { ...existingData };
                    updatedSessionData.name = groupName;
                    await localForage.setItem(key, updatedSessionData);
                }
            } catch (e) {
                console.error('更新群组名称到 IndexedDB 失败:', e);
            }
            
            if (sessionStore && String(sessionStore.currentGroupId) === String(groupId)) {
                sessionStore.currentGroupName = groupName;
            }
            
            toast.success('群组名称已成功更新');
            const manageGroupModal = document.getElementById('manageGroupModal');
            if (manageGroupModal && manageGroupModal.style.display !== 'none') {
                manageGroupModal.style.display = 'none';
            }
        })
        .catch(err => {
            toast.error('修改群组名称失败: ' + (err.response?.data?.message || err.message || '网络错误'));
        });
}

function updateGroupNotice(groupId, newNotice) {
    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    if (!currentUser || !currentSessionToken) {
        toast.error('请先登录');
        return;
    }

    updateGroupDescription(groupId, newNotice)
        .then(res => { const data = res.data;
            toast.success('群组公告已成功更新');
        })
        .catch(err => {
            toast.error('修改群组公告失败: ' + (err.response?.data?.message || err.message || '网络错误'));
        });
}

function uploadGroupAvatar(groupId, file) {
    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    if (!currentUser || !currentSessionToken) {
        toast.error('请先登录');
        return;
    }

    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('groupId', groupId);
    formData.append('userId', currentUser.id);

    toast.info('正在上传群头像，请稍候...');

    apiUploadGroupAvatar(groupId, formData)
        .then(res => { const data = res.data;
            toast.success('群头像上传成功');
            const modal = document.getElementById('groupInfoModal');
            if (modal) {
                modal.style.display = 'none';
            }
            loadGroupList();
        })
        .catch(err => {
            toast.error('上传群头像失败: ' + (err.response?.data?.message || err.message || '网络错误'));
        });
}

function joinGroupWithToken(token, groupId, groupName, popup, isFromGroupCard = false) {
    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    apiJoinGroupWithToken(token, isFromGroupCard)
        .then(res => { const data = res.data;
            toast.success(`成功加入群组: ${groupName}`);
            if (popup) {
                popup.remove();
            }
            loadGroupList();
        })
        .catch(error => {
            console.error('加入群组失败:', error);
            toast.error('加入群组失败: ' + (error.response?.data?.message || error.message || '网络错误'));
        });
}

function showGroupCardPopup(event, groupCardData) {
    openGroupCardPopup(event, groupCardData);
}

function moveGroupToTop(groupId) {
    const groupList = document.getElementById('groupList');
    if (!groupList) return;
    
    const groupItems = groupList.querySelectorAll('li[data-group-id]');
    for (const item of groupItems) {
        if (String(item.getAttribute('data-group-id')) === String(groupId)) {
            groupList.insertBefore(item, groupList.firstChild);
            
            const groupIndex = groupsList.findIndex(g => String(g.id) === String(groupId));
            if (groupIndex > 0) {
                const group = groupsList.splice(groupIndex, 1)[0];
                groupsList.unshift(group);
            }
            
            break;
        }
    }
}

async function switchToGroupChat(groupId, groupName, options = {}) {
    const sessionStore = useSessionStore();
    const groupStore = useGroupStore();
    const baseStore = useBaseStore();
    const draftStore = useDraftStore();
    const noNavigate = !!(options && options.noNavigate);
    
    // 先保存旧群组草稿
    const oldGroupId = sessionStore?.currentGroupId;
    if (oldGroupId) {
      const groupMessageInput = document.getElementById('groupMessageInput');
      if (groupMessageInput) {
        const content = groupMessageInput.textContent || groupMessageInput.innerHTML || '';
        if (draftStore) draftStore.saveDraft('group', oldGroupId, content);
      }
      if (draftStore) draftStore.setLastMessageToDraft('group', oldGroupId);
    }
    
    // 先请求群组信息和成员列表（5秒超时），成功后才设置状态
    try {
      const results = await Promise.race([
        Promise.all([
          getGroupInfo(groupId),
          getGroupMembers(groupId)
        ]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('加载超时')), 5000)
        )
      ]);

      const [infoRes, membersRes] = results;
      const groupInfo = infoRes.data;
      const membersData = membersRes.data;

      // 将成员同步到 groupStore
      if (membersData.members && membersData.members.length > 0) {
        const storeMembers = membersData.members.map(m => ({
          id: Number(m.id),
          nickname: m.nickname || '',
          avatarUrl: m.avatarUrl || '',
          is_admin: Number(m.is_admin) || 0,
          is_muted: m.is_muted || null,
          group_nickname: m.group_nickname || null
        }));
        groupStore.currentGroupMembers = storeMembers;
      } else {
        groupStore.currentGroupMembers = [];
      }
    } catch (err) {
      console.error('打开群组聊天失败:', err);
      toast.error('打开聊天失败: ' + (err.message || '网络错误'));
      return false;
    }
    
    // API 成功后才设置状态
    sessionStore.currentGroupId = groupId;
    sessionStore.currentGroupName = groupName;
    sessionStore.currentSendChatType = 'group';
    sessionStore.selectedGroupIdForCard = groupId;
    
    delete groupChatAllLoaded[groupId];
    
    if (groupStore) {
        groupStore.setGroupAllLoaded(groupId, false);
        groupStore.clearGroupHasAtMe(groupId);
    }
    
    const unreadStore = useUnreadStore();
    if (unreadStore) {
        unreadStore.clearGroupUnread(groupId);
    }
    
    // 导航（嵌入模式下不跳转路由，由 /chat 右侧面板切换渲染）
    setActiveChatDirect('group', groupId, true);
    if (!noNavigate) {
      navigateTo('/chat/group');
    }
    
    window.dispatchEvent(new CustomEvent('group-switched'));
    
    if (typeof updateUnreadCountsDisplay === 'function') {
      updateUnreadCountsDisplay();
    }
    
    const hasMessages = groupStore && groupStore.groupMessages && groupStore.groupMessages[groupId] && groupStore.groupMessages[groupId].length > 0;
    switchingGroupWithExistingMessages = hasMessages;
    
    return true;
}

function loadGroupMessages(groupId) {
}

async function updateGroupList(groups) {
    groupsList = groups;

    const baseStore = useBaseStore();
    const sessionStore = useSessionStore();
    const groupStore = useGroupStore();
    const unreadStore = useUnreadStore();
    
    if (groupStore) {
        const userId = baseStore.currentUser?.id || 'guest';
        const prefix = `chats-${userId}`;

        groupStore.loadGroupsWithAtMeFromLocalStorage(baseStore.currentUser);

        const existingGroups = groupStore.groupsList || [];
        const existingGroupMap = new Map();
        existingGroups.forEach(g => existingGroupMap.set(String(g.id), g));

        const serverGroupIds = new Set(groups.map(g => String(g.id)));

        // 本次同步过程中统一维护已删除会话快照，末尾一次性写回 localStorage
        let deletedSnapshot = getDeletedGroupSnapshot();

        let chatKeysData = null;
        try {
            chatKeysData = await localForage.getItem(prefix);
        } catch (e) {
            console.error('读取 chatKeys 失败:', e);
        }
        
        const localGroupIdsFromKeys = new Set();
        if (chatKeysData && chatKeysData.chatKeys) {
            chatKeysData.chatKeys.forEach(key => {
                if (key.includes('-group-')) {
                    const groupId = key.split('-group-')[1];
                    localGroupIdsFromKeys.add(groupId);
                }
            });
        }

        const newChatKeys = chatKeysData && chatKeysData.chatKeys ? [...chatKeysData.chatKeys] : [];
        for (const group of groups) {
            const groupIdStr = String(group.id);
            const key = `${prefix}-group-${groupIdStr}`;
            if (!localGroupIdsFromKeys.has(groupIdStr)) {
                newChatKeys.push(key);
                localGroupIdsFromKeys.add(groupIdStr);
            }
        }
        try {
            await localForage.setItem(prefix, { chatKeys: newChatKeys });
        } catch (e) {
            console.error('更新 chatKeys 失败:', e);
        }

        for (const group of groups) {
            const existingGroup = existingGroupMap.get(String(group.id));
            
            try {
                const key = `${prefix}-group-${group.id}`;
                const existingData = await localForage.getItem(key) || { messages: [] };
                const updatedSessionData = { ...existingData };
                if (group.name) updatedSessionData.name = group.name;
                if (group.avatar_url) updatedSessionData.avatarUrl = group.avatar_url;
                else if (group.avatarUrl) updatedSessionData.avatarUrl = group.avatarUrl;
                
                delete updatedSessionData.deleted_at;
                // 服务器仍返回该会话（已恢复），清除对应已删除快照
                if (deletedSnapshot[String(group.id)]) {
                  delete deletedSnapshot[String(group.id)];
                }
                
                await localForage.setItem(key, updatedSessionData);
            } catch (e) {
                console.error('更新IndexedDB中的群组会话信息失败:', e);
            }
        }

        for (const groupId of localGroupIdsFromKeys) {
            const groupIdStr = String(groupId);
            if (!serverGroupIds.has(groupIdStr)) {
                try {
                    const key = `${prefix}-group-${groupId}`;
                    const existingData = await localForage.getItem(key);
                    if (!existingData?.deleted_at) {
                        let updatedSessionData;
                        if (existingData) {
                            updatedSessionData = { ...existingData };
                        } else {
                            const existingGroup = existingGroupMap.get(groupIdStr);
                            updatedSessionData = { messages: [] };
                            if (existingGroup) {
                                if (existingGroup.name) updatedSessionData.name = existingGroup.name;
                                if (existingGroup.avatar_url) updatedSessionData.avatarUrl = existingGroup.avatar_url;
                                else if (existingGroup.avatarUrl) updatedSessionData.avatarUrl = existingGroup.avatarUrl;
                            }
                        }
                        
                        if (!updatedSessionData.name) {
                            try {
                                const res = await getGroupInfo(groupId);
                                const responseData = res.data;
                                if (responseData.group) {
                                    if (!updatedSessionData.name && responseData.group.name) {
                                        updatedSessionData.name = responseData.group.name;
                                    }
                                    if (!updatedSessionData.avatarUrl && responseData.group.avatar_url) {
                                        updatedSessionData.avatarUrl = responseData.group.avatar_url;
                                    }
                                }
                            } catch (e) {
                                console.error('获取群组信息失败:', e);
                            }
                        }
                        
                        const deletedTime = new Date().toISOString();
                        updatedSessionData.deleted_at = deletedTime;
                        await localForage.setItem(key, updatedSessionData);
                        // 持久化已删除会话快照，确保清空 IndexedDB 后首屏仍能显示
                        deletedSnapshot[groupIdStr] = {
                          name: updatedSessionData.name || '',
                          avatarUrl: updatedSessionData.avatarUrl || null,
                          deleted_at: deletedTime
                        };
                    }
                } catch (e) {
                    console.error('更新群组deleted_at失败:', e);
                }
            }
        }

        const allGroups = [];
        // 构建服务端群组映射，用于合并 is_disturb 等字段
        const serverGroupMap = new Map();
        groups.forEach(g => serverGroupMap.set(String(g.id), g));

        for (const groupId of localGroupIdsFromKeys) {
            try {
                const key = `${prefix}-group-${groupId}`;
                const data = await localForage.getItem(key);
                if (data) {
                    let groupName = data.name || '群组';
                    
                    if (!data.name) {
                        try {
                            const res = await getGroupInfo(groupId);
                            if (res.data.group) {
                                    if (!data.name && res.data.group.name) {
                                        groupName = res.data.group.name;
                                        data.name = res.data.group.name;
                                    }
                                    if (!data.avatarUrl && res.data.group.avatar_url) {
                                        data.avatarUrl = res.data.group.avatar_url;
                                    }
                                    const key = `${prefix}-group-${groupId}`;
                                    const updatedData = { ...data };
                                    await localForage.setItem(key, updatedData);
                                }
                        } catch (e) {
                            console.error('获取群组信息失败:', e);
                        }
                    }
                    
                    const serverGroup = serverGroupMap.get(groupId);
                    const group = {
                        id: groupId,
                        name: groupName,
                        avatarUrl: data.avatarUrl ?? null,
                        deleted_at: data.deleted_at ?? null,
                        is_disturb: serverGroup ? serverGroup.is_disturb : null
                    };
                    
                    if (data.last_message_time) {
                        group.last_message_time = data.last_message_time;
                    }
                    
                    // 优先使用服务器返回的 lastMessage（已含群昵称替换）
                    if (serverGroup && serverGroup.lastMessage) {
                        group.lastMessage = serverGroup.lastMessage;
                    } else if (data.messages && data.messages.length > 0) {
                        const validMessages = data.messages.filter(m => m.messageType !== 101 && m.messageType !== 102);
                        if (validMessages.length > 0) {
                            group.lastMessage = validMessages[validMessages.length - 1];
                            if (!group.last_message_time) {
                                group.last_message_time = validMessages[validMessages.length - 1].timestamp || new Date().toISOString();
                            }
                        }
                    }
                    
                    allGroups.push(group);
                }
            } catch (e) {
                console.error('从IndexedDB加载群组失败:', e);
            }
        }

        // 补入快照中的已删除会话（IndexedDB 已无该会话数据时，首次拉取也能显示）
        const loadedGroupIds = new Set(localGroupIdsFromKeys);
        Object.keys(deletedSnapshot).forEach(groupIdStr => {
          if (!loadedGroupIds.has(groupIdStr)) {
            const meta = deletedSnapshot[groupIdStr] || {};
            allGroups.push({
              id: Number(groupIdStr),
              name: meta.name || '群组',
              avatarUrl: meta.avatarUrl || null,
              deleted_at: meta.deleted_at || new Date().toISOString(),
              is_disturb: null
            });
          }
        });

        groupStore.groupsList = allGroups;
        groupStore.sortGroupsByLastMessageTime();

        saveDeletedGroupSnapshot(deletedSnapshot);
    }

    updateUnreadCountsDisplay();
    if (unreadStore) {
        unreadStore.unreadMessages = { ...unreadStore.unreadMessages };
    }
}

function showSendGroupCardModal(chatType) {
    const sessionStore = useSessionStore();
    const modalStore = useModalStore();
    if (sessionStore) {
        sessionStore.currentSendChatType = chatType;
        sessionStore.selectedGroupIdForCard = null;
    }

    if (modalStore) {
        modalStore.openModal('sendGroupCard');
    }
}

function sendGroupCard() {
    const sessionStore = useSessionStore();
    const groupStore = useGroupStore();
    const baseStore = useBaseStore();
    const modalStore = useModalStore();
    
    if (!sessionStore || !sessionStore.selectedGroupIdForCard) {
        return;
    }

    const selectedGroupIdForCard = sessionStore.selectedGroupIdForCard;
    const currentSendChatType = sessionStore.currentSendChatType;
    const currentPrivateChatUserId = sessionStore.currentPrivateChatUserId;
    const currentGroupId = sessionStore.currentGroupId;
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    const chatSocket = getChatSocket();

    generateGroupToken(selectedGroupIdForCard)
        .then(res => { const data = res.data;
            const token = data.token;

            getGroupInfo(selectedGroupIdForCard)
                .then(res => { const groupData = res.data;
                    const group = groupData.group;
                    
                    const groupCardContent = JSON.stringify({
                        type: 'group_card',
                        group_id: group.id,
                        group_name: group.name || '',
                        group_description: group.description || '',
                        invite_token: token,
                        avatar_url: group.avatar_url || group.avatarUrl || ''
                    });

                    if (chatSocket) {
                        if (currentSendChatType === 'main') {
                            chatSocket.emit('send-message', {
                                content: groupCardContent,
                                messageType: 3,
                                sessionToken: currentSessionToken,
                                userId: Number(currentUser.id)
                            });
                        } else if (currentSendChatType === 'group') {
                            chatSocket.emit('send-message', {
                                content: groupCardContent,
                                messageType: 3,
                                groupId: Number(currentGroupId),
                                sessionToken: currentSessionToken,
                                userId: Number(currentUser.id)
                            });
                        } else if (currentSendChatType === 'private' && currentPrivateChatUserId) {
                            chatSocket.emit('send-private-message', {
                                content: groupCardContent,
                                messageType: 3,
                                receiverId: Number(currentPrivateChatUserId),
                                sessionToken: currentSessionToken,
                                userId: Number(currentUser.id)
                            });
                        }
                    }

                    if (modalStore) {
                        modalStore.closeModal('sendGroupCard');
                    }
                    
                    setTimeout(() => {
                        let container = null;
                        if (currentSendChatType === 'main') {
                            container = document.getElementById('messageContainer');
                        } else if (currentSendChatType === 'group') {
                            container = document.getElementById('groupMessageContainer');
                        } else if (currentSendChatType === 'private') {
                            container = document.getElementById('privateMessageContainer');
                        }
                        if (container) {
                            container.scrollTop = container.scrollHeight;
                        }
                    }, 100);
                })
                .catch(error => {
                    console.error('获取群组信息失败:', error);
                });
        })
        .catch(error => {
            console.error('生成群组邀请Token失败:', error);
        });
}

export {
  loadGroupList,
  getMutedGroups,
  isGroupMuted,
  toggleGroupMute,
  loadGroupMembers,
  showAddGroupMemberModal,
  hideAddGroupMemberModal,
  confirmAddGroupMembers,
  updateGroupName,
  updateGroupNotice,
  uploadGroupAvatar,
  joinGroupWithToken,
  showGroupCardPopup,
  moveGroupToTop,
  switchToGroupChat,
  loadGroupMessages,
  updateGroupList,
  showSendGroupCardModal,
  sendGroupCard,
  handleDissolveGroup,
  handleLeaveGroup,
  dissolveGroup,
  removeMemberFromGroup,
  groupsList,
  currentSharedGroup,
  switchingGroupWithExistingMessages,
  groupChatAllLoaded
};

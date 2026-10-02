// Compatibility shim. The conversation/profile store lives in the local data
// layer (src/db — SQLite under IRISES_HOME). This file preserves the original
// import path and signatures so existing call sites need no changes.
export type { StoredMessage } from '../db/repositories/conversations.js';
export type { UserProfile } from '../db/repositories/profiles.js';
export {
  getConversation,
  addMessage,
  removeMessage,
  clearConversation,
  hasHistory,
} from '../db/repositories/conversations.js';
export {
  getUserProfile,
  updateUserProfile,
  addUserFact,
  setUserName,
  clearUserProfile,
} from '../db/repositories/profiles.js';

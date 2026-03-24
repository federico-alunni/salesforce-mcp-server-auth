// ============================================================================
// Module A — User Service
// Simple user management. Users are created on first OAuth authorization.
// ============================================================================

import { randomUUID } from 'crypto';
import type { LocalUser } from '../../../types/index.js';
import { findOne, upsert } from '../../../shared/storage/file-store.js';
import { logger } from '../../../shared/logger.js';

const COLLECTION = 'local_users';

export function getOrCreateUser(displayName: string): LocalUser {
  let user = findOne<LocalUser>(COLLECTION, u => u.displayName === displayName);
  if (user) return user;

  user = {
    id: randomUUID(),
    displayName,
    createdAt: Date.now(),
  };
  upsert(COLLECTION, user);
  logger.auditLog('user_created', user.id, { displayName });
  return user;
}

export function getUserById(userId: string): LocalUser | undefined {
  return findOne<LocalUser>(COLLECTION, u => u.id === userId);
}

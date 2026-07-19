// Verrou d'édition exclusif (fichier public data/auth/edit-lock.json sur GitHub).

import { loadSiteConfig, authPaths } from './site.js';
import { loadGithubMeta, publishFile, fetchTextFile } from '../github.js';
import { loadRegistry, saveRegistry } from './registry.js';

export const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
export const HEARTBEAT_MS = 15 * 60 * 1000;
export const POLL_MS = 2 * 60 * 1000;

function emptyLock() {
  return { v: 1, userId: null, displayName: null, since: null, expiresAt: null };
}

export function isLockActive(lock) {
  if (!lock?.userId || !lock?.expiresAt) return false;
  return new Date(lock.expiresAt) > new Date();
}

export async function loadEditLock() {
  try {
    const site = await loadSiteConfig();
    const { editLock } = authPaths(site);
    const lock = JSON.parse(await fetchTextFile(editLock));
    return isLockActive(lock) ? lock : emptyLock();
  } catch (_) {
    return emptyLock();
  }
}

async function publishToken() {
  const { getGithubTokenFromMk } = await import('../github.js');
  return getGithubTokenFromMk();
}

async function writeEditLock(lock, key) {
  const site = await loadSiteConfig();
  const { editLock: path } = authPaths(site);
  const meta = loadGithubMeta();
  if (!meta?.owner) throw new Error('GITHUB_META');
  const token = await publishToken();
  await publishFile(
    meta.owner, meta.repo, path, meta.branch || 'main', token,
    JSON.stringify({ ...emptyLock(), ...lock }, null, 2) + '\n',
    lock.userId ? 'Verrou édition arbre' : 'Libération verrou édition',
  );
  return lock;
}

export async function acquireEditLock(user, key) {
  const current = await loadEditLock();
  if (isLockActive(current) && current.userId !== user.id) {
    const err = new Error('LOCK_HELD');
    err.lock = current;
    throw err;
  }
  const lock = {
    v: 1,
    userId: user.id,
    displayName: user.displayName,
    since: new Date().toISOString(),
    expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
  };
  await writeEditLock(lock, key);
  return lock;
}

export async function extendEditLock(user, key) {
  const current = await loadEditLock();
  if (!isLockActive(current) || current.userId !== user.id) return null;
  const lock = {
    ...current,
    expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
  };
  await writeEditLock(lock, key);
  return lock;
}

export async function releaseEditLock(key) {
  await writeEditLock(emptyLock(), key);
}

export function isGlobalTreeLocked(registry) {
  return !!registry?.treeEditLocked;
}

export async function setGlobalTreeLock(locked, reason, adminUser) {
  const registry = await loadRegistry();
  registry.treeEditLocked = !!locked;
  registry.treeEditLockedBy = locked ? adminUser.id : null;
  registry.treeEditLockedAt = locked ? new Date().toISOString() : null;
  registry.treeEditLockedReason = locked ? String(reason || '').trim() : '';
  await saveRegistry(registry);
  return registry;
}

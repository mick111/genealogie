// Registry (JSON public : métadonnées + enveloppes MK chiffrées par utilisateur).

import { loadSiteConfig, authPaths, getRegistrationPublishToken } from './site.js';
import { loadGithubMeta, publishFile, fetchTextFile, loadBundledGithubConfig } from '../github.js';

export const ROLES = ['viewer', 'self', 'editor', 'admin'];

export const ROLE_LABELS = {
  viewer: 'Lecture seule',
  self: 'Sa fiche uniquement',
  editor: 'Éditeur (arbre + publication)',
  admin: 'Administrateur',
};

export async function loadRegistry() {
  const site = await loadSiteConfig();
  const { registry } = authPaths(site);
  try {
    const text = await fetchTextFile(registry);
    return JSON.parse(text);
  } catch (_) {
    return { v: 1, users: [] };
  }
}

function mergeRegistryUsers(remote, local) {
  const localById = new Map(local.users.map((u) => [u.id, u]));
  const users = remote.users.map((remoteUser) => {
    const patch = localById.get(remoteUser.id);
    return patch ? { ...remoteUser, ...patch } : remoteUser;
  });
  for (const u of local.users) {
    if (!users.some((x) => x.id === u.id)) users.push(u);
  }
  return { ...remote, ...local, users };
}

export async function saveRegistry(registry) {
  const site = await loadSiteConfig();
  const { registry: path } = authPaths(site);
  await loadBundledGithubConfig();
  const meta = loadGithubMeta();
  if (!meta?.owner) throw new Error('GITHUB_META');
  const { getGithubTokenFromMk } = await import('../github.js');
  const token = await getGithubTokenFromMk();
  let toSave = registry;
  try {
    const remote = JSON.parse(await fetchTextFile(path));
    toSave = mergeRegistryUsers(remote, registry);
  } catch (_) { /* premier enregistrement */ }
  await publishFile(meta.owner, meta.repo, path, meta.branch || 'main', token,
    JSON.stringify(toSave, null, 2) + '\n', 'Mise à jour registry auth');
  return toSave;
}

export async function loadPending() {
  const site = await loadSiteConfig();
  const { pending } = authPaths(site);
  try {
    return JSON.parse(await fetchTextFile(pending));
  } catch (_) {
    return { v: 1, pending: [] };
  }
}

export async function savePending(pendingDoc) {
  const site = await loadSiteConfig();
  const { pending } = authPaths(site);
  await loadBundledGithubConfig();
  const meta = loadGithubMeta();
  if (!meta?.owner) throw new Error('GITHUB_META');
  const token = await getRegistrationPublishToken();
  await publishFile(meta.owner, meta.repo, pending, meta.branch || 'main', token,
    JSON.stringify(pendingDoc, null, 2) + '\n', 'Inscription généalogie');
}

export async function appendPending(entry) {
  const doc = await loadPending();
  if (doc.pending.some((p) => p.credentialId === entry.credentialId)) throw new Error('ALREADY_PENDING');
  doc.pending.push(entry);
  await savePending(doc);
}

export function findUserByCredential(registry, credentialId) {
  return registry.users.find((u) => u.credentialId === credentialId && u.status === 'approved');
}

export function hasAdmin(registry) {
  return registry.users.some((u) => u.role === 'admin' && u.status === 'approved' && !u.needsPasskey);
}

export function findBootstrapAdmin(registry) {
  return registry.users.find((u) => u.role === 'admin' && u.needsPasskey);
}

// github.js — publication de data/tree.enc via l'API GitHub.
// Le token personnel est chiffré (AES-GCM) avec la clé dérivée du mot de passe
// de l'arbre, puis stocké dans localStorage.

import { encryptText, decryptTextWithKey } from './crypto.js';
import { getCurrentTreeId, defaultGithubPath } from './trees.js';

const META_KEY = 'gen_github_meta_v1';
const TOKEN_KEY = 'gen_github_token_v1';
const BUNDLED_META_URL = 'data/github_meta.json';
const BUNDLED_TOKEN_URL = 'data/github_token.enc';
const API = 'https://api.github.com';

let bundledMeta = null;
let bundledToken = null;

export function detectGithubRepo() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return null;
  const owner = host.slice(0, -'.github.io'.length);
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length >= 1) return { owner, repo: parts[0] };
  return { owner, repo: `${owner}.github.io` };
}

export function loadGithubMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return bundledMeta;
}

export function hasGithubToken() {
  return !!localStorage.getItem(TOKEN_KEY) || !!bundledToken;
}

// Charge token + meta embarqués (data/*.enc / *.json), chiffrés comme tree.enc.
export async function loadBundledGithubConfig() {
  if (!bundledMeta) {
    try {
      const res = await fetch(BUNDLED_META_URL, { cache: 'no-store' });
      if (res.ok) bundledMeta = await res.json();
    } catch (_) { /* ignore */ }
  }
  if (!bundledToken) {
    try {
      const res = await fetch(BUNDLED_TOKEN_URL, { cache: 'no-store' });
      if (res.ok) bundledToken = await res.json();
    } catch (_) { /* ignore */ }
  }
}

export async function saveGithubSettings(key, kdf, { owner, repo, branch, path, token }) {
  const meta = {
    owner: (owner || '').trim(),
    repo: (repo || '').trim(),
    branch: (branch || 'main').trim() || 'main',
    path: (path || defaultGithubPath(getCurrentTreeId() || 'principal')).trim(),
  };
  if (!meta.owner || !meta.repo) throw new Error('OWNER_REPO');
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  if (token) {
    const enc = await encryptText(key, kdf, token.trim());
    localStorage.setItem(TOKEN_KEY, JSON.stringify(enc));
  }
}

export function clearGithubSettings() {
  localStorage.removeItem(META_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

async function getGithubToken(key) {
  const raw = localStorage.getItem(TOKEN_KEY);
  const container = raw ? JSON.parse(raw) : bundledToken;
  if (!container) throw new Error('NO_TOKEN');
  try {
    return await decryptTextWithKey(key, container);
  } catch (_) {
    throw new Error('BAD_TOKEN');
  }
}

// Token admin déchiffré avec la clé maître MK (auth passkey).
export async function getGithubTokenFromMk() {
  const { authSession } = await import('./auth/session.js');
  if (!authSession.mkKey) throw new Error('NO_TOKEN');
  return getGithubToken(authSession.mkKey);
}

function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function ghFetch(path, token, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    try { body = await res.json(); } catch (_) { /* ignore */ }
  }
  if (!res.ok) {
    const msg = body?.message || res.statusText || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

function githubErrorMessage(err) {
  if (err.message === 'NO_TOKEN') return 'Aucun token GitHub enregistré. Configure la publication.';
  if (err.message === 'BAD_TOKEN') return 'Token GitHub illisible (mot de passe changé ?). Reconfigure-le.';
  if (err.message === 'REG_TOKEN_MISSING') return 'Token d\'inscription absent (data/github_reg_token.enc).';
  if (err.message === 'GITHUB_META') return 'Configuration GitHub absente (data/github_meta.json).';
  if (err.message === 'ALREADY_PENDING') return 'Une demande est déjà en cours pour cette passkey.';
  if (err.message === 'OWNER_REPO') return 'Indique le dépôt GitHub (propriétaire et nom).';
  if (err.status === 401) return 'Token GitHub refusé (expiré ou invalide).';
  if (err.status === 403) return 'Accès refusé : le token doit autoriser l\'écriture sur le dépôt (scope « repo » ou « Contents : Read and write »).';
  if (err.status === 404) return 'Dépôt ou fichier introuvable. Vérifie propriétaire, nom, branche et chemin.';
  if (err.status === 409) return 'Conflit sur GitHub : le fichier a été modifié entre-temps. Recharge la page et réessaie.';
  return err.message || String(err);
}

export async function publishTree(key, container, onStage = () => {}, treeId = getCurrentTreeId() || 'principal') {
  const saved = loadGithubMeta();
  if (!saved?.owner || !saved?.repo) throw new Error('OWNER_REPO');
  const meta = { ...saved, path: defaultGithubPath(treeId) };
  onStage('Préparation…');
  const token = await getGithubToken(key);
  onStage('Envoi vers GitHub…');
  await publishFile(meta.owner, meta.repo, meta.path, meta.branch, token,
    JSON.stringify(container), 'Mise à jour arbre généalogique', onStage);
  onStage('Terminé.');
}

export async function publishFile(owner, repo, path, branch, token, content, message, onStage = () => {}) {
  const pathEnc = encodeURIComponent(path).replace(/%2F/g, '/');
  const refQ = `?ref=${encodeURIComponent(branch)}`;
  const put = async (sha) => {
    onStage('Envoi vers GitHub…');
    await ghFetch(`/repos/${owner}/${repo}/contents/${pathEnc}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: utf8ToB64(content),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
  };
  onStage('Lecture du fichier distant…');
  let sha;
  try {
    const existing = await ghFetch(`/repos/${owner}/${repo}/contents/${pathEnc}${refQ}`, token);
    sha = existing.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  try {
    await put(sha);
  } catch (err) {
    // Conflit : le fichier a changé sur GitHub entre la lecture et l'envoi (ex. registry.json).
    if (err.status !== 409 || !sha) throw err;
    onStage('Conflit distant, nouvelle tentative…');
    const existing = await ghFetch(`/repos/${owner}/${repo}/contents/${pathEnc}${refQ}`, token);
    await put(existing.sha);
  }
}

export async function fetchTextFile(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Fichier introuvable : ${path} (${res.status})`);
  return res.text();
}

export { githubErrorMessage, ghFetch, utf8ToB64 };

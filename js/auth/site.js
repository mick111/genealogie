// Configuration auth (data/auth/site.json) et clé de publication des inscriptions.

import { deriveKey } from '../crypto.js';

const SITE_URL = 'data/auth/site.json';
const REG_TOKEN_URL = 'data/github_reg_token.enc';
const REG_KDF = { name: 'PBKDF2', hash: 'SHA-256', iterations: 120000, salt: 'genealogie-reg-v1' };

let siteConfig = null;

export function getRpId() {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'localhost';
  return host;
}

export async function loadSiteConfig() {
  if (siteConfig) return siteConfig;
  const res = await fetch(SITE_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('AUTH_NOT_CONFIGURED');
  siteConfig = await res.json();
  return siteConfig;
}

export function isAuthEnabled() {
  return true; // vérifié par loadSiteConfig dans boot
}

async function registrationPublishKey(site) {
  const material = `reg|${site.v}|${site.regSalt}|${site.repoId || 'genealogie'}`;
  const saltB64 = btoa(String.fromCharCode(...new TextEncoder().encode('genealogie-reg-v1')));
  return deriveKey(material, saltB64, REG_KDF.iterations, REG_KDF.hash);
}

export async function getRegistrationPublishToken() {
  const site = await loadSiteConfig();
  const key = await registrationPublishKey(site);
  const { decryptTextWithKey } = await import('../crypto.js');
  const res = await fetch(REG_TOKEN_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('REG_TOKEN_MISSING');
  const container = await res.json();
  return decryptTextWithKey(key, container);
}

export function authPaths(site) {
  return {
    pending: site.pendingPath || 'data/auth/pending.json',
    registry: site.registryPath || 'data/auth/registry.json',
  };
}

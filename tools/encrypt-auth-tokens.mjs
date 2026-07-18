#!/usr/bin/env node
// Re-chiffre les tokens GitHub pour l'auth passkey (après migration).
//
// Fichiers en clair (gitignore) :
//   token_publish  → data/github_token.enc      (clé maître MK, admin)
//   token_register → data/github_reg_token.enc  (clé dérivée publique RPK)
//
// Repli : token (legacy, les deux fichiers .enc si un seul token)
//
// Usage :
//   ADMIN_PIN=12345678 node tools/encrypt-auth-tokens.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pbkdf2Sync, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { loadPublishToken, loadRegisterToken } from './token-files.mjs';

function aesEncrypt(buffer, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buffer), c.final()]);
  const ct = Buffer.concat([enc, c.getAuthTag()]);
  return { v: 1, cipher: 'AES-GCM', iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function aesDecrypt(container, key) {
  const iv = Buffer.from(container.iv, 'base64');
  const buf = Buffer.from(container.ct, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(0, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}

function pinDerivedKey(userId, pin) {
  return pbkdf2Sync(pin, Buffer.from('pin|' + userId, 'utf8'), 150000, 32, 'sha256');
}

function regPublishKey(site) {
  const material = `reg|${site.v}|${site.regSalt}|${site.repoId || 'genealogie'}`;
  return pbkdf2Sync(material, Buffer.from('genealogie-reg-v1', 'utf8'), 120000, 32, 'sha256');
}

function unwrapAdminMk(registry, adminPin) {
  const admin = registry.users.find((u) => u.role === 'admin' && u.status === 'approved');
  if (!admin?.pinWrap) throw new Error('Admin ou pinWrap introuvable dans registry.json');
  return aesDecrypt(admin.pinWrap, pinDerivedKey(admin.id, adminPin));
}

async function main() {
  if (!existsSync('data/auth/site.json')) {
    console.error('Auth non configurée : lancez d’abord node tools/migrate-auth.mjs');
    process.exit(1);
  }

  let adminPin = process.env.ADMIN_PIN || '';
  if (!/^\d{8}$/.test(adminPin)) {
    console.error('Indiquez ADMIN_PIN (8 chiffres), ex. ADMIN_PIN=12345678 node tools/encrypt-auth-tokens.mjs');
    process.exit(1);
  }

  const site = JSON.parse(readFileSync('data/auth/site.json', 'utf8'));
  const registry = JSON.parse(readFileSync('data/auth/registry.json', 'utf8'));
  const mk = unwrapAdminMk(registry, adminPin);

  const publishTok = loadPublishToken();
  const registerTok = loadRegisterToken();

  if (publishTok) {
    writeFileSync('data/github_token.enc', JSON.stringify(aesEncrypt(Buffer.from(publishTok, 'utf8'), mk)));
    console.log('✓ token_publish → data/github_token.enc');
  } else {
    console.log('— token_publish absent (data/github_token.enc inchangé)');
  }

  if (registerTok) {
    writeFileSync('data/github_reg_token.enc', JSON.stringify(aesEncrypt(Buffer.from(registerTok, 'utf8'), regPublishKey(site))));
    console.log('✓ token_register → data/github_reg_token.enc');
  } else {
    console.log('— token_register absent (data/github_reg_token.enc inchangé)');
  }

  if (!publishTok && !registerTok) {
    console.error('\nCréez token_publish et/ou token_register (ou token) à la racine.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

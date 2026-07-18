#!/usr/bin/env node
// Chiffre un token GitHub avec la même clé que data/tree.enc (mot de passe + sel du conteneur).
// Usage : node tools/encrypt-github-token.mjs <fichier_token>
//   Le fichier contient le PAT en ligne 1, le mot de passe arbre en ligne 2.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { loadPassword } from './passwd.mjs';

const TOKEN_FILE = process.argv[2];
if (!TOKEN_FILE) {
  console.error('Usage : node tools/encrypt-github-token.mjs <fichier_token>');
  process.exit(1);
}

const lines = readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const token = lines[0];
const password = lines[1] || loadPassword();
if (!token || !password) {
  console.error('Le fichier doit contenir le token (ligne 1) ; mot de passe en ligne 2, dans passwd, ou via GEN_PASSWORD.');
  process.exit(1);
}

const tree = JSON.parse(readFileSync('data/tree.enc', 'utf8'));
const { kdf } = tree;
const key = pbkdf2Sync(password, Buffer.from(kdf.salt, 'base64'), kdf.iterations, 32, 'sha256');

const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
const ct = Buffer.concat([enc, cipher.getAuthTag()]);

const container = {
  v: 1,
  kdf,
  cipher: 'AES-GCM',
  iv: iv.toString('base64'),
  ct: ct.toString('base64'),
};

writeFileSync('data/github_token.enc', JSON.stringify(container));

const meta = {
  owner: 'mick111',
  repo: 'genealogie',
  branch: 'main',
  path: 'trees/principal/tree.enc',
};
writeFileSync('data/github_meta.json', JSON.stringify(meta, null, 2) + '\n');

unlinkSync(TOKEN_FILE);
console.log('OK : data/github_token.enc + data/github_meta.json créés, fichier source supprimé.');

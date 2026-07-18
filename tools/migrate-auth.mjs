#!/usr/bin/env node
// Migration one-shot : mot de passe arbre → clé maître MK + auth passkey/PIN.
//
// Usage : node tools/migrate-auth.mjs --tree principal [--from-ged merged.ged]
//   PIN admin 8 chiffres (secours) + mot de passe arbre via passwd / GEN_PASSWORD.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadPassword } from './passwd.mjs';
import { loadPublishToken, loadRegisterToken } from './token-files.mjs';

const ITER = 200000;

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

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

function decryptLegacyGedcom(container, password) {
  if (!container?.kdf?.salt) {
    throw new Error(
      'Conteneur invalide (kdf manquant). Le fichier a probablement été corrompu par une publication.\n' +
      '  → git checkout HEAD -- trees/principal/tree.enc\n' +
      '  → ou : node tools/migrate-auth.mjs --from-ged merged.ged',
    );
  }
  const key = pbkdf2Sync(password, Buffer.from(container.kdf.salt, 'base64'), container.kdf.iterations, 32, 'sha256');
  return aesDecrypt(container, key).toString('utf8');
}

function readGedcomSource(treeId, encPath, password) {
  const fromGedIdx = process.argv.indexOf('--from-ged');
  if (fromGedIdx >= 0 && process.argv[fromGedIdx + 1]) {
    return readFileSync(process.argv[fromGedIdx + 1], 'utf8');
  }
  const container = JSON.parse(readFileSync(encPath, 'utf8'));
  if (container.v === 2 && container.type === 'tree') {
    throw new Error('Arbre déjà migré (v2 MK). Utilisez encrypt-auth-tokens.mjs pour les tokens.');
  }
  if (container.v === 1 && container.type === 'tree' && !container.kdf) {
    throw new Error(
      `Conteneur corrompu : ${encPath} (v1/tree sans kdf).\n` +
      'Restaurez une sauvegarde : git checkout HEAD -- ' + encPath,
    );
  }
  return decryptLegacyGedcom(container, password);
}

function encryptTree(mk, text) {
  const enc = aesEncrypt(Buffer.from(text, 'utf8'), mk);
  return { v: 2, type: 'tree', cipher: enc.cipher, iv: enc.iv, ct: enc.ct };
}

function pinDerivedKey(userId, pin) {
  return pbkdf2Sync(pin, Buffer.from('pin|' + userId, 'utf8'), 150000, 32, 'sha256');
}

function regPublishKey(site) {
  const material = `reg|${site.v}|${site.regSalt}|${site.repoId}`;
  return pbkdf2Sync(material, Buffer.from('genealogie-reg-v1', 'utf8'), 120000, 32, 'sha256');
}

async function main() {
  const treeId = process.argv.includes('--tree')
    ? process.argv[process.argv.indexOf('--tree') + 1] : 'principal';
  const encPath = `trees/${treeId}/tree.enc`;
  if (!existsSync(encPath)) {
    console.error('Fichier introuvable :', encPath);
    process.exit(1);
  }

  let adminPin = process.env.ADMIN_PIN || '';
  while (!/^\d{8}$/.test(adminPin)) {
    adminPin = await ask('PIN admin secours (8 chiffres) : ');
  }

  const password = loadPassword();
  if (!password) {
    console.error('Mot de passe arbre requis (passwd ou GEN_PASSWORD).');
    process.exit(1);
  }

  const gedcom = readGedcomSource(treeId, encPath, password);
  const mk = randomBytes(32);
  const adminId = 'admin-' + randomBytes(4).toString('hex');

  mkdirSync('data/auth', { recursive: true });

  const regSalt = randomBytes(16).toString('base64');
  const site = {
    v: 1,
    repoId: 'genealogie',
    regSalt,
    pendingPath: 'data/auth/pending.json',
    registryPath: 'data/auth/registry.json',
  };
  writeFileSync('data/auth/site.json', JSON.stringify(site, null, 2) + '\n');
  writeFileSync('data/auth/pending.json', JSON.stringify({ v: 1, pending: [] }, null, 2) + '\n');

  const pinWrap = aesEncrypt(mk, pinDerivedKey(adminId, adminPin));
  const registry = {
    v: 1,
    users: [{
      id: adminId,
      displayName: 'Administrateur',
      role: 'admin',
      status: 'approved',
      needsPasskey: true,
      pinWrap,
      createdAt: new Date().toISOString(),
    }],
  };
  writeFileSync('data/auth/registry.json', JSON.stringify(registry, null, 2) + '\n');

  writeFileSync(encPath, JSON.stringify(encryptTree(mk, gedcom)));

  const regTokPath = 'data/github_reg_token.enc';
  const adminTokPath = 'data/github_token.enc';
  const publishTok = loadPublishToken();
  const registerTok = loadRegisterToken();

  if (publishTok) {
    writeFileSync(adminTokPath, JSON.stringify(aesEncrypt(Buffer.from(publishTok, 'utf8'), mk)));
    console.log('✓ token_publish → data/github_token.enc');
  }
  if (registerTok) {
    writeFileSync(regTokPath, JSON.stringify(aesEncrypt(Buffer.from(registerTok, 'utf8'), regPublishKey(site))));
    console.log('✓ token_register → data/github_reg_token.enc');
  }
  if (!publishTok && !registerTok) {
    if (existsSync(adminTokPath)) {
      console.log('⚠  Ajoutez token_publish et/ou token_register (ou token) à la racine.');
    }
  } else if (publishTok && !registerTok) {
    console.log('⚠  token_register absent : inscriptions auto indisponibles.');
  } else if (!publishTok && registerTok) {
    console.log('⚠  token_publish absent : publication admin indisponible.');
  }

  console.log('\n✓ Migration terminée.');
  console.log('  - Arbre v2 MK :', encPath);
  console.log('  - Auth : data/auth/');
  console.log('\nPIN admin (secours) :', adminPin);
  console.log('Dans le navigateur : connexion PIN → créer passkey admin → publier.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });

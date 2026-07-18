#!/usr/bin/env node
// build.mjs — chiffre le GEDCOM ET les photos avec une même clé (même sel),
// pour publication sur GitHub Pages.
//
// Produit :
//   trees/<id>/tree.enc
//   trees/<id>/media/<photo>.jpg.enc
//
// Usage :
//   node tools/build.mjs <fichier.ged> --tree <id> [dossier_photos]
//   Mot de passe via passwd, GEN_PASSWORD, sinon demandé au clavier.
//
// Les photos en clair (trees/*/media/*.jpg…) ne doivent PAS être publiées :
// elles sont ignorées par .gitignore ; seules les .enc le sont.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadPassword } from './passwd.mjs';

const ITERATIONS = 200000;
const HASH = 'SHA-256';
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function askPassword() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.error(
        "\n⚠  Terminal non interactif : impossible de demander le mot de passe au clavier.\n" +
        "   Passe-le par passwd, GEN_PASSWORD, etc.\n"
      );
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(' Mot de passe : ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function encrypt(buffer, key, salt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const ct = Buffer.concat([enc, cipher.getAuthTag()]);
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: HASH, iterations: ITERATIONS, salt: salt.toString('base64') },
    cipher: 'AES-GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function parseArgs(argv) {
  const args = [...argv];
  let treeId = 'principal';
  let mediaDir = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tree' && args[i + 1]) { treeId = args[++i]; continue; }
    if (args[i] === '--media' && args[i + 1]) { mediaDir = args[++i]; continue; }
    rest.push(args[i]);
  }
  const gedPath = rest[0];
  if (!mediaDir) mediaDir = `trees/${treeId}/media`;
  return { gedPath, treeId, mediaDir };
}

async function main() {
  const { gedPath, treeId, mediaDir } = parseArgs(process.argv.slice(2));
  if (!gedPath) {
    console.error('Usage : node tools/build.mjs <fichier.ged> --tree <id> [dossier_photos]');
    process.exit(1);
  }

  const password = loadPassword() || (await askPassword());
  if (!password) {
    console.error('Mot de passe vide, abandon.');
    process.exit(1);
  }

  const outDir = `trees/${treeId}`;
  const outEnc = join(outDir, 'tree.enc');
  mkdirSync(mediaDir, { recursive: true });

  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');

  const ged = readFileSync(gedPath);
  writeFileSync(outEnc, JSON.stringify(encrypt(ged, key, salt)));
  console.log(`✓ GEDCOM chiffré -> ${outEnc}`);

  let count = 0;
  let files = [];
  try { files = readdirSync(mediaDir); } catch { /* dossier absent */ }
  for (const name of files) {
    if (!IMG_EXT.has(extname(name).toLowerCase())) continue;
    const buf = readFileSync(join(mediaDir, name));
    writeFileSync(join(mediaDir, name + '.enc'), JSON.stringify(encrypt(buf, key, salt)));
    count++;
  }
  console.log(`✓ ${count} photo(s) chiffrée(s) -> ${mediaDir}/*.enc`);
  console.log('\nRappel : ne publiez PAS les images en clair (déjà ignorées par .gitignore).');
}

main().catch((e) => { console.error(e); process.exit(1); });

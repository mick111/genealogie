#!/usr/bin/env node
// build.mjs — chiffre le GEDCOM ET les photos avec une même clé (même sel),
// pour publication sur GitHub Pages.
//
// Produit :
//   data/tree.enc                 (le GEDCOM chiffré)
//   data/media/<photo>.jpg.enc    (chaque image de data/media/ chiffrée)
//
// Usage :
//   node tools/build.mjs <fichier.ged> [dossier_photos]
//   Mot de passe via GEN_PASSWORD, sinon demandé au clavier.
//
// Les photos en clair (data/media/*.jpg…) ne doivent PAS être publiées :
// elles sont ignorées par .gitignore ; seules les .enc le sont.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadPassword } from './passwd.mjs';

const ITERATIONS = 200000;
const HASH = 'SHA-256';
const MEDIA_DIR = 'data/media';
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function askPassword() {
  return new Promise((resolve) => {
    // Terminal non interactif (ex. sortie redirigée) : pas de saisie possible.
    if (!process.stdin.isTTY) {
      console.error(
        "\n⚠  Terminal non interactif : impossible de demander le mot de passe au clavier.\n" +
        "   Passe-le par la variable GEN_PASSWORD, par ex. :\n" +
        "   GEN_PASSWORD='tonMotDePasse' node tools/build.mjs <fichier.ged>\n"
      );
      process.exit(1);
    }
    // rl.question écrit ET vide (flush) le prompt correctement.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(' Mot de passe : ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Chiffre un Buffer avec une clé + sel donnés. Renvoie un conteneur JSON.
function encrypt(buffer, key, salt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const ct = Buffer.concat([enc, cipher.getAuthTag()]); // ct || authTag
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: HASH, iterations: ITERATIONS, salt: salt.toString('base64') },
    cipher: 'AES-GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
  };
}

async function main() {
  const [, , gedPath, mediaDir = MEDIA_DIR] = process.argv;
  if (!gedPath) {
    console.error('Usage : node tools/build.mjs <fichier.ged> [dossier_photos]');
    process.exit(1);
  }

  const password = loadPassword() || (await askPassword());
  if (!password) {
    console.error('Mot de passe vide, abandon.');
    process.exit(1);
  }

  // Un sel unique -> une seule clé pour tout (le navigateur ne dérive qu'une fois).
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');

  // 1) GEDCOM
  const ged = readFileSync(gedPath);
  writeFileSync('data/tree.enc', JSON.stringify(encrypt(ged, key, salt)));
  console.log(`✓ GEDCOM chiffré -> data/tree.enc`);

  // 2) Photos (les fichiers image non déjà chiffrés du dossier).
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

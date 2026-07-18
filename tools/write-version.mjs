#!/usr/bin/env node
// Écrit version.json (hash git court) pour affichage en bas de page.
// Usage : node tools/write-version.mjs

import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function gitShortHead() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const commit = gitShortHead();
writeFileSync('version.json', JSON.stringify({ commit }, null, 2) + '\n');
console.log('OK : version.json →', commit);

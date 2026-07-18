#!/usr/bin/env node
// Fusionne un GEDCOM importé dans l'arbre principal en reliant les personnes en commun.
//
// Usage :
//   node tools/merge-gedcom.mjs --tree principal --import imports/filae.ged [--out merged.ged]

import { readFileSync, writeFileSync } from 'node:fs';
import { decryptTextContainer } from '../js/crypto.js';
import { parseGedcom, serializeGedcom, yearOf } from '../js/gedcom.js';
import { loadPassword } from './passwd.mjs';

const SEEDS = {
  '@I9404081@': '@I360@', // Jean-Michel Mouchous
  '@I9404082@': '@I359@', // René Mouchous
  '@I9404083@': '@I30@',  // Françoise Mena → Jeanne Françoise Ména
  '@I9404086@': '@I1@',   // Palmino Domenico Mena
  '@I9404087@': '@I22@',  // Giovanina Marchetti → Giovanna Angela Marchetti
  '@I9404088@': '@I423@', // Stéphanie
  '@I9404089@': '@I427@', // Michael → Michaël
  '@I9404090@': '@I422@', // Fabienne Sottana
  '@I9404094@': '@I362@', // Jean-Jacques
  '@I9404095@': '@I361@', // Laurence
  '@I9404109@': '@I450@', // Grégory
  '@I422742384@': '@I424@', // Guillaume Justice
  '@I422742415@': '@I425@', // Théo Justice
  '@I422742469@': '@I426@', // Thomas Justice
};

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function givenTokens(given) {
  return norm(given).split(/\s+/).filter((t) => t.length >= 2);
}

function namesCompatible(a, b) {
  const ga = givenTokens(a.given);
  const gb = givenTokens(b.given);
  if (!ga.length || !gb.length) return norm(a.given) === norm(b.given);
  return ga.some((t) => gb.includes(t)) || gb.some((t) => ga.includes(t));
}

function surnamesCompatible(a, b) {
  const sa = norm(a.surname);
  const sb = norm(b.surname);
  if (!sa || !sb) return false;
  return sa === sb || sa.includes(sb) || sb.includes(sa);
}

function autoMatch(imported, baseIndividuals) {
  if (!imported.surname || !imported.given) return null;
  const iy = yearOf(imported.birth?.date || '');
  const cands = [];
  for (const base of baseIndividuals.values()) {
    if (!base.surname || !base.given) continue;
    if (imported.sex && base.sex && imported.sex !== base.sex) continue;
    if (!surnamesCompatible(imported, base)) continue;
    const by = yearOf(base.birth?.date || '');
    if (iy && by && iy !== by) continue;
    if (!namesCompatible(imported, base)) continue;
    cands.push(base);
  }
  if (cands.length === 1) return cands[0].id;
  return null;
}

function nextIndiId(individuals) {
  let max = 0;
  for (const id of individuals.keys()) {
    const m = /^@I(\d+)@$/.exec(id);
    if (m) max = Math.max(max, +m[1]);
  }
  return '@I' + (max + 1) + '@';
}

function nextFamId(families) {
  let max = 0;
  for (const id of families.keys()) {
    const m = /^@F(\d+)@$/.exec(id);
    if (m) max = Math.max(max, +m[1]);
  }
  return '@F' + (max + 1) + '@';
}

function mergeEvent(base, incoming) {
  if (!incoming) return base || null;
  if (!base) return incoming;
  return {
    date: base.date || incoming.date || '',
    place: base.place || incoming.place || '',
  };
}

function mergePerson(base, incoming) {
  if (incoming.given && (!base.given || base.given.length < incoming.given.length)) {
    base.given = incoming.given;
  }
  if (incoming.surname && !base.surname) base.surname = incoming.surname;
  base.name = [base.given, base.surname].filter(Boolean).join(' ') || base.name;
  base.birth = mergeEvent(base.birth, incoming.birth);
  base.death = mergeEvent(base.death, incoming.death);
  if (!base.sex && incoming.sex) base.sex = incoming.sex;
}

function remapId(id, idMap) {
  if (!id) return null;
  return idMap.get(id) || id;
}

function spousesMatch(f, husb, wife) {
  return f.husb === husb && f.wife === wife;
}

function findFamilyBySpouses(families, husb, wife) {
  return [...families.values()].find((f) => spousesMatch(f, husb, wife)) || null;
}

function findIncompleteFamily(families, husb, wife, chil) {
  for (const f of families.values()) {
    const childOverlap = chil.some((c) => f.chil.includes(c));
    if (!childOverlap) continue;
    if (wife && f.wife === wife && (!f.husb || f.husb === husb)) {
      if (!husb || f.husb === husb || !f.husb) return f;
    }
    if (husb && f.husb === husb && (!f.wife || f.wife === wife)) {
      if (!wife || f.wife === wife || !f.wife) return f;
    }
  }
  return null;
}

function dedupePersonFamilies(personId, individuals, families) {
  const person = individuals.get(personId);
  if (!person) return;
  const bySpouses = new Map();
  for (const fid of [...person.fams]) {
    const f = families.get(fid);
    if (!f) { person.fams = person.fams.filter((x) => x !== fid); continue; }
    const key = [f.husb || '', f.wife || ''].sort().join('|');
    const prev = bySpouses.get(key);
    if (!prev) { bySpouses.set(key, fid); continue; }
    const keep = families.get(prev);
    for (const cid of f.chil) if (!keep.chil.includes(cid)) keep.chil.push(cid);
    if (!keep.marr?.date && f.marr?.date) keep.marr = f.marr;
    if (!keep.husb && f.husb) keep.husb = f.husb;
    if (!keep.wife && f.wife) keep.wife = f.wife;
    for (const cid of f.chil) {
      const child = individuals.get(cid);
      if (child) child.famc = child.famc.map((x) => (x === fid ? prev : x)).filter((x, i, a) => a.indexOf(x) === i);
    }
    person.fams = person.fams.filter((x) => x !== fid);
    families.delete(fid);
  }
}

function childSetEqual(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function linkChildToFamily(childId, famId, individuals, families) {
  const child = individuals.get(childId);
  const fam = families.get(famId);
  if (!child || !fam) return;
  if (!child.famc.includes(famId)) child.famc.push(famId);
  if (!fam.chil.includes(childId)) fam.chil.push(childId);
}

function linkSpouseToFamily(personId, famId, individuals, families) {
  const person = individuals.get(personId);
  const fam = families.get(famId);
  if (!person || !fam) return;
  if (!person.fams.includes(famId)) person.fams.push(famId);
}

function applyFamily(famData, individuals, families) {
  const { husb, wife, chil, marr, div } = famData;
  if (!husb && !wife && !chil.length) return;

  let fam = findFamilyBySpouses(families, husb, wife);
  if (!fam) fam = findIncompleteFamily(families, husb, wife, chil);
  if (!fam) {
    const fid = nextFamId(families);
    fam = { id: fid, husb: husb || null, wife: wife || null, chil: [], marr: marr || null, div: div || null };
    families.set(fid, fam);
  } else {
    if (!fam.husb && husb) fam.husb = husb;
    if (!fam.wife && wife) fam.wife = wife;
    if (!fam.marr?.date && marr?.date) fam.marr = marr;
    if (!fam.marr?.place && marr?.place) fam.marr = { ...(fam.marr || {}), place: marr.place };
    if (!fam.div && div) fam.div = div;
  }

  if (fam.husb) linkSpouseToFamily(fam.husb, fam.id, individuals, families);
  if (fam.wife) linkSpouseToFamily(fam.wife, fam.id, individuals, families);
  for (const cid of chil) {
    if (!fam.chil.includes(cid)) fam.chil.push(cid);
    linkChildToFamily(cid, fam.id, individuals, families);
  }
  if (fam.husb) dedupePersonFamilies(fam.husb, individuals, families);
  if (fam.wife) dedupePersonFamilies(fam.wife, individuals, families);
}

function parseArgs(argv) {
  let treeId = 'principal';
  let importPath = null;
  let outPath = 'merged.ged';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tree' && argv[i + 1]) { treeId = argv[++i]; continue; }
    if (argv[i] === '--import' && argv[i + 1]) { importPath = argv[++i]; continue; }
    if (argv[i] === '--out' && argv[i + 1]) { outPath = argv[++i]; continue; }
  }
  return { treeId, importPath, outPath };
}

async function loadBaseGedcom(treeId, password) {
  const encPath = `trees/${treeId}/tree.enc`;
  const container = JSON.parse(readFileSync(encPath, 'utf8'));
  if (container.v === 2 && container.type === 'tree') {
    throw new Error('Arbre v2 MK : exportez d’abord en GEDCOM ou utilisez --base fichier.ged');
  }
  const { text } = await decryptTextContainer(container, password);
  return text;
}

async function main() {
  const { treeId, importPath, outPath } = parseArgs(process.argv.slice(2));
  if (!importPath) {
    console.error('Usage : node tools/merge-gedcom.mjs --tree principal --import fichier.ged [--out merged.ged]');
    process.exit(1);
  }

  const password = loadPassword();
  if (!password) {
    console.error('Mot de passe requis (passwd ou GEN_PASSWORD).');
    process.exit(1);
  }

  const baseText = await loadBaseGedcom(treeId, password);
  const base = parseGedcom(baseText);
  const incoming = parseGedcom(readFileSync(importPath, 'utf8'));

  const individuals = new Map(base.individuals);
  const families = new Map(base.families);
  const idMap = new Map(Object.entries(SEEDS));

  let matched = 0;
  let added = 0;

  for (const [srcId, person] of incoming.individuals) {
    let targetId = idMap.get(srcId);
    if (!targetId) targetId = autoMatch(person, individuals);
    if (targetId && individuals.has(targetId)) {
      idMap.set(srcId, targetId);
      mergePerson(individuals.get(targetId), person);
      matched++;
      continue;
    }
    const newId = nextIndiId(individuals);
    idMap.set(srcId, newId);
    individuals.set(newId, {
      ...structuredClone(person),
      id: newId,
      famc: [],
      fams: [],
    });
    added++;
  }

  for (const fam of incoming.families.values()) {
    applyFamily({
      husb: remapId(fam.husb, idMap),
      wife: remapId(fam.wife, idMap),
      chil: fam.chil.map((c) => remapId(c, idMap)).filter(Boolean),
      marr: fam.marr,
      div: fam.div,
    }, individuals, families);
  }

  const outText = serializeGedcom(individuals, families);
  writeFileSync(outPath, outText + '\n');

  console.log(`✓ Fusion terminée → ${outPath}`);
  console.log(`  Base : ${base.individuals.size} individus → ${individuals.size} (+${added} nouveaux)`);
  console.log(`  Reliés à l'existant : ${matched} / ${incoming.individuals.size} (Filae)`);
  console.log(`  Familles : ${base.families.size} → ${families.size}`);

  const rene = individuals.get('@I359@');
  if (rene?.famc.length) {
    const pf = families.get(rene.famc[0]);
    const ph = pf?.husb ? individuals.get(pf.husb)?.name : '?';
    const pw = pf?.wife ? individuals.get(pf.wife)?.name : '?';
    console.log(`  René Mouchous → parents : ${ph} + ${pw}`);
  }

  const jm = individuals.get('@I360@');
  if (jm) {
    console.log(`  Jean-Michel → né ${jm.birth?.date || '?'} | conjoint ${jm.fams.map((f) => {
      const fam = families.get(f);
      const sp = fam?.wife === jm.id ? fam?.husb : fam?.wife;
      return individuals.get(sp)?.name;
    }).filter(Boolean).join(', ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Corrections manuelles après fusion GEDCOM.
// Usage : node tools/apply-fixes.mjs [--in merged.ged] [--out merged.ged]

import { readFileSync, writeFileSync } from 'node:fs';
import { parseGedcom, serializeGedcom } from '../js/gedcom.js';

function parseArgs(argv) {
  let inPath = 'merged.ged';
  let outPath = 'merged.ged';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in' && argv[i + 1]) inPath = argv[++i];
    if (argv[i] === '--out' && argv[i + 1]) outPath = argv[++i];
  }
  return { inPath, outPath };
}

function nextIndiId(individuals) {
  let max = 0;
  for (const id of individuals.keys()) {
    const m = /^@I(\d+)@$/.exec(id);
    if (m) max = Math.max(max, +m[1]);
  }
  return '@I' + (max + 1) + '@';
}

function mergePersonId(keepId, dropId, individuals, families) {
  const keep = individuals.get(keepId);
  const drop = individuals.get(dropId);
  if (!keep || !drop) return;
  keep.famc = [...new Set([...keep.famc, ...drop.famc])];
  keep.fams = [...new Set([...keep.fams, ...drop.fams])];
  for (const fam of families.values()) {
    if (fam.husb === dropId) fam.husb = keepId;
    if (fam.wife === dropId) fam.wife = keepId;
    fam.chil = fam.chil.map((c) => (c === dropId ? keepId : c));
  }
  individuals.delete(dropId);
}

function reassignId(oldId, newId, individuals, families) {
  mergePersonId(newId, oldId, individuals, families);
}

function deletePerson(id, individuals, families) {
  individuals.delete(id);
  for (const [fid, fam] of [...families.entries()]) {
    if (fam.husb === id) fam.husb = null;
    if (fam.wife === id) fam.wife = null;
    fam.chil = fam.chil.filter((c) => c !== id);
    if (!fam.husb && !fam.wife && !fam.chil.length) families.delete(fid);
  }
  for (const p of individuals.values()) {
    p.famc = p.famc.filter((f) => families.has(f));
    p.fams = p.fams.filter((f) => families.has(f));
  }
}

function deleteFamily(fid, individuals, families) {
  const fam = families.get(fid);
  if (!fam) return;
  for (const pid of [fam.husb, fam.wife, ...fam.chil]) {
    const p = individuals.get(pid);
    if (!p) continue;
    p.famc = p.famc.filter((f) => f !== fid);
    p.fams = p.fams.filter((f) => f !== fid);
  }
  families.delete(fid);
}

function findByName(individuals, pattern) {
  const re = new RegExp(pattern, 'i');
  return [...individuals.values()].filter((p) => re.test(p.name));
}

function main() {
  const { inPath, outPath } = parseArgs(process.argv.slice(2));
  const { individuals, families } = parseGedcom(readFileSync(inPath, 'utf8'));

  // 1. Fabienne — naissance 1963 (Filae)
  const fabienne = individuals.get('@I422@');
  if (fabienne) {
    fabienne.birth = { date: '29 MAY 1963', place: fabienne.birth?.place || 'Tarbes' };
    fabienne.name = [fabienne.given, fabienne.surname].filter(Boolean).join(' ');
  }

  // 2. René — décès Vic-en-Bigorre, 27 oct 2018
  const rene = individuals.get('@I359@');
  if (rene) {
    rene.death = {
      date: '27 OCT 2018',
      place: 'Vic-en-Bigorre, Hautes-Pyrénées, Occitanie, France',
    };
  }

  // 3. Florian Sottana → 1996
  const florian = findByName(individuals, 'Florian Sottana')[0];
  if (florian) florian.birth = { date: '16 FEB 1996', place: florian.birth?.place || 'Lille' };

  // 4. Marina — conjointe de Grégory (Liam, Mila) ; ne pas confondre avec Marina Garbin (@I282@)
  const gregory = individuals.get('@I450@');
  const f156 = families.get('@F156@');
  const marinaGarbin = individuals.get('@I282@');
  if (marinaGarbin) {
    marinaGarbin.fams = marinaGarbin.fams.filter((f) => f !== '@F156@');
  }
  if (gregory && f156) {
    let marina = [...individuals.values()].find(
      (p) => p.id !== '@I282@' && p.given === 'Marina' && !p.surname && p.fams.includes('@F156@'),
    );
    if (!marina) {
      const mid = nextIndiId(individuals);
      marina = {
        id: mid, name: 'Marina', given: 'Marina', surname: '', sex: 'F',
        birth: null, death: null, famc: [], fams: [], media: [],
      };
      individuals.set(mid, marina);
    }
    f156.wife = marina.id;
    if (!marina.fams.includes('@F156@')) marina.fams.push('@F156@');
    if (!gregory.fams.includes('@F156@')) gregory.fams.push('@F156@');
  }

  // 5. Michaël — naissance conservée ; baptême erroné non stocké dans le modèle
  const michael = individuals.get('@I427@');
  if (michael && !michael.birth?.date) {
    michael.birth = { date: '1 NOV 1988', place: 'Tarbes' };
    michael.given = 'Michaël';
    michael.name = 'Michaël Mouchous';
  }

  // 6. Guiseppe Bordignon → sexe M
  const giuseppe = findByName(individuals, 'Guiseppe Bordignon|Giuseppe Bordignon')[0]
    || individuals.get('@I88888925@');
  if (giuseppe) giuseppe.sex = 'M';

  // 7. Michele COURT → Michèle (femme)
  const michele = findByName(individuals, 'Michele COURT|Michèle COURT')[0]
    || individuals.get('@I88888941@');
  if (michele) {
    michele.given = 'Michèle';
    michele.surname = 'Court';
    michele.sex = 'F';
    michele.name = 'Michèle Court';
  }

  // 8. Léa Dupuy — retirer la date de naissance
  const lea = individuals.get('@I536@');
  if (lea?.birth) lea.birth = lea.birth.place ? { date: '', place: lea.birth.place } : null;

  // 9. Fusionner Gilbert Saint Jean @I470@ → @I377@
  if (individuals.has('@I470@') && individuals.has('@I377@')) {
    reassignId('@I470@', '@I377@', individuals, families);
  }

  // 10. George Mouchous — supprimer conjointe Xxxxx et union
  for (const p of [...individuals.values()]) {
    if (/^xxxxx$/i.test((p.given || p.name || '').trim())) {
      for (const fid of [...p.fams]) deleteFamily(fid, individuals, families);
      deletePerson(p.id, individuals, families);
    }
  }
  for (const [fid, fam] of [...families.entries()]) {
    const w = fam.wife ? individuals.get(fam.wife) : null;
    const h = fam.husb ? individuals.get(fam.husb) : null;
    if ((w && /^xxxxx$/i.test((w.given || w.name || '').trim()))
      || (h && /^xxxxx$/i.test((h.given || h.name || '').trim()))) {
      deleteFamily(fid, individuals, families);
    }
  }

  // 11. Joseph Court / Madeleine Dulau — retirer le lien mariage
  const joseph = findByName(individuals, 'Joseph Court')[0];
  const madeleine = findByName(individuals, 'Madeleine Dulau')[0];
  if (joseph && madeleine) {
    for (const fid of [...joseph.fams]) {
      const fam = families.get(fid);
      if (fam?.wife === madeleine.id) {
        fam.wife = null;
        madeleine.fams = madeleine.fams.filter((f) => f !== fid);
        if (!fam.husb && !fam.chil.length) deleteFamily(fid, individuals, families);
      }
    }
  }

  // Nettoyage : famille vide Liam @F157@
  deleteFamily('@F157@', individuals, families);

  writeFileSync(outPath, serializeGedcom(individuals, families) + '\n');
  console.log(`✓ Corrections appliquées → ${outPath}`);
  console.log(`  ${individuals.size} individus, ${families.size} familles`);
  if (f156?.wife) console.log('  Marina →', individuals.get(f156.wife)?.name, '(', f156.wife, ')');
}

main();

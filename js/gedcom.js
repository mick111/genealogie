// gedcom.js — parseur GEDCOM minimal (vanilla, sans dépendance).
// Gère le sous-ensemble utile : INDI, FAM, NAME, SEX, BIRT, DEAT, MARR,
// DATE, PLAC, FAMC, FAMS, OBJE/FILE. Exposé en ES module.

const LINE_RE = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_]+)(?:\s(.*))?$/;

// Parse le texte GEDCOM brut en une arborescence de nœuds.
function parseTree(text) {
  const root = { level: -1, children: [] };
  const stack = [root];
  const lines = text.split(/\r\n|\r|\n/);

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const level = parseInt(m[1], 10);
    const node = {
      level,
      xref: m[2] || null,
      tag: m[3],
      value: m[4] != null ? m[4] : '',
      children: [],
    };

    // CONC/CONT : concatène dans la valeur du parent.
    if (node.tag === 'CONC' || node.tag === 'CONT') {
      const parent = stack[stack.length - 1];
      const target = parent.level >= 0 ? parent : null;
      if (target) {
        target.value += (node.tag === 'CONT' ? '\n' : '') + node.value;
        continue;
      }
    }

    // Remonte la pile jusqu'au bon parent.
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] || root;
    parent.children.push(node);
    stack.push(node);
  }
  return root;
}

function child(node, tag) {
  return node.children.find((c) => c.tag === tag) || null;
}
function children(node, tag) {
  return node.children.filter((c) => c.tag === tag);
}

// Nom : "Given /Surname/ suffix" -> { full, given, surname }
function parseName(value) {
  if (!value) return { full: '', given: '', surname: '' };
  const m = /^([^/]*)\/([^/]*)\/(.*)$/.exec(value);
  if (m) {
    const given = m[1].trim();
    const surname = m[2].trim();
    const suffix = m[3].trim();
    const full = [given, surname, suffix].filter(Boolean).join(' ').trim();
    return { full, given, surname };
  }
  return { full: value.trim(), given: value.trim(), surname: '' };
}

// Extrait un événement (BIRT/DEAT/MARR...) -> { date, place }
function parseEvent(node) {
  if (!node) return null;
  const d = child(node, 'DATE');
  const p = child(node, 'PLAC');
  const ev = {
    date: d ? d.value.trim() : '',
    place: p ? p.value.trim() : '',
  };
  if (!ev.date && !ev.place) return null;
  return ev;
}

// Récupère les fichiers média rattachés à un individu (inline OBJE ou pointeur).
function collectMedia(node, objects) {
  const files = [];
  for (const obje of children(node, 'OBJE')) {
    if (obje.value && obje.value.startsWith('@')) {
      const rec = objects.get(obje.value);
      if (rec && rec.file) files.push(rec);
    } else {
      const f = child(obje, 'FILE');
      const t = child(obje, 'TITL');
      if (f && f.value) files.push({ file: f.value.trim(), title: t ? t.value.trim() : '' });
    }
  }
  return files;
}

// API principale : renvoie { individuals: Map, families: Map }
export function parseGedcom(text) {
  const root = parseTree(text);

  // 1er passage : objets média (records OBJE de niveau 0).
  const objects = new Map();
  for (const rec of root.children) {
    if (rec.tag === 'OBJE' && rec.xref) {
      const f = child(rec, 'FILE');
      const t = child(rec, 'TITL');
      objects.set(rec.xref, {
        file: f ? f.value.trim() : '',
        title: t ? t.value.trim() : '',
      });
    }
  }

  const individuals = new Map();
  const families = new Map();

  for (const rec of root.children) {
    if (rec.tag === 'INDI' && rec.xref) {
      const nameNode = child(rec, 'NAME');
      const name = parseName(nameNode ? nameNode.value : '');
      const sex = child(rec, 'SEX');
      individuals.set(rec.xref, {
        id: rec.xref,
        name: name.full || '(sans nom)',
        given: name.given,
        surname: name.surname,
        sex: sex ? sex.value.trim().toUpperCase() : '',
        birth: parseEvent(child(rec, 'BIRT')),
        death: parseEvent(child(rec, 'DEAT')),
        famc: children(rec, 'FAMC').map((c) => c.value.trim()), // familles où enfant
        fams: children(rec, 'FAMS').map((c) => c.value.trim()), // familles où époux
        media: collectMedia(rec, objects),
      });
    } else if (rec.tag === 'FAM' && rec.xref) {
      const husb = child(rec, 'HUSB');
      const wife = child(rec, 'WIFE');
      families.set(rec.xref, {
        id: rec.xref,
        husb: husb ? husb.value.trim() : null,
        wife: wife ? wife.value.trim() : null,
        chil: children(rec, 'CHIL').map((c) => c.value.trim()),
        marr: parseEvent(child(rec, 'MARR')),
        div: parseEvent(child(rec, 'DIV')),
      });
    }
  }

  return { individuals, families };
}

// Formate une date GEDCOM pour affichage (léger, garde le brut si inconnu).
const MONTHS = {
  JAN: 'janv.', FEB: 'févr.', MAR: 'mars', APR: 'avr.', MAY: 'mai', JUN: 'juin',
  JUL: 'juil.', AUG: 'août', SEP: 'sept.', OCT: 'oct.', NOV: 'nov.', DEC: 'déc.',
};
const QUALIFIERS = { ABT: 'vers', EST: 'vers', CAL: 'vers', BEF: 'avant', AFT: 'après' };

export function formatDate(gedDate) {
  if (!gedDate) return '';
  let s = gedDate.trim();
  let prefix = '';
  const q = /^(ABT|EST|CAL|BEF|AFT)\s+/i.exec(s);
  if (q) {
    prefix = QUALIFIERS[q[1].toUpperCase()] + ' ';
    s = s.slice(q[0].length);
  }
  return prefix + s.replace(/\b([A-Z]{3})\b/g, (mm, mon) => MONTHS[mon] || mon);
}

// Sérialise les Maps individuals/families en texte GEDCOM (pour ré-export).
export function serializeGedcom(individuals, families) {
  const L = ['0 HEAD', '1 SOUR genealogie-web', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8'];
  const ev = (tag, e) => {
    if (!e) return;
    L.push('1 ' + tag);
    if (e.date) L.push('2 DATE ' + e.date);
    if (e.place) L.push('2 PLAC ' + e.place);
  };
  for (const p of individuals.values()) {
    L.push(`0 ${p.id} INDI`);
    L.push(`1 NAME ${p.given || ''} /${p.surname || ''}/`);
    if (p.sex) L.push('1 SEX ' + p.sex);
    ev('BIRT', p.birth);
    ev('DEAT', p.death);
    for (const f of p.famc) L.push('1 FAMC ' + f);
    for (const f of p.fams) L.push('1 FAMS ' + f);
    for (const m of p.media || []) { L.push('1 OBJE'); if (m.file) L.push('2 FILE ' + m.file); if (m.title) L.push('2 TITL ' + m.title); }
  }
  for (const fam of families.values()) {
    L.push(`0 ${fam.id} FAM`);
    if (fam.husb) L.push('1 HUSB ' + fam.husb);
    if (fam.wife) L.push('1 WIFE ' + fam.wife);
    for (const c of fam.chil) L.push('1 CHIL ' + c);
    ev('MARR', fam.marr);
    ev('DIV', fam.div);
  }
  L.push('0 TRLR');
  return L.join('\n');
}

// Année extraite d'une date GEDCOM (pour tri / affichage compact).
export function yearOf(gedDate) {
  if (!gedDate) return '';
  const m = /(\d{3,4})/.exec(gedDate);
  return m ? m[1] : '';
}

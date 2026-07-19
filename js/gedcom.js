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

function nameType(node) {
  const t = child(node, 'TYPE');
  return t ? t.value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function isMarriedType(type) {
  return type === 'married' || type === 'marriage' || type === 'married name';
}

function isBirthType(type) {
  return type === 'birth' || type === 'maiden';
}

function parseMarnmValue(value) {
  const parsed = parseName(value);
  return (parsed.surname || parsed.full || value || '').trim();
}

// Extrait prénom, nom de naissance et nom marital d'un enregistrement INDI.
function parseNameNode(nn) {
  const fromValue = parseName(nn.value);
  const givn = child(nn, 'GIVN');
  const surn = child(nn, 'SURN');
  const marnm = child(nn, '_MARNM');
  return {
    given: givn ? givn.value.trim() : fromValue.given,
    surname: surn ? surn.value.trim() : fromValue.surname,
    marriedFromMarnm: marnm ? parseMarnmValue(marnm.value) : '',
  };
}

function parseNamesFromIndi(rec) {
  let given = '', surname = '', marriedSurname = '';

  for (const m of children(rec, '_MARNM')) {
    marriedSurname = marriedSurname || parseMarnmValue(m.value);
  }

  for (const nn of children(rec, 'NAME')) {
    const type = nameType(nn);
    const parsed = parseNameNode(nn);

    if (parsed.marriedFromMarnm) {
      marriedSurname = marriedSurname || parsed.marriedFromMarnm;
      if (parsed.surname) surname = surname || parsed.surname;
      if (parsed.given) given = given || parsed.given;
      continue;
    }
    if (isMarriedType(type)) {
      marriedSurname = marriedSurname || parsed.surname || parsed.given;
      if (parsed.given) given = given || parsed.given;
      continue;
    }
    if (isBirthType(type)) {
      if (parsed.surname) surname = parsed.surname;
      if (parsed.given) given = given || parsed.given;
      continue;
    }
    if (!given && !surname) {
      given = parsed.given;
      surname = parsed.surname;
    } else if (parsed.surname && parsed.surname !== surname && !marriedSurname) {
      marriedSurname = parsed.surname;
      if (parsed.given) given = given || parsed.given;
    } else {
      if (!given) given = parsed.given;
      if (!surname) surname = parsed.surname;
    }
  }

  if (marriedSurname && marriedSurname === surname) marriedSurname = '';
  return { given, surname, marriedSurname };
}

// Nom d'affichage : « Prénom NomMarital (née NomNaissance) » si les deux noms existent.
// Le « né/née/né·e » s'accorde selon le sexe.
export function buildPersonName({ given = '', surname = '', marriedSurname = '', sex = '' } = {}) {
  const g = String(given || '').trim();
  const s = String(surname || '').trim();
  const m = String(marriedSurname || '').trim();
  if (!g && !s && !m) return '(sans nom)';
  if (m && m !== s) {
    const born = sex === 'M' ? 'né' : sex === 'F' ? 'née' : 'né·e';
    if (s) return [g, m, `(${born} ${s})`].filter(Boolean).join(' ');
    return [g, m].filter(Boolean).join(' ');
  }
  return [g, s].filter(Boolean).join(' ');
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

// GEDCOM peut répéter BIRT/DEAT (ex. Filae : 1re balise vide, 2e avec DATE).
function parseBestEvent(nodes) {
  if (!nodes.length) return null;
  for (const node of nodes) {
    const ev = parseEvent(node);
    if (ev?.date) return ev;
  }
  for (const node of nodes) {
    const ev = parseEvent(node);
    if (ev) return ev;
  }
  return null;
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
      const names = parseNamesFromIndi(rec);
      const sex = child(rec, 'SEX');
      const sexVal = sex ? sex.value.trim().toUpperCase() : '';
      individuals.set(rec.xref, {
        id: rec.xref,
        name: buildPersonName({ ...names, sex: sexVal }),
        given: names.given,
        surname: names.surname,
        marriedSurname: names.marriedSurname,
        sex: sexVal,
        birth: parseBestEvent(children(rec, 'BIRT')),
        death: parseBestEvent(children(rec, 'DEAT')),
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
        marr: parseBestEvent(children(rec, 'MARR')),
        div: parseBestEvent(children(rec, 'DIV')),
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
const MONTH_NUM = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};
const NUM_MONTH = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
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

// Convertit une date GEDCOM (ex. « 12 MAR 1980 ») vers YYYY-MM-DD pour <input type="date">.
export function gedcomToInputDate(gedDate) {
  if (!gedDate) return '';
  let s = gedDate.trim().replace(/^(ABT|EST|CAL|BEF|AFT)\s+/i, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{3,4})$/.exec(s);
  if (dmy) {
    const mon = MONTH_NUM[dmy[2].toUpperCase()];
    if (mon) return `${dmy[3]}-${mon}-${dmy[1].padStart(2, '0')}`;
  }
  return '';
}

// Convertit YYYY-MM-DD (calendrier) vers une date GEDCOM standard.
export function inputDateToGedcom(isoDate) {
  if (!isoDate) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return isoDate.trim();
  const day = String(parseInt(m[3], 10));
  const mon = NUM_MONTH[parseInt(m[2], 10) - 1];
  return mon ? `${day} ${mon} ${m[1]}` : isoDate.trim();
}

// Décompose une date GEDCOM en parties éditables (jour, mois, année, qualificateur).
export function parseGedcomDateParts(gedDate) {
  const empty = { qualifier: '', day: '', month: '', year: '', unparsed: '' };
  if (!gedDate) return empty;
  let s = gedDate.trim();
  let qualifier = '';
  const q = /^(ABT|EST|CAL|BEF|AFT)\s+/i.exec(s);
  if (q) {
    qualifier = q[1].toUpperCase();
    s = s.slice(q[0].length).trim();
  }
  let m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{3,4})$/.exec(s);
  if (m) {
    return { qualifier, day: String(parseInt(m[1], 10)), month: MONTH_NUM[m[2].toUpperCase()] || '', year: m[3], unparsed: '' };
  }
  m = /^([A-Za-z]{3})\s+(\d{3,4})$/.exec(s);
  if (m) {
    return { qualifier, day: '', month: MONTH_NUM[m[1].toUpperCase()] || '', year: m[2], unparsed: '' };
  }
  if (/^\d{3,4}$/.test(s)) return { qualifier, day: '', month: '', year: s, unparsed: '' };
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    return { qualifier, day: String(parseInt(m[3], 10)), month: m[2], year: m[1], unparsed: '' };
  }
  return { qualifier, day: '', month: '', year: '', unparsed: gedDate.trim() };
}

// Recompose une date GEDCOM à partir des champs du formulaire.
export function partsToGedcom({ qualifier = '', day = '', month = '', year = '' }) {
  const q = qualifier ? qualifier + ' ' : '';
  const y = String(year ?? '').trim();
  const mo = String(month ?? '').trim();
  const d = String(day ?? '').trim();
  const mon = mo ? NUM_MONTH[parseInt(mo, 10) - 1] : '';
  if (d && mon && y) return `${q}${parseInt(d, 10)} ${mon} ${y}`.trim();
  if (mon && y) return `${q}${mon} ${y}`.trim();
  if (y) return `${q}${y}`.trim();
  return '';
}

// Fusionne la saisie formulaire et l'original (préserve qualificateur et dates non parsées).
export function mergeDatePartsFormValue(day, month, year, originalGed) {
  const orig = parseGedcomDateParts(originalGed);
  const built = partsToGedcom({ qualifier: orig.qualifier, day, month, year });
  if (built) return built;
  if (!String(day ?? '').trim() && !String(month ?? '').trim() && !String(year ?? '').trim()) {
    if (orig.unparsed) return originalGed.trim();
    return '';
  }
  return '';
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
    const married = String(p.marriedSurname || '').trim();
    if (married && p.surname) {
      L.push(`1 NAME ${p.given || ''} /${p.surname}/`);
      L.push('2 TYPE birth');
    } else {
      L.push(`1 NAME ${p.given || ''} /${p.surname || ''}/`);
    }
    if (married) {
      L.push(`1 NAME ${p.given || ''} /${married}/`);
      L.push('2 TYPE married');
    }
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

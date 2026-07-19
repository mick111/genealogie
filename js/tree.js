// tree.js — trois présentations d'arbre, façon MyHeritage :
//   • 'family'   : vue sablier VERTICALE (ancêtres au-dessus, descendants en-
//                  dessous, conjoint·e à droite, frères/sœurs à gauche)
//   • 'pedigree' : ascendants HORIZONTAUX (focus à gauche, ancêtres à droite)
//   • 'fan'      : éventail radial des ancêtres
//   • 'full'     : toutes les personnes par génération
// Clic sur une personne -> onSelect(id) (recentre l'arbre).

import { yearOf } from './gedcom.js';

const BOX_W = 108, BOX_H = 64, H_GAP = 22, V_GAP = 52;
const UNIT = BOX_W + H_GAP, ROW = BOX_H + V_GAP, MARGIN = 16;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Profondeur réelle de l'arbre depuis une personne (ancêtres / descendants).
export function computeTreeExtents(data, rootId) {
  const R = relations(data);
  let maxUp = 0;
  (function walkUp(id, d) {
    maxUp = Math.max(maxUp, d);
    const { father, mother } = R.parentsOf(id);
    if (father) walkUp(father, d + 1);
    if (mother) walkUp(mother, d + 1);
  })(rootId, 0);
  let maxDown = 0;
  (function walkDown(id, d) {
    maxDown = Math.max(maxDown, d);
    for (const c of R.childrenOf(id)) walkDown(c, d + 1);
  })(rootId, 0);
  return { maxUp, maxDown };
}

// -------------------------------------------------------------- dispatcher
export function renderTree(container, data, rootId, onSelect, opts = {}) {
  const mode = opts.mode || 'family';
  container.innerHTML = '';
  if (!data.individuals.get(rootId)) { container.textContent = 'Personne introuvable.'; return; }
  if (mode === 'full') return renderFullTree(container, data, rootId, onSelect);
  if (mode === 'pedigree') return renderPedigree(container, data, rootId, onSelect, opts.up ?? 4);
  if (mode === 'fan') return renderFan(container, data, rootId, onSelect, opts.up ?? 5);
  return renderFamily(container, data, rootId, onSelect, opts.up ?? 2, opts.down ?? 2);
}

// -------------------------------------------------------------- relations
function relations(data) {
  const { individuals, families } = data;
  return {
    parentsOf(id) {
      const p = individuals.get(id);
      const fam = p && p.famc.length ? families.get(p.famc[0]) : null;
      return { father: fam ? fam.husb : null, mother: fam ? fam.wife : null };
    },
    childrenOf(id) {
      const p = individuals.get(id); const out = [];
      if (p) for (const fid of p.fams) { const f = families.get(fid); if (f) for (const c of f.chil) if (!out.includes(c)) out.push(c); }
      return out;
    },
    spousesOf(id) {
      const p = individuals.get(id); const out = [];
      if (p) for (const fid of p.fams) { const f = families.get(fid); if (!f) continue; const s = f.husb === id ? f.wife : f.husb; if (s && !out.includes(s)) out.push(s); }
      return out;
    },
    siblingsOf(id) {
      const p = individuals.get(id);
      if (!p || !p.famc.length) return [];
      const f = families.get(p.famc[0]);
      return f ? f.chil.filter((c) => c !== id) : [];
    },
  };
}

// ============================================================== FAMILY (sablier)
function renderFamily(container, data, rootId, onSelect, maxUp, maxDown) {
  const { individuals } = data;
  const R = relations(data);

  let descLeaf = 0;
  const buildDesc = (id, depth) => {
    const node = { id, depth, kids: [] };
    if (depth < maxDown) for (const c of R.childrenOf(id)) node.kids.push(buildDesc(c, depth + 1));
    node.x = node.kids.length ? (node.kids[0].x + node.kids[node.kids.length - 1].x) / 2 : descLeaf++;
    return node;
  };
  const descRoot = buildDesc(rootId, 0);

  let ancLeaf = 0;
  const buildAnc = (id, depth) => {
    const node = { id, depth };
    if (depth < maxUp) {
      const { father, mother } = R.parentsOf(id);
      node.father = father ? buildAnc(father, depth + 1) : null;
      node.mother = mother ? buildAnc(mother, depth + 1) : null;
    }
    const ps = [node.father, node.mother].filter(Boolean);
    node.x = ps.length ? (ps[0].x + ps[ps.length - 1].x) / 2 : ancLeaf++;
    return node;
  };
  const ancRoot = buildAnc(rootId, 0);

  const shift = descRoot.x - ancRoot.x;
  (function s(n) { if (!n) return; n.x += shift; s(n.father); s(n.mother); })(ancRoot);
  const focusX = descRoot.x, focusRow = maxUp;

  const boxes = [], links = [];
  const cxOf = (xU) => xU * UNIT + BOX_W / 2;
  const addBox = (id, xU, row, f = false) => boxes.push({ id, xU, row, focus: f });

  // Lien familial propre : barre de mariage (optionnelle) entre parents,
  // descente depuis le milieu du couple, puis barre horizontale au-dessus des
  // enfants, chaque enfant relié verticalement à cette barre.
  const familyLink = (parentXs, childXs, parentRow, childRow, drawBar = true) => {
    const pBot = parentRow * ROW + BOX_H;
    const cTop = childRow * ROW;
    const busY = (pBot + cTop) / 2;
    let coupleMid;
    if (parentXs.length === 2) {
      const a = Math.min(parentXs[0], parentXs[1]), b = Math.max(parentXs[0], parentXs[1]);
      if (drawBar) links.push({ marr: true, d: `M ${a * UNIT + BOX_W} ${parentRow * ROW + BOX_H / 2} H ${b * UNIT}` });
      coupleMid = (parentXs[0] + parentXs[1]) / 2;
    } else coupleMid = parentXs[0];
    links.push({ d: `M ${cxOf(coupleMid)} ${pBot} V ${busY}` });     // descente
    const cxs = childXs.map(cxOf);
    if (cxs.length > 1) links.push({ d: `M ${Math.min(...cxs)} ${busY} H ${Math.max(...cxs)}` }); // barre enfants
    for (const cx of cxs) links.push({ d: `M ${cx} ${cTop} V ${busY}` }); // montées
  };

  addBox(rootId, focusX, focusRow, true);

  // conjoint·e(s) à droite + barre de mariage ; décale les descendants sous le couple
  const spouses = R.spousesOf(rootId);
  const spouseXs = [];
  spouses.forEach((s, i) => {
    const sx = focusX + 1 + i; addBox(s, sx, focusRow); spouseXs.push(sx);
    links.push({ marr: true, d: `M ${(focusX + i) * UNIT + BOX_W} ${focusRow * ROW + BOX_H / 2} H ${sx * UNIT}` });
  });
  if (spouseXs.length) (function sh(n) { for (const k of n.kids) { k.x += spouseXs.length / 2; sh(k); } })(descRoot);

  // descendants
  (function walk(n, depth) {
    if (!n.kids.length) return;
    n.kids.forEach((k) => addBox(k.id, k.x, focusRow + depth + 1));
    const parentXs = depth === 0 && spouseXs.length ? [focusX, spouseXs[0]] : [n.x];
    familyLink(parentXs, n.kids.map((k) => k.x), focusRow + depth, focusRow + depth + 1, false);
    n.kids.forEach((k) => walk(k, depth + 1));
  })(descRoot, 0);

  // frères/sœurs (à gauche) — enfants des parents du focus, comme lui
  const sibs = R.siblingsOf(rootId);
  const sibXs = sibs.map((s, i) => { const sx = focusX - 1 - i; addBox(s, sx, focusRow); return sx; });

  // ancêtres (barre de couple + descente vers l'enfant ; focus+fratrie pour le 1ᵉ niveau)
  (function walk(n) {
    const ps = [n.father, n.mother].filter(Boolean);
    if (!ps.length) return;
    ps.forEach((p) => addBox(p.id, p.x, focusRow - p.depth));
    const childXs = n.depth === 0 ? [focusX, ...sibXs] : [n.x];
    familyLink(ps.map((p) => p.x), childXs, focusRow - n.depth - 1, focusRow - n.depth, true);
    ps.forEach((p) => walk(p));
  })(ancRoot);

  const minX = Math.min(...boxes.map((b) => b.xU)), maxX = Math.max(...boxes.map((b) => b.xU));
  const minR = Math.min(...boxes.map((b) => b.row)), maxR = Math.max(...boxes.map((b) => b.row));
  const dx = -minX * UNIT + MARGIN, dy = -minR * ROW + MARGIN;
  const width = (maxX - minX) * UNIT + BOX_W + MARGIN * 2, height = (maxR - minR) * ROW + BOX_H + MARGIN * 2;

  const svg = el('svg', { class: 'tree-svg', viewBox: `0 0 ${width} ${height}`, width, height });
  for (const lk of links) svg.appendChild(el('path', { class: lk.marr ? 'tree-link tree-marr' : 'tree-link', d: shiftPath(lk.d, dx, dy) }));
  const seen = new Set();
  for (const b of boxes) {
    const key = b.id + '@' + b.row + '@' + b.xU; if (seen.has(key)) continue; seen.add(key);
    const person = individuals.get(b.id); if (!person) continue;
    svg.appendChild(nodeBox(person, b.xU * UNIT + dx, b.row * ROW + dy, b.focus, () => onSelect(b.id)));
  }
  container.appendChild(svg);
}

// ============================================================== FULL (toutes les personnes)
const FULL_BOX_W = 76, FULL_BOX_H = 50, FULL_H_GAP = 10, FULL_V_GAP = 36;
const FULL_UNIT = FULL_BOX_W + FULL_H_GAP, FULL_ROW = FULL_BOX_H + FULL_V_GAP;
const COMP_GAP = 3; // lignes vides entre composantes déconnectées

function connectedComponents(data, R) {
  const visited = new Set();
  const out = [];
  for (const id of data.individuals.keys()) {
    if (visited.has(id)) continue;
    const comp = [];
    const queue = [id];
    visited.add(id);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      const { father, mother } = R.parentsOf(cur);
      const neighbors = [
        ...R.spousesOf(cur),
        ...R.childrenOf(cur),
        ...R.siblingsOf(cur),
        father,
        mother,
      ].filter((n) => n && !visited.has(n));
      for (const n of neighbors) {
        visited.add(n);
        queue.push(n);
      }
    }
    out.push(comp);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

function assignGenerations(ids, data, R) {
  const idSet = new Set(ids);
  const gen = new Map();
  for (const id of ids) {
    const { father, mother } = R.parentsOf(id);
    const hasParent = (father && idSet.has(father)) || (mother && idSet.has(mother));
    if (!hasParent) gen.set(id, 0);
  }
  let changed = true;
  let guard = 0;
  while (changed && guard++ < ids.length * 3) {
    changed = false;
    for (const id of ids) {
      const { father, mother } = R.parentsOf(id);
      const pg = Math.max(
        father && idSet.has(father) ? (gen.get(father) ?? -1) : -1,
        mother && idSet.has(mother) ? (gen.get(mother) ?? -1) : -1,
      );
      if (pg >= 0) {
        const ng = pg + 1;
        if (gen.get(id) !== ng) { gen.set(id, ng); changed = true; }
      }
      for (const sid of R.spousesOf(id)) {
        if (!idSet.has(sid)) continue;
        const g = gen.get(id), sg = gen.get(sid);
        if (g != null && sg != null && g !== sg) {
          const m = Math.max(g, sg);
          gen.set(id, m); gen.set(sid, m); changed = true;
        } else if (g != null && sg == null) { gen.set(sid, g); changed = true; }
        else if (sg != null && g == null) { gen.set(id, sg); changed = true; }
      }
    }
  }
  for (const id of ids) if (!gen.has(id)) gen.set(id, 0);
  return gen;
}

function renderFullTree(container, data, rootId, onSelect) {
  const { individuals, families } = data;
  const R = relations(data);
  const components = connectedComponents(data, R);
  const boxes = [];
  const links = [];
  let rowOffset = 0;

  const cxOf = (xU, unit) => xU * unit + FULL_BOX_W / 2;
  const familyLinkFull = (parentXs, childXs, parentRow, childRow, unit, drawBar) => {
    const pBot = parentRow * FULL_ROW + FULL_BOX_H;
    const cTop = childRow * FULL_ROW;
    const busY = (pBot + cTop) / 2;
    let coupleMid;
    if (parentXs.length === 2) {
      const a = Math.min(parentXs[0], parentXs[1]), b = Math.max(parentXs[0], parentXs[1]);
      if (drawBar) links.push({ marr: true, d: `M ${a * unit + FULL_BOX_W} ${parentRow * FULL_ROW + FULL_BOX_H / 2} H ${b * unit}` });
      coupleMid = (parentXs[0] + parentXs[1]) / 2;
    } else coupleMid = parentXs[0];
    links.push({ d: `M ${cxOf(coupleMid, unit)} ${pBot} V ${busY}` });
    const cxs = childXs.map((x) => cxOf(x, unit));
    if (cxs.length > 1) links.push({ d: `M ${Math.min(...cxs)} ${busY} H ${Math.max(...cxs)}` });
    for (const cx of cxs) links.push({ d: `M ${cx} ${cTop} V ${busY}` });
  };

  for (const ids of components) {
    const genMap = assignGenerations(ids, data, R);
    let maxLocal = 0;
    for (const g of genMap.values()) maxLocal = Math.max(maxLocal, g);
    const byGen = new Map();
    for (const id of ids) {
      const row = rowOffset + genMap.get(id);
      if (!byGen.has(row)) byGen.set(row, []);
      byGen.get(row).push(id);
    }
    const pos = new Map();
    for (const [row, rowIds] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
      rowIds.sort((a, b) => {
        const pa = individuals.get(a), pb = individuals.get(b);
        return (pa?.surname || '').localeCompare(pb?.surname || '', 'fr')
          || (pa?.given || '').localeCompare(pb?.given || '', 'fr');
      });
      rowIds.forEach((id, i) => {
        const b = { id, xU: i, row, focus: id === rootId };
        boxes.push(b);
        pos.set(id, b);
      });
    }
    const idSet = new Set(ids);
    for (const fam of families.values()) {
      const parentIds = [fam.husb, fam.wife].filter((id) => id && idSet.has(id));
      const childIds = fam.chil.filter((id) => id && idSet.has(id));
      if (!parentIds.length || !childIds.length) continue;
      const parentXs = parentIds.map((id) => pos.get(id)?.xU).filter((x) => x != null);
      const childXs = childIds.map((id) => pos.get(id)?.xU).filter((x) => x != null);
      if (!parentXs.length || !childXs.length) continue;
      const parentRow = Math.max(...parentIds.map((id) => pos.get(id).row));
      const childRow = Math.min(...childIds.map((id) => pos.get(id).row));
      if (childRow <= parentRow) continue;
      familyLinkFull(parentXs, childXs, parentRow, childRow, FULL_UNIT, parentIds.length === 2);
    }
    rowOffset += maxLocal + 1 + COMP_GAP;
  }

  if (!boxes.length) {
    container.textContent = 'Aucune personne à afficher.';
    return;
  }

  const minX = Math.min(...boxes.map((b) => b.xU)), maxX = Math.max(...boxes.map((b) => b.xU));
  const minR = Math.min(...boxes.map((b) => b.row)), maxR = Math.max(...boxes.map((b) => b.row));
  const dx = -minX * FULL_UNIT + MARGIN, dy = -minR * FULL_ROW + MARGIN;
  const width = (maxX - minX) * FULL_UNIT + FULL_BOX_W + MARGIN * 2;
  const height = (maxR - minR) * FULL_ROW + FULL_BOX_H + MARGIN * 2;
  const dims = { w: FULL_BOX_W, h: FULL_BOX_H, nameLen: 10 };

  const svg = el('svg', { class: 'tree-svg tree-svg-full', viewBox: `0 0 ${width} ${height}`, width, height });
  for (const lk of links) svg.appendChild(el('path', { class: lk.marr ? 'tree-link tree-marr' : 'tree-link', d: shiftPath(lk.d, dx, dy) }));
  for (const b of boxes) {
    const person = individuals.get(b.id);
    if (!person) continue;
    svg.appendChild(nodeBox(person, b.xU * FULL_UNIT + dx, b.row * FULL_ROW + dy, b.focus, () => onSelect(b.id), dims));
  }
  container.appendChild(svg);
}

// ============================================================== PEDIGREE (horizontal)
function renderPedigree(container, data, rootId, onSelect, maxGen) {
  const { individuals } = data;
  const R = relations(data);
  let leaf = 0;
  const build = (id, gen) => {
    const node = { id, gen };
    if (gen < maxGen) {
      const { father, mother } = R.parentsOf(id);
      node.father = father ? build(father, gen + 1) : null;
      node.mother = mother ? build(mother, gen + 1) : null;
    }
    const ps = [node.father, node.mother].filter(Boolean);
    node.y = ps.length ? (ps[0].y + ps[ps.length - 1].y) / 2 : leaf++;
    return node;
  };
  const root = build(rootId, 0);

  const nodes = [], links = [];
  (function walk(n) {
    n.px = n.gen * (BOX_W + 50);
    n.py = n.y * (BOX_H + 18);
    nodes.push(n);
    for (const p of [n.father, n.mother]) {
      if (!p) continue;
      links.push({ x1: n.px + BOX_W, y1: n.py + BOX_H / 2, x2: (n.gen + 1) * (BOX_W + 50), y2: p.y * (BOX_H + 18) + BOX_H / 2 });
      walk(p);
    }
  })(root);

  const maxY = Math.max(...nodes.map((n) => n.py));
  const width = (maxGen + 1) * (BOX_W + 50) + MARGIN * 2;
  const height = maxY + BOX_H + MARGIN * 2;
  const svg = el('svg', { class: 'tree-svg', viewBox: `0 0 ${width} ${height}`, width, height });
  for (const l of links) {
    const midX = (l.x1 + l.x2) / 2;
    svg.appendChild(el('path', { class: 'tree-link', d: `M ${l.x1 + MARGIN} ${l.y1 + MARGIN} C ${midX + MARGIN} ${l.y1 + MARGIN}, ${midX + MARGIN} ${l.y2 + MARGIN}, ${l.x2 + MARGIN} ${l.y2 + MARGIN}` }));
  }
  for (const n of nodes) {
    const person = individuals.get(n.id); if (!person) continue;
    svg.appendChild(nodeBox(person, n.px + MARGIN, n.py + MARGIN, n.gen === 0, () => onSelect(n.id)));
  }
  container.appendChild(svg);
}

// ============================================================== FAN (éventail)
function renderFan(container, data, rootId, onSelect, maxGen) {
  const { individuals } = data;
  const R = relations(data);

  // ancêtres indexés en tas binaire : gen g, position i -> parents (g+1, 2i)/(2i+1)
  const gens = [[rootId]];
  for (let g = 1; g <= maxGen; g++) {
    const prev = gens[g - 1], row = [];
    for (const id of prev) {
      if (!id) { row.push(null, null); continue; }
      const { father, mother } = R.parentsOf(id);
      row.push(father || null, mother || null);
    }
    gens.push(row);
  }

  const R0 = 62;                     // rayon du disque central (focus)
  const RING = 74;                   // épaisseur d'un anneau
  const A0 = Math.PI, A1 = 2 * Math.PI; // demi-cercle supérieur
  const span = A1 - A0;
  const outer = R0 + RING * maxGen;
  const size = (outer + MARGIN) * 2;
  const cx = size / 2, cy = size / 2;

  const svg = el('svg', { class: 'tree-svg', viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  const groups = [];

  for (let g = 1; g <= maxGen; g++) {
    const count = 2 ** g, slice = span / count;
    const rIn = R0 + RING * (g - 1), rOut = R0 + RING * g;
    for (let i = 0; i < count; i++) {
      const a0 = A0 + i * slice, a1 = a0 + slice, mid = (a0 + a1) / 2;
      const id = gens[g][i];
      const person = id ? individuals.get(id) : null;
      const sexCls = !person ? 'sex-empty' : person.sex === 'F' ? 'sex-f' : person.sex === 'M' ? 'sex-m' : 'sex-u';
      const g_ = el('g', person ? { class: 'fan-node', tabindex: '0', role: 'button' } : { class: 'fan-empty' });
      g_.appendChild(el('path', { class: `fan-seg ${sexCls}`, d: sector(cx, cy, rIn, rOut, a0, a1) }));
      if (person) {
        const rMid = (rIn + rOut) / 2;
        let deg = mid * 180 / Math.PI;
        if (deg > 90 && deg < 270) deg += 180; // garder le texte lisible
        const tx = cx + rMid * Math.cos(mid), ty = cy + rMid * Math.sin(mid);
        const label = fanLabel(person, g);
        const txt = el('text', { class: 'fan-text', x: tx, y: ty, transform: `rotate(${deg.toFixed(1)} ${tx} ${ty})`, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
        label.forEach((line, k) => txt.appendChild(el('tspan', { x: tx, dy: k === 0 ? `-${(label.length - 1) * 0.5}em` : '1.05em' }, line)));
        g_.appendChild(txt);
        const select = () => onSelect(id);
        g_.addEventListener('click', select);
        g_.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
      }
      groups.push(g_);
    }
  }
  for (const g_ of groups) svg.appendChild(g_);

  // disque central (focus)
  const focus = individuals.get(rootId);
  const fg = el('g', { class: 'fan-node is-root', tabindex: '0', role: 'button' });
  fg.appendChild(el('circle', { class: 'fan-center', cx, cy, r: R0 }));
  const fl = fanLabel(focus, 0);
  const ft = el('text', { class: 'fan-text', x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  fl.forEach((line, k) => ft.appendChild(el('tspan', { x: cx, dy: k === 0 ? `-${(fl.length - 1) * 0.5}em` : '1.05em' }, line)));
  fg.appendChild(ft);
  fg.addEventListener('click', () => onSelect(rootId));
  svg.appendChild(fg);

  container.appendChild(svg);
}

function fanLabel(person, gen) {
  const given = person.given || person.name || '';
  const surname = person.marriedSurname || person.surname || '';
  const birth = person.marriedSurname && person.surname ? person.surname : '';
  const parts = gen >= 4
    ? [truncate(given, 12)]
    : birth
      ? [truncate(given, 12), truncate(surname, 12), truncate(`née ${birth}`, 14)]
      : surname
        ? [truncate(given, 12), truncate(surname, 12)]
        : splitName(person.name);
  const b = person.birth ? yearOf(person.birth.date) : '';
  const d = person.death ? yearOf(person.death.date) : '';
  if (b || d) parts.push(`${b || '?'}–${d || (person.death ? '?' : '')}`.replace(/–$/, ''));
  return parts;
}
function splitName(name) {
  const words = name.split(' ');
  if (words.length < 3) return [name];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}
function sector(cx, cy, rIn, rOut, a0, a1) {
  const P = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = P(rIn, a0), [x1, y1] = P(rOut, a0), [x2, y2] = P(rOut, a1), [x3, y3] = P(rIn, a1);
  const large = (a1 - a0) > Math.PI ? 1 : 0;
  return `M ${f(x0)} ${f(y0)} L ${f(x1)} ${f(y1)} A ${f(rOut)} ${f(rOut)} 0 ${large} 1 ${f(x2)} ${f(y2)} L ${f(x3)} ${f(y3)} A ${f(rIn)} ${f(rIn)} 0 ${large} 0 ${f(x0)} ${f(y0)} Z`;
}
const f = (n) => n.toFixed(1);

// -------------------------------------------------------------- utils communs
function nodeBox(person, x, y, isFocus, onSelect, dims = null) {
  const w = dims?.w ?? BOX_W, h = dims?.h ?? BOX_H;
  const nameLen = dims?.nameLen ?? 13;
  const sexCls = person.sex === 'F' ? 'sex-f' : person.sex === 'M' ? 'sex-m' : 'sex-u';
  const g = el('g', { class: 'tree-node' + (isFocus ? ' is-root' : ''), transform: `translate(${x}, ${y})`, tabindex: '0', role: 'button' });
  g.appendChild(el('rect', { class: `tree-box ${sexCls}`, width: w, height: h, rx: 8 }));
  const given = (person.given || person.name || '').trim();
  const surname = (person.marriedSurname || person.surname || '').trim();
  const birthName = person.marriedSurname && person.surname ? person.surname : '';
  const yGiven = h <= 52 ? 14 : 16, ySur = h <= 52 ? 26 : 30, ySub = h <= 52 ? 42 : 50;
  if (given) g.appendChild(el('text', { class: 'tree-given', x: 6, y: yGiven }, truncate(given, nameLen)));
  if (surname) g.appendChild(el('text', { class: 'tree-surname', x: 6, y: ySur }, truncate(surname, nameLen)));
  else if (!given) g.appendChild(el('text', { class: 'tree-given', x: 6, y: (yGiven + ySur) / 2 }, truncate(person.name, nameLen)));
  const sub = lifespan(person);
  if (sub) g.appendChild(el('text', { class: 'tree-dates', x: 6, y: ySub }, sub));
  else if (birthName) g.appendChild(el('text', { class: 'tree-dates', x: 6, y: ySub }, `née ${truncate(birthName, nameLen - 2)}`));
  g.addEventListener('click', onSelect);
  g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } });
  return g;
}
function el(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}
function shiftPath(d, dx, dy) {
  return d.replace(/([MVH]) ([\d.-]+)(?: ([\d.-]+))?/g, (m, cmd, a, b) =>
    cmd === 'M' ? `M ${(+a + dx).toFixed(1)} ${(+b + dy).toFixed(1)}`
      : cmd === 'V' ? `V ${(+a + dy).toFixed(1)}`
        : `H ${(+a + dx).toFixed(1)}`);
}
function lifespan(p) {
  const b = p.birth ? yearOf(p.birth.date) : '', d = p.death ? yearOf(p.death.date) : '';
  if (!b && !d) return '';
  return `${b || '?'} – ${d || (p.death ? '?' : '')}`.replace(/ – $/, '');
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

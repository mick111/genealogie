// tree.js — arbre ascendant (pedigree) en SVG, interactif.
// La personne racine est à gauche ; ses ancêtres s'étendent vers la droite.
// Clic sur une case -> callback onSelect(id).

import { yearOf } from './gedcom.js';

const BOX_W = 170;
const BOX_H = 52;
const COL_GAP = 60;   // espace horizontal entre générations
const ROW_GAP = 14;   // espace vertical minimal entre cases

const SVG_NS = 'http://www.w3.org/2000/svg';

// Renvoie { father, mother } (ids ou null) de l'individu via sa famille FAMC.
function parentsOf(indi, families) {
  if (!indi || !indi.famc.length) return { father: null, mother: null };
  const fam = families.get(indi.famc[0]);
  if (!fam) return { father: null, mother: null };
  return { father: fam.husb, mother: fam.wife };
}

// Construit l'arbre binaire d'ancêtres jusqu'à maxGen.
function buildAncestors(id, individuals, families, gen, maxGen) {
  const indi = individuals.get(id);
  if (!indi) return null;
  const node = { indi, gen, father: null, mother: null };
  if (gen < maxGen) {
    const { father, mother } = parentsOf(indi, families);
    node.father = buildAncestors(father, individuals, families, gen + 1, maxGen);
    node.mother = buildAncestors(mother, individuals, families, gen + 1, maxGen);
  }
  return node;
}

// Assigne les positions y (post-ordre). Retourne le y du centre du nœud.
function layout(node, cursor) {
  const kids = [node.father, node.mother].filter(Boolean);
  if (!kids.length) {
    node.y = cursor.y;
    cursor.y += BOX_H + ROW_GAP;
    return node.y;
  }
  const ys = kids.map((k) => layout(k, cursor));
  node.y = (Math.min(...ys) + Math.max(...ys)) / 2;
  return node.y;
}

function el(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

function subtitle(indi) {
  const b = indi.birth ? yearOf(indi.birth.date) : '';
  const d = indi.death ? yearOf(indi.death.date) : '';
  if (!b && !d) return '';
  return `${b || '?'} – ${d || (indi.death ? '?' : '')}`.replace(/ – $/, '');
}

export function renderTree(container, data, rootId, maxGen, onSelect) {
  const { individuals, families } = data;
  container.innerHTML = '';

  const rootNode = buildAncestors(rootId, individuals, families, 0, maxGen);
  if (!rootNode) {
    container.textContent = 'Personne introuvable.';
    return;
  }

  const cursor = { y: 0 };
  layout(rootNode, cursor);

  // Récupère tous les nœuds et calcule x par génération.
  const nodes = [];
  (function walk(n) {
    if (!n) return;
    n.x = n.gen * (BOX_W + COL_GAP);
    nodes.push(n);
    walk(n.father);
    walk(n.mother);
  })(rootNode);

  const width = (maxGen + 1) * (BOX_W + COL_GAP);
  const height = Math.max(cursor.y, BOX_H) + ROW_GAP;

  const svg = el('svg', {
    class: 'tree-svg',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
  });

  // Connecteurs enfant -> parents.
  for (const n of nodes) {
    for (const p of [n.father, n.mother]) {
      if (!p) continue;
      const x1 = n.x + BOX_W;
      const y1 = n.y + BOX_H / 2;
      const x2 = p.x;
      const y2 = p.y + BOX_H / 2;
      const midX = (x1 + x2) / 2;
      svg.appendChild(
        el('path', {
          class: 'tree-link',
          d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
        })
      );
    }
  }

  // Cases individus.
  for (const n of nodes) {
    const g = el('g', {
      class: 'tree-node' + (n.gen === 0 ? ' is-root' : ''),
      transform: `translate(${n.x}, ${n.y})`,
      tabindex: '0',
      role: 'button',
    });
    const sexClass = n.indi.sex === 'F' ? 'sex-f' : n.indi.sex === 'M' ? 'sex-m' : 'sex-u';
    g.appendChild(el('rect', { class: `tree-box ${sexClass}`, width: BOX_W, height: BOX_H, rx: 8 }));
    g.appendChild(el('text', { class: 'tree-name', x: 12, y: 22 }, truncate(n.indi.name, 22)));
    const sub = subtitle(n.indi);
    if (sub) g.appendChild(el('text', { class: 'tree-dates', x: 12, y: 40 }, sub));
    const select = () => onSelect(n.indi.id);
    g.addEventListener('click', select);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    svg.appendChild(g);
  }

  container.appendChild(svg);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

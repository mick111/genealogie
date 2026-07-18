// trees.js — catalogue et chemins des arbres (dossier trees/).

export const TREES_INDEX_URL = 'trees/index.json';
export const TREE_ID_KEY = 'gen_tree_id';

export function treeEncUrl(id) {
  return `trees/${id}/tree.enc`;
}

export function treeMediaDir(id) {
  return `trees/${id}/media/`;
}

export function storageKey(id) {
  return `gen_data_v1_${id}`;
}

export function getCurrentTreeId() {
  return localStorage.getItem(TREE_ID_KEY) || '';
}

export function setCurrentTreeId(id) {
  if (id) localStorage.setItem(TREE_ID_KEY, id);
  else localStorage.removeItem(TREE_ID_KEY);
}

export async function loadTreesIndex() {
  const res = await fetch(TREES_INDEX_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Impossible de charger la liste des arbres (' + res.status + ').');
  const data = await res.json();
  if (!Array.isArray(data.trees) || !data.trees.length) throw new Error('Aucun arbre configuré.');
  return data.trees;
}

export function findTreeMeta(trees, id) {
  return trees.find((t) => t.id === id) || null;
}

export function defaultGithubPath(id) {
  return `trees/${id}/tree.enc`;
}

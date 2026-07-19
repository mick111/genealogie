// trees.js — chemins de l'arbre unique (trees/principal/).

export const TREE_ID = 'principal';

export function treeEncUrl(id = TREE_ID) {
  return `trees/${id}/tree.enc`;
}

export function treeMediaDir(id = TREE_ID) {
  return `trees/${id}/media/`;
}

export function storageKey(id = TREE_ID) {
  return `gen_data_v1_${id}`;
}

export function getCurrentTreeId() {
  return TREE_ID;
}

export function defaultGithubPath(id = TREE_ID) {
  return `trees/${id}/tree.enc`;
}

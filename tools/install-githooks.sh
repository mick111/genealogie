#!/bin/sh
# Installe les hooks git du dépôt (symlinks vers .githooks/).
# À lancer une fois par clone : ./tools/install-githooks.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.githooks"
DEST="$ROOT/.git/hooks"

if [ ! -d "$DEST" ]; then
  echo "Erreur : $DEST introuvable (pas un dépôt git ?)" >&2
  exit 1
fi

for hook in "$SRC"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  case "$name" in
    *.sample) continue ;;
  esac
  chmod +x "$hook"
  ln -sf "../../.githooks/$name" "$DEST/$name"
  echo "  → $name"
done

echo "Hooks git installés."

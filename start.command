#!/bin/bash
# Double-clique ce fichier pour lancer le site en local (http://localhost).
# Nécessaire car le déchiffrement ne marche pas en ouverture directe (file://).
cd "$(dirname "$0")" || exit 1

PORT=8000
echo "🌳 Arbre généalogique — serveur local"
echo "   → http://localhost:$PORT"
echo "   (ferme cette fenêtre ou fais Ctrl+C pour arrêter)"
echo ""

# Ouvre le navigateur une fois le serveur prêt.
( sleep 1; open "http://localhost:$PORT/" ) &

# Lance le serveur (Python 3 est préinstallé sur macOS).
python3 -m http.server "$PORT"

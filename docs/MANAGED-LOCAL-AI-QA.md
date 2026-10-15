# Installation intégrée du moteur local

## Contrôles locaux du 15 octobre 2026

Le module télécharge à la demande les archives officielles d’Ollama **0.40.4**, avec leurs tailles et SHA-256 verrouillés dans `desktop/managed-ollama.mjs`. Il n’installe aucun service système, pilote ou clé API. Les modèles Qwen restent des téléchargements distincts et explicites.

Sur macOS ARM64, `node scripts/qa-managed-ollama.mjs` a réellement téléchargé l’archive officielle, vérifié son intégrité, extrait et installé le moteur dans un profil temporaire, démarré le service privé et confirmé sa version et l’appartenance de son port au processus enfant. `/api/tags` a confirmé un dossier de modèles vide. L’arrêt a fermé le port ; une nouvelle instance du gestionnaire a retrouvé l’installation validée. Durée observée **21,659 s**, téléchargement compris. Aucun poids ni photo personnelle utilisé. Le profil et le runtime ont été supprimés après l’essai. Ce temps n’est pas une estimation pour les autres machines.

Les tests automatisés couvrent les quatre distributions attendues, le refus des téléchargements corrompus ou redirigés hors des hôtes officiels, les limites d’archives, les liens de bibliothèques internes, les permissions exécutables, le manque de disque, l’annulation pendant téléchargement/extraction, la reprise d’un verrou identifié après crash, l’intégrité d’une installation réutilisée, le refus d’un port appartenant à un autre processus et le cycle démarrage/arrêt. Ils utilisent des archives et processus synthétiques : ils ne remplacent pas les essais des binaires officiels.

`Tests/managed-ai-electron.mjs` lance le vrai Electron avec un catalogue isolé et des téléchargements/inférences **simulés** via les IPC de test. Il vérifie le diagnostic préalable, les commandes explicites, le suivi après fermeture/réouverture, l’annulation, la sélection et le test du modèle, puis la sauvegarde du mode géré sans remplacer l’adresse externe par le port éphémère. `Tests/local-ai-electron.mjs` conserve la connexion externe et vérifie une analyse simulée, la vraie détection MediaPipe et un export PNG16 à 1 024 niveaux par canal, original inchangé.

## Construction des paquets

Le workflow de release exécute `scripts/qa-managed-ollama.mjs` sur macOS ARM64, macOS x64, Windows x64 et Linux x64 avant assemblage/publication. Chaque essai télécharge le runtime officiel de sa cible, démarre et arrête son service avec un magasin privé vide, puis le supprime. Il conserve une preuve JSON dans les artefacts `functional-qa-*`. Les contrôles de l’interface utilisent des inférences simulées et ne téléchargent pas de poids.

Les essais d’installation du moteur ne certifient ni l’utilisation d’un GPU, ni la qualité d’un modèle sur des portraits/paysages. Le premier essai de vrais poids Qwen3-VL 2B reste documenté séparément dans [LOCAL-AI-REAL-QA](LOCAL-AI-REAL-QA.md). ComfyUI n’a pas d’installation intégrée dans cette version ; son environnement et ses modèles restent une configuration avancée séparée.

# Réglages de l’IA locale

`src/LocalAIPanel.jsx` distingue le diagnostic matériel, la disponibilité du service, la configuration des modèles et l’essai d’inférence. L’ouverture de la carte ne lance aucune installation, aucun téléchargement et aucune inférence.

Après « Détecter ComfyUI », `comfyStatus()` peut fournir `assessment.status`, `assessment.requiredMemoryBytes` et `assessment.reasons`. La carte affiche le budget mémoire renvoyé par le processus principal. Elle ne recalcule aucun seuil matériel et n’utilise pas la mémoire libre pour bloquer une action.

- `status: "insufficient"` affiche une insuffisance de mémoire vive confirmée par les mesures et le budget applicatif.
- Tout autre état reste une estimation à vérifier. Un budget absent reste inconnu.
- Le texte précise que le budget n’est pas un minimum officiel et que le besoin réel dépend des modèles et de la taille de la photo.
- `ready: true` affiche « Configuration disponible ». Ce statut n’atteste pas qu’une génération d’image a été effectuée ou validée.

Le contrôle de ressources avant génération reste dans le processus principal et peut tenir compte des dimensions réelles de la photo. Le nombre de paramètres d’un modèle ne constitue pas à lui seul un seuil universel de RAM ou de VRAM.

Les messages sont traduits dans les douze catalogues. `Tests/local-ai-ui.test.mjs`, `Tests/locales.test.mjs` et `Tests/ui-coverage.test.mjs` vérifient les messages, leurs paramètres, la parité des catalogues et les garde-fous du composant. Les tests du budget de génération sont dans `Tests/local-runtime.test.mjs`.

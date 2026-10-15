# Atelier Photo 0.1.0

Première version publique : un atelier photo indépendant, gratuit et en douze langues, avec une interface noire et bleue. Les dons restent facultatifs, y compris 0 €.

- Bibliothèque paginée, sélections, notes, styles et projets non destructifs.
- Développement RAW à partir des données capteur et traitement RGB16 jusqu’à l’encodage final PNG/TIFF16.
- Retouches portrait fondées sur les visages détectés, courbes, HSL, LUT et préréglages.
- Recadrage, perspective et guides de composition au nombre d’or, affichables ou masquables ; aperçu spatial avec profondeur locale.
- IA facultative : clés personnelles OpenAI/Gemini/Claude, ou analyse locale avec Ollama. Chaque ordinateur dispose de son propre diagnostic matériel et d’un essai du modèle avant utilisation.
- Connexion avancée à un ComfyUI local pour la création de pixels et l’agrandissement. Les pixels originaux sont conservés exactement au centre lors de l’agrandissement.

## Installation

La page d’installation propose les commandes pour macOS Apple Silicon/Intel, Windows x64 et Linux x64. Les scripts vérifient `SHA256SUMS`, installent dans un dossier utilisateur et refusent d’écraser une installation existante. Les formats DMG, ZIP, NSIS, AppImage et DEB sont aussi fournis pour une installation manuelle.

Les binaires n’ont pas de signature commerciale Apple/Windows ni de notarisation Apple ; macOS utilise une signature ad hoc. Les protections du système restent actives et peuvent signaler ou bloquer ces téléchargements. Aucun script ne les désactive.

## Limites de cette version

Cette version reste une première publication et ne promet pas la précision des retouches propriétaires d’Evoto. Les masques portrait nécessitent une détection correcte du visage ; l’aperçu spatial ne reconstruit pas les parties cachées. Les modèles génératifs utilisent des aperçus réduits et leurs nouvelles zones ne gagnent pas un détail photographique natif 16 bits par l’export.

L’IA locale n’a pas de frais API, mais demande du matériel, du stockage, de l’électricité et du temps. Le diagnostic donne des estimations ; le test d’un modèle mesure une réponse, pas sa qualité esthétique. Un essai réel Qwen3-VL 2B a révélé des réglages non souhaités : le cadrage local est désormais conservé et les commandes portrait sont neutralisées sans visage détecté. Examiner une proposition avant de lancer un grand lot. ComfyUI et la qualité des modèles sur de vrais portraits/paysages restent à valider séparément.

Les constructions et contrôles automatiques des systèmes ciblés ne garantissent pas toutes les versions de systèmes, cartes graphiques ou configurations de modèles locaux. Windows et Linux ARM ne sont pas pris en charge par ces paquets.

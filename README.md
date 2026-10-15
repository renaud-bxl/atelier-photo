# Atelier Photo

Un atelier photo local pour macOS, Windows et Linux : bibliothèque pour les grandes séances, développement non destructif, retouche portrait et assistance IA locale facultative ou avec les clés de chaque utilisateur. Interface noire et bleue, disponible en français, néerlandais, anglais, espagnol, chinois, japonais, arabe (RTL), allemand, portugais, italien, hindi et coréen.

Cette application indépendante reprend des parcours observés dans Evoto avec REA. Elle n’utilise aucun binaire, modèle propriétaire, logo, photo ni actif extrait d’Evoto. **La version 0.1 est une première implémentation fonctionnelle, pas une équivalence complète d’Evoto.** Les observations et les limites sont documentées dans [REA-FINDINGS](docs/REA-FINDINGS.md).

## Lancer depuis les sources

Node.js 24 ou ultérieur et npm sont nécessaires. Ouvrir un terminal dans ce dossier :

```sh
npm ci --include=optional
npm start
```

La fenêtre est une application de bureau. `npm run dev` seul montre une page de développement sans accès aux fichiers ; utiliser `npm start` pour travailler avec des photos.

## Travailler avec ses photos

1. Importer des fichiers ou un dossier entier, sous-dossiers compris. Le catalogue conserve des références aux originaux ; il ne les déplace pas.
2. Rechercher, trier, noter les images de 0 à 5 et marquer les sélections avec `P`. La bibliothèque charge seulement les lignes visibles et quelques pages de métadonnées.
3. Double-cliquer pour développer une photo. Ajuster lumière, couleur, détails, cadrage et portrait. Maintenir Espace pour l’original, ou activer la comparaison avant/après. `Ctrl/⌘ Z` annule une retouche ; `Ctrl/⌘ Shift Z` la rétablit.
4. Enregistrer un préréglage ou synchroniser les réglages vers la sélection. « Tout sélectionner » inclut tous les résultats du filtre courant, même ceux qui ne sont pas à l’écran.
5. Exporter en JPEG, PNG ou TIFF dans un dossier choisi, à la taille d’origine ou réduite, avec filigrane facultatif. Les fichiers reçoivent un suffixe `_atelier` ; les originaux ne sont pas écrasés. Une tâche peut être arrêtée entre deux photos.

Le catalogue SQLite sur disque conserve les réglages, notes et sélections. L’import et l’export sont progressifs. Les aperçus sont limités à 1 600 pixels ; les vignettes ont un cache disque et les rendus simultanés sont bornés. Les projets `.atelier` v2 emportent les réglages et leurs LUTs avec vérification SHA-256. Ils référencent les photos sans les embarquer : leurs chemins doivent rester accessibles. Les projets v1 restent lisibles.

## IA locale, sans clé API

Dans les réglages IA, choisir **IA locale**, puis **Vérifier cet ordinateur**. Le diagnostic mesure le système, la mémoire, le GPU et le volume de stockage des modèles sur la machine de l’utilisateur. Les profils Qwen3-VL Instruct 2B/4B/8B sont proposés avec leurs besoins estimés ; une insuffisance mesurée bloque le téléchargement. Le traitement sur CPU reste possible mais peut être lent. Aucune configuration matérielle unique n’est imposée à tous les utilisateurs.

Ollama fournit l’analyse et des réglages appliqués par notre moteur 16 bits, en individuel ou en lot. Le bouton d’installation ouvre la page officielle du système ; les modèles se téléchargent ensuite sur demande. Un essai synthétique vérifie le protocole et mesure le temps de réponse du modèle choisi. Les Mac Intel sont évalués en mode CPU ; un dossier de modèles non confirmé ne donne pas de recommandation positive sur l’espace disque. Le diagnostic vérifie séparément les contextes graphiques des portraits et de la vue spatiale. ComfyUI + FLUX.2 Klein 4B Distilled constitue un module séparé pour créer des variantes et des bordures, avec un budget matériel supérieur. Les fonctions manuelles restent accessibles sans ces deux moteurs.

Cette option ne facture aucun appel API. Les téléchargements initiaux nécessitent Internet ; les requêtes de traitement utilisent exclusivement une adresse de cet ordinateur, sans repli cloud. Les services et poids ne sont pas embarqués dans l’installateur d’Atelier Photo. Un [premier essai réel Qwen3-VL 2B](docs/LOCAL-AI-REAL-QA.md) a validé le protocole et le traitement 16 bits, tout en révélant des réglages non demandés. Le cadrage existant est désormais conservé par l’application et les réglages portrait sont neutralisés sans visage détecté. **La justesse esthétique et les performances sur les autres configurations restent à mesurer.** Voir [configuration, profils et limites](docs/LOCAL-AI.md).

## IA avec les clés de l’utilisateur

Dans les réglages IA, choisir OpenAI, Gemini ou Claude, saisir sa clé et enregistrer. Aucune clé n’est livrée dans l’application. Les réglages photo locaux et la détection de visages fonctionnent hors ligne.

| Fonction | OpenAI | Gemini | Claude |
| --- | --- | --- | --- |
| Analyse et réglages locaux suggérés | Oui | Oui | Oui |
| Analyse personnalisée de toute une sélection | Oui | Oui | Oui |
| Création d’une nouvelle variante d’image | Oui | Oui | Non |
| Agrandissement génératif par côté | Oui | Oui | Non |

Les modèles sont modifiables. Une demande envoie un aperçu de la photo et la consigne au fournisseur choisi ; elle peut engendrer des frais sur le compte de l’utilisateur. L’analyse par lot précise le nombre d’appels avant son lancement. Une retouche générative crée une nouvelle image et conserve la source.

Les clés sont chiffrées par le service de l’OS : Trousseau macOS, DPAPI Windows ou coffre compatible sous Linux. Si un coffre sécurisé n’est pas disponible, la clé reste uniquement en mémoire pour la session. Elle n’est jamais enregistrée dans le catalogue ni dans un projet. Voir [les API et leur validation](docs/AI-API.md).

## Capacités et limites de cette version

- Réglages locaux : exposition, contraste, hautes lumières, ombres, température, teinte, saturation, vibrance, netteté, clarté, réduction du bruit, vignettage, courbes, HSL et LUT 3D.
- Portrait local : détection de plusieurs visages par MediaPipe ; lissage, réduction des imperfections, uniformisation du teint, lumière du visage, atténuation des cernes, éclat des yeux/dents, contraste des iris et couleur des lèvres. Un contexte WebGL compatible est nécessaire à l’entrée image, même pour le calcul CPU ; son absence est signalée avant le chargement du détecteur. Les masques reposent sur les repères détectés et des critères de couleur ; ils ne constituent pas une segmentation parfaite de chaque dent ou imperfection.
- Géométrie : rotation, redressement, miroir, perspective horizontale/verticale et recadrage positionnable. Les zones découvertes par la perspective sont transparentes et peuvent être retirées par recadrage.
- Nombre d’or : formats φ paysage/portrait, spirale avec quatre orientations, miroir et carrés ; « Afficher le guide » est indépendant du format choisi. Le guide reste une superposition d’interface et ne figure pas dans les exports.
- Vue spatiale : Depth Anything V2 **Small** estime localement une profondeur relative ; un maillage WebGL permet d’explorer un déplacement limité. Carte de profondeur et export de l’aperçu PNG disponibles. Il s’agit d’un aperçu de 1 600 px maximum, et les parties cachées ne sont pas reconstruites. Voir [la revue critique](docs/CRITICAL-REVIEW.md).
- Formats lus : JPEG, PNG, TIFF, WebP, AVIF et HEIF lorsque le décodeur embarqué le permet ; RAW/DNG/CR2/CR3/NEF/ARW/RAF et les formats pris en charge par LibRaw. Le développement RAW utilise les données capteur, sans remplacer un échec par le JPEG intégré. Voir [RAW](docs/RAW.md).
- Le moteur travaille en **RGB 16 bits par canal jusqu’à l’encodage final**, y compris pour un JPEG final. PNG/TIFF proposent 8 ou 16 bits ; JPEG est encodé en 8 bits. Les tests mesurent les valeurs intermédiaires, et non seulement la profondeur inscrite dans l’en-tête. Un fichier source 8 bits ne gagne pas d’information par sa conversion en 16 bits.
- 48 recettes originales et import personnel XMP/LUT `.cube`. Les profils Adobe ou fonctions non interprétées sont signalés ; les styles nécessitant un profil externe restent désactivés. Les presets privés ne sont pas redistribués. Voir [PRESETS](docs/PRESETS.md).
- Les retouches génératives utilisent un aperçu de 1 400 pixels au maximum (1 MP pour ComfyUI). Pour l’agrandissement, les pixels de la photo retouchée en pleine définition sont recopiés exactement au centre ; seules les bordures utilisent l’image générée puis agrandie. Ces bordures ne possèdent donc pas un détail photographique natif 16 bits. Les appels réels nécessitent un moteur local configuré ou une clé et une action de l’utilisateur ; seuls les contrats simulés ont été testés.
- Les calques, pinceaux manuels, corrections de profil optique et prise de vue connectée ne sont pas implémentés. La présence des fonctions décrites ne signifie pas une équivalence avec tous les traitements spécialisés d’Evoto.
- Les paquets Windows x64 ont été installés et testés sur un runner Windows propre (ZIP, NSIS et script PowerShell), avec import RAW et export 16 bits. Le DEB Linux a été installé sur Ubuntu 22.04 et testé pour le RAW et l’analyse locale simulée ; le runner sans contexte graphique vérifie l’indisponibilité explicite des visages, sans prétendre les avoir détectés. Les architectures ARM Windows/Linux et les autres configurations de pilotes ne sont pas validées par ces contrôles.

## Tests et paquets

```sh
npm test
npm run build
npm run package:mac
```

`npm run package` choisit la cible du système courant. Le dossier `release` reçoit les paquets. Le workflow GitHub produit des paquets macOS ARM/Intel, Windows x64 et Linux x64, accompagnés de `SHA256SUMS`, lors d’une publication volontaire. La signature/notarisation commerciale n’est pas configurée.

## Page d’installation et soutien

La page statique est dans `site/`. Elle propose un don PayPal facultatif à Renaud avant les instructions : 0 €, 5 €, 10 €, 20 € ou un montant libre. Aucun paiement n’est exigé ni vérifié par la page.

Le dépôt public est [renaud-bxl/atelier-photo](https://github.com/renaud-bxl/atelier-photo). Les commandes de téléchargement seront activées après publication des binaires vérifiés ; `site/config.json` garde jusque-là `repository: null` et la page montre les commandes de lancement depuis les sources. [DISTRIBUTION](docs/DISTRIBUTION.md) explique les installateurs et la publication. Les notices des composants et du modèle de visage sont dans [THIRD_PARTY](docs/THIRD_PARTY.md).

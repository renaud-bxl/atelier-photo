# Revue critique indépendante — Atelier Photo

État examiné le 15 octobre 2026. Cette revue porte sur les sources, les tests, les notices, le site et l’archive macOS disponibles localement. Les développeurs du moteur et du RAW intervenaient simultanément ; les observations corrigées pendant la revue sont distinguées des réserves encore ouvertes. Aucun original, preset privé ou fichier de `sources/` n’a été utilisé ou modifié.

## Conclusion et portée des preuves

La bibliothèque virtualisée, le catalogue SQLite, les réglages locaux, les masques faciaux, le système de presets et la séparation des clés API forment une base fonctionnelle. Cette base ne prouve pas encore une équivalence à un logiciel de retouche portrait avancée, ni la fiabilité d’une distribution destinée au public sur trois systèmes.

Aucun P0, tel qu’un écrasement démontré des originaux ou une exfiltration de clé, n’a été établi. Les P1 ci-dessous concernent la justesse des résultats et les conditions nécessaires avant de présenter la version comme prête. Une absence de preuve est signalée comme telle ; elle n’est pas transformée en panne avérée.

| Exigence | Ce qui existe | Ce qui reste à prouver ou à compléter |
| --- | --- | --- |
| Grands lots | SQLite, pagination, DOM virtualisé, rendus bornés, import/export progressifs | Séances réelles RAW haute définition, mémoire maximale, interruption et reprise |
| RAW et précision | Nouveau décodeur LibRaw, travail 16 bits et quantification finale, tests de dégradés numériques | Parcours import → aperçu → export dans le paquet final, plusieurs boîtiers |
| Portrait et paysage | Repères MediaPipe, lissage/lumière/yeux/bouche, couleur, géométrie | Segmentation précise de peau/dents, imperfections, cheveux, pinceaux, corrections optiques ; qualité sur de vrais portraits |
| Nombre d’or | Composant mathématique, tests de continuité ; raccordement UI ajouté pendant la revue et test GUI principal annoncé réussi | Vérifier l’absence du guide dans l’export |
| XMP/LUT | Import inerte, statut de compatibilité, interpolation 3D, projets v2 avec LUT | Aller-retour du projet sur profil neuf ; comparaison avec références connues, sans promettre le rendu Adobe |
| 12 langues/RTL | Douze catalogues, direction RTL arabe, test Electron existant | Traduction des nouveaux flux presets, guide d’or, RAW et profondeur d’export |
| BYOK trois fournisseurs | Clés personnelles, endpoints fixes, recommandations trois fournisseurs, images OpenAI/Gemini | Acceptation réelle par les comptes/modèles choisis ; aucun appel payant effectué par cette revue |
| Sécurité/données | Originaux référencés, exports exclusifs, safeStorage avec repli mémoire, contrôle IPC et CSP | Restaurations de projet et sauvegardes complètes ; validation des limites sur fichiers volumineux |
| Trois OS et don | Scripts SHA-256, matrice native GitHub, don facultatif avec continuation gratuite | Paquets exécutés sur machines propres ; dépendances natives ; dépôt/release publics encore absents |

## P1 — Défauts démontrés et éléments bloquant une promesse de version prête

### P1.1 — Quantification prématurée des exports 8 bits et des aperçus

**État final de la revue : corrigé, reproduction numérique indépendante repassée.**

**Référence observée :** `desktop/image-engine.mjs:82` puis `:87-89`. Le type de tous les calculs est choisi à partir du format de sortie : un JPEG ou PNG 8 bits convertit la source en `uchar` avant exposition, couleur et portrait.

**Reproduction numérique exécutée :** une source PNG 16 bits de 1 024 colonnes, grise, avec les valeurs `1000 + 2*x`, est traitée à +3 EV. L’export PNG 8 bits direct ne conserve que **9 niveaux**, espacés de 8 ; le même traitement en PNG 16 bits suivi de la conversion finale 8 bits conserve **65 niveaux** consécutifs. Ce défaut réduit les dégradés dans les ombres et peut produire une différence entre aperçu/JPEG et TIFF 16 bits.

**Correction relue :** le moteur conserve désormais `ushort` pour toutes les corrections, même avant JPEG/PNG8 ; il convertit à 8 bits lors de l’encodage. La même reproduction indépendante donne maintenant **65 niveaux en sortie directe et 65 niveaux dans la référence, pixels strictement identiques**. Le propriétaire du moteur a également ajouté son test de régression. Le paquet final reste à reconstruire et à contrôler.

### P1.2 — Les projets ne transportent pas les LUT nécessaires au rendu

**État final de la revue : correction source relue ; aller-retour sur profil neuf encore à exécuter par le responsable principal.**

**Référence observée :** `desktop/main.mjs`, gestionnaire `saveProject` et fonction `loadLUT` (environ lignes 300 et 489 à la lecture initiale). Le projet contient les chemins et réglages, dont `lutId`, mais la LUT elle-même reste dans le dossier de données de cette installation.

**Conséquence :** ouvrir un projet sur une installation neuve, avec les photos toujours accessibles, ne permet pas de reproduire une retouche utilisant une LUT ; le rendu signale que la LUT est introuvable. Une sauvegarde de références seule n’est donc pas une sauvegarde complète du travail.

**Correction relue :** le format de projet v2 emporte les LUT référencées ; l’import vérifie schéma, SHA-256 et collision d’identifiants avant de restaurer les ressources. Les images restent référencées. Tester une ouverture avec un dossier de données neuf puis comparer les pixels exportés, y compris pour une LUT manquante ou altérée.

### P1.3 — Ouvrir un projet peut laisser l’inspecteur sur d’anciens réglages

**État final de la revue : correction source relue ; scénario GUI après restauration encore à exécuter.**

**Référence observée :** `src/main.jsx`, action « Ouvrir un projet » et fonction `reload` (environ lignes 120 et 50). Le chargement change le catalogue et rafraîchit les compteurs/presets/filmstrip ; il ne recharge pas la photo active ni ses contrôles.

**Reproduction par parcours de code :** garder une photo ouverte avec exposition 0,5 ; ouvrir un projet qui donne à cette même photo une exposition 1,5. Le catalogue est mis à 1,5, tandis que les contrôles React conservent 0,5. L’export relit les réglages du catalogue et peut donc différer de l’écran ; modifier ensuite un contrôle peut remplacer les autres réglages du projet par l’ancien état local.

**Correction relue :** après l’ouverture, la photo active est rechargée par identifiant, ses réglages et aperçu resynchronisés, et son historique supprimé. Tester aussi le cas d’une photo active absente du projet. Le scénario GUI n’a pas été exécuté par cette revue.

### P1.4 — La couverture des douze langues ne couvre pas les nouveautés

**Références observées :** `src/PresetBrowser.jsx:10-23`, `src/Dialogs.jsx:162`, `src/main.jsx` contrôles du guide ; `src/i18n.js:58` retourne le texte source en l’absence de traduction. `Tests/locales.test.mjs:23-29` vérifie l’égalité d’un catalogue figé à 405 messages, pas la couverture du code affiché.

**Preuve exécutée :** les clés « Styles & préréglages », « Importer XMP / LUT », « Préréglages originaux », « Afficher le guide », « Recadrer au nombre d’or », « Position horizontale », « Profondeur de couleur », « 16 bits par canal » et « 8 bits par canal » étaient absentes même du catalogue français. Les écrans concernés reviennent donc au français dans les autres langues, tout en laissant passer le test des 405 messages.

**Correction :** compléter les douze langues et vérifier ces écrans en anglais, néerlandais et arabe, puis étendre le test de couverture aux messages effectivement introduits. Préférer des identifiants explicites et des paramètres de message pour les nouveaux flux ; les pluriels assemblés par fragments restent fragiles pour l’arabe et les langues dont l’ordre des mots diffère.

### P1.5 — Le paquet macOS disponible au début de la revue était antérieur aux correctifs

**Artefact inspecté sans lancement :** `release/mac-arm64/Atelier Photo.app/Contents/Resources/app.asar`.

La comparaison SHA-256 des fichiers extraits en mémoire a trouvé `desktop/main.mjs`, `desktop/image-engine.mjs` et `package.json` différents des sources. `desktop/raw-decoder.mjs` n’existait pas dans cette archive. Cette observation est normale pendant le développement, mais cet artefact ne doit pas servir de preuve des nouvelles fonctions.

**Validation requise :** reconditionner après stabilisation ; comparer les fichiers empaquetés aux sources validées ; charger les modules natifs et ouvrir/exporter au moins un RAW depuis **le paquet** sur chaque système ciblé. Une construction de sources réussie ne vérifie pas le paquet final.

### P1.6 — Les dépendances natives RAW doivent être vérifiées sur machines propres

**Références observées :** `package.json` configuration de distribution ; `.github/workflows/release.yml`, étape de chargement native initialement limitée à `sharp` ; README du paquet `@janhapke/libraw` installé.

Le binding documente `libgomp.so.1` sous Linux et `VCOMP140.dll` sous Windows. Son chargement sur un runner de développement ne prouve pas leur présence sur la machine du destinataire. La configuration initiale ne déclarait pas de dépendance `.deb` à `libgomp1`. L’extraction ASAR du binding a été ajoutée pendant le travail, ce qui répond à une partie seulement du conditionnement.

**Correction/validation :** déclarer les dépendances requises, documenter les prérequis Windows, vérifier la composition AppImage et contrôler le chargement LibRaw dans l’archive finale. Tester une installation sur machine/VM propre, sans outils de développement préinstallés. Ne pas présenter les trois systèmes comme testés tant que ces essais n’ont pas été réalisés. [Contrat du binding](https://github.com/janhapke/libraw-node#install)

## P2 — Limites fonctionnelles et preuves encore insuffisantes

- **La retouche portrait reste une approximation locale.** `src/face-worker.js` limite le détecteur à dix visages et produit des polygones d’yeux/bouche ; `desktop/image-engine.mjs:203-250` applique un ovale pour la peau, des exclusions géométriques et un seuil de luminosité pour la bouche. Aucun masque sémantique des dents, outil d’imperfection, cheveux, vêtements, modelage ou pinceau n’est implémenté. L’IA générative est une nouvelle image de résolution et fidélité variables, pas une preuve de retouche portrait locale avancée. L’interface doit nommer précisément ces fonctions et leur limite ; l’aperçu détecté à 1 600 px peut manquer les petits visages.
- **Le flux massif n’a pas encore de mesure représentative.** `Tests/catalog.test.mjs:15-20` crée des fichiers texte portant l’extension `.jpg` ; `Tests/electron-smoke.mjs` réutilise par liens le même JPEG synthétique de 1 200 × 800. Ces tests vérifient utilement le catalogue et le DOM de 10 000 références, pas 10 000 décodages RAW haute définition. Les lots export/synchronisation créent encore une liste de tous les identifiants avant travail. Mesurer import, navigation, export, mémoire résidente et réactivité sur une séance mixte de 24/45/100 MP, avec annulation et disque presque plein.
- **L’export matérialise plusieurs images entières.** Le moteur est borné à deux tâches, mais chaque tampon RGBA 16 bits de 100 MP représente environ 800 Mo avant les copies et filtres. La limite de pixels de 180 MP n’est pas un budget mémoire. Une mesure du pic mémoire doit déterminer la concurrence ou la taille de tuile admissible sur une machine de 8/16 Go.
- **Le cache de vignettes n’est pas borné.** `desktop/main.mjs`, fonction `photoThumbnail`, écrit un nouveau fichier à chaque identité source, sans quota ni purge lors du retrait du catalogue. Le cache RAW est désormais borné à 4 Go, mais les vignettes et variantes générées demandent une politique distincte et une commande de nettoyage qui préserve les originaux.
- **La couleur reste en sRGB.** Le moteur impose son profil de sortie ; il ne propose pas de choix de profil de travail, d’épreuvage écran ni de sauvegarde large gamut. Le développement RAW utilise une balance caméra fixe ; la température de l’interface est une correction après développement. Le terme « RAW/16 bits » doit préciser cette portée et ne pas promettre récupération de hautes lumières déjà écrêtées, gestion HDR ou rendu Camera Raw équivalent.
- **Les prestations IA réelles ne sont pas vérifiées.** Les tests interceptent `fetch` et valident des enveloppes et des erreurs avec secrets fictifs. C’est pertinent pour le contrat local et la confidentialité ; cela ne prouve pas qu’un compte utilisateur dispose des modèles ni que chaque service accepte aujourd’hui les requêtes. Conserver cette limite dans la documentation, et offrir des messages d’erreur/action utiles sans ajouter d’appel facturé automatique.
- **La distribution publique n’existe pas encore.** `site/config.json` contient `repository: null`, les instructions publiques sont donc volontairement locales. Le don reste facultatif et la continuation gratuite disponible. Cela satisfait le parcours de don, mais ne constitue pas un installateur public utilisable par un destinataire sans les sources. La signature/notarisation Apple et la signature Windows ne sont pas configurées.

## Défauts signalés puis corrigés pendant la revue

1. **Courbes XMP perdues au-delà de 64 points.** Le parseur acceptait 256 points, tandis que le moteur en gardait au plus 64 : une courbe à 65 points était annoncée `adapted` puis supprimée. Après le correctif, la reproduction directe conserve **65/65 et 256/256 points**. Le calcul des courbes a aussi été accéléré par recherche binaire. Ajouter/conserver ce cas à la suite de régression.
2. **Nombre de photos sélectionnées périmé dans l’éditeur.** Le total venait uniquement du composant bibliothèque, démonté en édition ; un import depuis l’éditeur laissait un ancien nombre d’appels IA affiché. Un décompte indépendant de la vue a été ajouté, et le backend compare désormais `expectedCount` à l’instantané des identifiants avant l’appel. Relecture des deux protections effectuée ; le responsable principal annonce le test GUI d’import en éditeur et de compteur réussi, sans appel API.
3. **Guide d’or présent mais non monté.** Le composant a été raccordé avec affichage indépendant du recadrage, quatre orientations, miroir et carrés. Relecture effectuée ; le responsable principal annonce le test GUI des bascules indépendantes, quatre orientations/miroir et recadrage φ portrait réussi.

## Outils supplémentaires utiles, avec coût réel d’intégration

Ces propositions sont des évolutions ciblées, pas des dépendances à ajouter toutes immédiatement. Les corrections de justesse et les preuves de distribution passent avant elles.

| Outil | Manque traité et intégration proposée | Compromis, licence et distribution |
| --- | --- | --- |
| **Lensfun** | Ajouter les corrections de distorsion, aberration chromatique latérale et vignettage optique, particulièrement utiles aux paysages. Identifier boîtier/objectif, proposer le profil détecté puis appliquer la correction avant cadrage. | Bibliothèque native C/C++ ; gérer les profils absents et figer/versionner la base. Bibliothèque LGPL 3 ; base CC BY-SA 3.0, avec notices et obligations propres. Le module n’apporte pas de retouche portrait. [Capacités](https://lensfun.github.io/manual/latest/), [licences](https://github.com/lensfun/lensfun#license). |
| **OpenCV, sous-ensemble de filtres** | Évaluer un filtrage bilatéral local ou guidé dans les zones de peau pour préserver davantage les contours que le couple médiane/flou actuel. Utiliser des données float32 pour ne pas introduire un nouveau chemin 8 bits. | La préservation des contours n’est pas la préservation automatique des pores ; elle exige une évaluation visuelle et des masques corrects. Coût CPU supérieur et distribution native ou WebAssembly à maîtriser. OpenCV ≥4.5 est Apache 2.0 ; construire seulement les modules nécessaires. [Filtrage](https://docs.opencv.org/4.x/d4/d13/tutorial_py_filtering.html), [licence](https://opencv.org/license/). |
| **ExifTool, facultatif** | Ajouter une politique explicite de métadonnées : conserver auteur/copyright/date à l’export, retirer GPS sur demande, et lire/écrire les sidecars indépendamment des pixels. Exécuter avec arguments structurés et chemins choisis, sans écrire dans les originaux. | Runtime Perl ou paquet Windows à gérer ; chaque appel et chaque métadonnée copiée doivent être bornés et contrôlés. Licence au choix Perl Artistic ou GPL, distincte de celle de l’application. Il ne développe pas les RAW et ne doit pas remplacer la conversion ICC. [Fonctions et licence officielles](https://github.com/exiftool/exiftool/blob/master/README). |

**À conserver plutôt qu’à remplacer :** Sharp/libvips pour le calcul et LibRaw pour le décodage, avec une seule représentation interne précise. Ajouter un autre moteur RAW ou un framework ML lourd avant de mesurer les limites actuelles augmenterait surtout la taille, les conversions et la matrice de tests. Un modèle de segmentation portrait ne doit être retenu qu’après vérification séparée des licences du code, des poids et des données ; aucune liste de modèles à licence incertaine n’est proposée ici.

## Vérifications minimales avant livraison

1. Passer la suite finale après la dernière modification des sources, puis construire une seule fois l’interface et les paquets correspondants.
2. Vérifier numériquement RAW → corrections → TIFF/PNG16 et JPEG/PNG8 : plus de 256 niveaux réellement mesurés lorsque la sortie le permet, absence d’un simple élargissement 8→16, alpha et orientation conservés, quantification tardive.
3. Restaurer un projet avec LUT sur un dossier de données neuf ; comparer export et aperçu à la référence ; vérifier le rafraîchissement de la photo active.
4. Contrôler visuellement le guide, le recadrage déplacé, la comparaison et les nouveaux dialogues en français, anglais, néerlandais et arabe. Vérifier les douze catalogues sur les messages nouveaux.
5. Tester le paquet installé sur Mac ARM/Intel, Windows x64 et Linux x64 : chargement LibRaw/Sharp, import RAW réel, export, coffre de clés présent/absent et annulation. Une VM propre est nécessaire pour les dépendances runtime.
6. Utiliser une séance représentative pour mesurer débit et pic mémoire, puis décrire une capacité testée et les limites observées plutôt qu’une quantité « illimitée ».

La tentative GUI de cette revue a échoué au lancement sous Playwright (`Process failed to launch!`). Le responsable principal a ensuite trouvé un arrêt dans l’enregistrement graphique macOS, avant le chargement du code Node de l’application ; le test a réussi avec accès graphique hors sandbox. Cela distingue l’échec de l’environnement de test d’un crash démontré du moteur photo. Aucun appel IA, paiement, création de compte ou publication n’a été effectué par cette revue.

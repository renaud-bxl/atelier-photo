# Développement RAW et précision 16 bits

Le développement est local : `desktop/raw-decoder.mjs` utilise **@janhapke/libraw 0.1.0**, dont le précompilé installé annonce **LibRaw 0.22.2-Release** et **1 258 modèles d’appareil**. Il dématrice les données du capteur ; un aperçu JPEG intégré ne remplace jamais un développement RAW échoué. Aucun fichier d’origine n’est modifié.

## Contrat du module

```js
isRaw(path) // reconnaissance de l’extension, insensible à la casse
await identifyRaw(path)
await resolveRawSource(path, { cacheDirectory, fullResolution: false, signal })
```

`identifyRaw` ouvre un chemin absolu avec `Processor.openFile`, puis lit ses métadonnées sans appeler `unpack` ou `process`, ni charger tout le fichier dans un Buffer JavaScript. Le résultat comporte `width`, `height`, `make`, `model`, `format: 'raw'`, `bits: 16`, les dimensions du capteur, l’orientation source, le décodeur et la version du moteur. **`bits: 16` désigne la profondeur du traitement de sortie**, pas une affirmation que chaque capteur produit 16 bits natifs. `sourceBits` reprend l’information du décodeur lorsqu’elle existe. La sortie développée applique l’orientation du moteur et porte `orientation: 1`.

`resolveRawSource` renvoie un chemin TIFF 16 bits dans le cache privé fourni par l’application. Un chemin dont l’extension n’est pas RAW est renvoyé inchangé, sans lecture. Pour un RAW, les paramètres sont :

```js
{ use_camera_wb: true, output_bps: 16, no_auto_bright: true,
  half_size: !fullResolution }
```

L’aperçu utilise la demi-définition du moteur, toujours avec 16 bits par canal. `fullResolution: true` développe toute la définition pour l’export. La balance des blancs de l’appareil et le traitement couleur/gamma par défaut de LibRaw s’appliquent : ce TIFF est une image développée RGB, pas les valeurs brutes de la mosaïque et pas un équivalent de profil Adobe ou Evoto.

Le module vérifie `image.bits === 16`, les dimensions et la taille des pixels, puis passe par **`image.toSharp(sharp)`**, qui fournit un `Uint16Array`. Un Buffer brut ferait inférer une profondeur 8 bits à sharp. Le pipeline conserve explicitement `rgb16`, écrit un TIFF LZW sans perte, et vérifie `depth: 'ushort'` et `bitsPerSample: 16` avant de rendre le chemin. Les traitements et le format d’export ultérieurs doivent eux aussi préserver la précision : PNG/TIFF peuvent conserver 16 bits ; JPEG final reste 8 bits. Ce module seul ne certifie pas tous les réglages de l’éditeur.

## Formats, limites et erreurs

Extensions reconnues : RAW, DNG, CR2, CR3, CRW, NEF, NRW, ARW, SR2, SRF, RAF, ORF, RW2, RWL, PEF, PTX, SRW, ERF, MEF, 3FR, FFF, IIQ, KDC, DCR, MOS, MRW, X3F, MDC, BAY et CAP. L’extension autorise la tentative d’ouverture ; la compatibilité effective dépend du boîtier, du mode de compression et de la version LibRaw. La liste précise est disponible dans `cameraList()` du paquet et dans les [sources LibRaw](https://github.com/LibRaw/LibRaw).

Le module refuse les sources vides ou supérieures à 2 Gio, les images dépassant 180 millions de pixels ou 32 000 pixels sur un axe, et les données non RAW maquillées avec une extension RAW. Une dépendance native manquante, un fichier endommagé, un manque d’espace ou une annulation donne une erreur explicite ; aucun JPEG de secours n’est annoncé comme RAW 16 bits. Les précompilés disponibles ne garantissent pas la prise en charge de tous les modes propriétaires ou futurs des appareils.

## Cache et concurrence

Un seul développement natif s’exécute à la fois dans ce processus. Les demandes identiques partagent leur résultat ; l’annulation d’un demandeur conserve le travail dont d’autres demandeurs ont encore besoin. Le moteur reçoit le signal d’annulation. Les appels de lecture des métadonnées ne passent pas par la file de développement.

Le sous-dossier `raw16-v1` contient des TIFF nommés `atelier-raw16-v1-<sha256>.tiff` avec un manifeste `.json`. La clé inclut chemin canonique, taille, date de modification nanoseconde, paramètres, version du paquet, version LibRaw et version de cache. La demi-définition et la pleine définition ont des clés distinctes. La source est revérifiée après décodage pour éviter un résultat devenu obsolète pendant l’opération.

L’écriture utilise un fichier temporaire unique, un manifeste atomique puis un renommage atomique du TIFF. Le dossier est créé avec le mode `0700`, les résultats et manifestes avec `0600` lorsque le système applique ces modes. La limite est de **4 Gio de résultats et manifestes reconnus** ; les plus anciens accès sont évincés et l’espace est réservé avant l’écriture. La purge exige le nom attendu, le propriétaire, la version de manifeste et des taille/date concordantes. Elle ne supprime jamais un original, un lien symbolique ou un fichier tiers. Des fichiers temporaires laissés par une interruption brutale ou des fichiers non reconnus ne sont pas purgés automatiquement ; ils ne font pas partie du quota de résultats reconnus. Un fichier inconnu occupant le chemin du résultat produit une erreur au lieu d’être écrasé.

## Distribution native

Le [projet du binding](https://github.com/janhapke/libraw-node) et sa [matrice de construction](https://github.com/janhapke/libraw-node/blob/main/docs/reference/build-matrix.md) documentent Node-API 8 et `NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED`, nécessaires à la compatibilité Electron. Le paquet fournit macOS arm64/x64, Linux glibc arm64/x64 et Windows x64 ; Windows arm64 et Linux musl n’ont pas de précompilé fourni. Le JavaScript et les bibliothèques `.node` doivent être inclus, les binaires natifs sortis de `app.asar`. Les modules sharp de l’architecture cible sont également nécessaires.

| Système | Dépendance supplémentaire | Distribution à valider |
| --- | --- | --- |
| macOS | OpenMP statiquement lié par le paquet | Inclure le précompilé de la bonne architecture, signer et tester l’app empaquetée. |
| Linux glibc | `libgomp.so.1` dynamique | Dépendance `libgomp1` pour un paquet Debian ; pour AppImage, embarquer une bibliothèque compatible et un chemin de chargement effectif. |
| Windows x64 | `VCOMP140.DLL`, `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` | Redistributable Visual C++ v14 x64, ou DLL Release officielles autorisées en déploiement local près de l’exécutable. |

Sur Linux, les chaînes de versions du précompilé installé mentionnent GOMP 1.0/4.0/4.5 et GLIBC jusqu’à 2.27 ; ceci n’est pas une exécution de compatibilité. Une AppImage peut placer `libgomp.so.1` près du `.node` puis configurer son `RUNPATH` relatif `$ORIGIN` à la construction, ou définir `LD_LIBRARY_PATH` dans `AppRun` **avant** le démarrage d’Electron. Modifier cette variable après le lancement dans `main` n’est pas une solution fiable : le [chargeur Linux la consulte au démarrage du programme](https://man7.org/linux/man-pages/man3/dlopen.3.html). Le choix d’une bibliothèque issue d’un système trop récent peut relever le minimum glibc. Vérifier ses dépendances et un démarrage sur la distribution minimale annoncée. L’[AppDir](https://docs.appimage.org/reference/appdir.html) prévoit les bibliothèques dans l’image et un point d’entrée `AppRun`.

Sur Windows, [Microsoft permet le déploiement local](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170) mais recommande le redistributable central pour sa maintenance. Utiliser les DLL Release de `VC/Redist/MSVC/<version>/x64/Microsoft.VC*.CRT` et `Microsoft.VC*.OpenMP` d’un environnement Visual Studio dûment licencié, sans modifier les fichiers ; vérifier les dépendances transitives. La [liste de redistribution officielle](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution) encadre ces droits. Une alternative est le [redistributable Microsoft x64 officiel](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170), de version au moins égale à celle du compilateur. Son installation peut demander les droits administrateur ; ne pas la lancer silencieusement comme si elle n’avait aucun effet système. Aucun téléchargement de DLL tierces n’est prévu.

Les besoins ci-dessus sont documentés ; **le module RAW ne copie ni n’installe lui-même de bibliothèques système**. Les distributions Linux/Windows doivent être contrôlées par leur chaîne de publication native avant d’être annoncées autonomes.

## Licences à conserver à la distribution

Le wrapper est sous **MIT**, copyright 2026 Jan Hapke. Son étiquette npm MIT ne couvre pas à elle seule les composants natifs. Conserver sans les raccourcir `node_modules/@janhapke/libraw/LICENSE` et `THIRD_PARTY_NOTICES.md` dans les sources et distributions ; le second contient les textes et attributions détaillés.

- LibRaw 0.22.2 : le paquet choisit **CDDL 1.0** parmi sa double licence CDDL/LGPL 2.1. Conserver la licence, les attributions et l’accès aux sources couvertes, notamment les références exactes de la version distribuée. Les packs de dématriçage GPL `user_qual` 5–10 sont exclus du binding installé.
- zlib 1.3.2 : licence zlib ; libjpeg-turbo 3.2.0 : licences IJG, BSD modifiée et zlib ; node-addon-api : MIT. LibRaw contient aussi les attributions BSD/MIT mentionnées dans ses notices.
- OpenMP macOS embarqué : Apache 2.0 avec exception LLVM. La version exacte de libomp n’est pas épinglée par le dépôt du binding ; garder ses notices et la provenance de la construction.
- Si `libgomp` est ajouté à une archive Linux : conserver sa version, sa provenance, sa licence GPL avec **GCC Runtime Library Exception**, et les obligations applicables à la redistribution de cette bibliothèque. Les notices du binding ne constituent pas une copie de sa licence complète ni de ses sources.
- Les redistribuables Microsoft restent régis par les conditions Microsoft applicables à leur source et à leur redistribution.

Références primaires : [notices du binding](https://github.com/janhapke/libraw-node/blob/main/THIRD_PARTY_NOTICES.md), [sources LibRaw](https://github.com/LibRaw/LibRaw), [licence de libgomp](https://gcc.gnu.org/onlinedocs/libgomp/Copying.html). L’inventaire de distribution de l’application doit accompagner les bibliothèques effectivement livrées.

## Validation réalisée sur cette machine

Les neuf tests `Tests/raw-decoder.test.mjs` passent dans Node et dans **Electron 44.7.2 / Node 24.21.0 / macOS arm64**, en utilisant le vrai précompilé LibRaw. Ils fabriquent une mire DNG originale Bayer RGGB 16 bits de 1 024 × 64 pixels, sans image utilisateur, téléchargement de photo, ni aperçu JPEG. La documentation de [fixture de l’amont](https://github.com/janhapke/libraw-node/blob/main/test/fixtures/README.md) a informé les balises DNG nécessaires ; le contenu de la mire et son générateur sont propres aux tests.

Vérifications : ouverture native et inventaire des appareils, identification du DNG, dématriçage complet, TIFF `ushort` 16 bits avec **plus de 256 valeurs rouges distinctes** et des valeurs non multiples de 257, aller-retour TIFF16 avec tous les échantillons identiques, aperçu 512 × 32 toujours 16 bits, identité/réutilisation du cache, modification de date source, demandes concurrentes, préservation du hash de l’original et des fichiers tiers, rejet d’un faux RAW/JPEG et annulation d’un seul abonné. Il s’agit d’un développement natif de véritables valeurs Bayer synthétiques, pas d’une simple déclaration de profondeur dans des métadonnées.

Non validés ici : boîtiers physiques et leurs compressions, comparaison des profils couleur avec un logiciel propriétaire, rotations de tous les formats, éviction réelle d’un cache de 4 Gio, exécution sur Linux/Windows, et chargement depuis une application signée empaquetée. La compatibilité Electron locale est établie pour ce moteur et ce système ; elle ne remplace pas ces validations de publication.

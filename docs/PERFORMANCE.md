# Mesures de performance et revue de la vue spatiale

Mesure effectuée le **15 octobre 2026 à 16 h 51, heure de Bruxelles**. Une seule photo synthétique de **9 000 × 5 000 pixels, soit 45 mégapixels**, a été utilisée. Aucun original utilisateur, preset privé, appel API, paiement ou réseau n’a été utilisé par le benchmark.

## Résultat mesuré

Le traitement couleur + portrait + perspective a conservé une véritable précision 16 bits à pleine définition. Sur la machine mesurée, son export prend environ **24 secondes en TIFF16** et **22 secondes en JPEG**, avec un pic de mémoire résidente de **3,6 à 4 Gio pour un seul rendu**. L’original reste strictement identique.

Ces chiffres décrivent un essai synthétique sur cette machine. Ils ne démontrent ni un débit de plusieurs milliers de photos, ni une capacité illimitée, ni un fonctionnement identique sur un ordinateur de 8 Gio.

| Étape | Résolution produite | Temps de rendu | Temps de l’étape, contrôles compris | Pic RSS du processus |
| --- | --- | ---: | ---: | ---: |
| Génération de la source RGB16 originale | 9 000 × 5 000 | — | 1,529 s | 389 Mio |
| Métadonnées + import d’une référence SQLite | 9 000 × 5 000 référencés | — | 0,005 s | 70 Mio |
| Aperçu couleur | 1 600 × 889 | 1,068 s | 1,070 s | 343 Mio |
| Aperçu portrait | 1 600 × 889 | 0,700 s | 0,702 s | 240 Mio |
| Aperçu perspective | 1 600 × 889 | 0,607 s | 0,609 s | 240 Mio |
| Export combiné TIFF16 LZW | 9 000 × 5 000 | 24,125 s | 24,219 s | **3 716 Mio / 3,63 Gio** |
| Export combiné JPEG, qualité 92 | 9 000 × 5 000 | 21,946 s | 21,948 s | **4 058 Mio / 3,96 Gio** |

La concurrence des rendus pleine définition est **1** dans cet essai. Tous les processus et toutes les étapes sont strictement séquentiels. Les deux exports sont issus de la même source, chacun recalculant le traitement complet ; aucun intermédiaire 8 bits n’est réutilisé.

## Machine, versions et protocole

- Mac Apple M3 Pro, 12 processeurs logiques, **36 Gio de mémoire physique** ; plateforme `darwin/arm64`, noyau Darwin `27.0.0`.
- Node.js `26.3.0`, Sharp `0.35.5`, libvips `8.18.7`.
- Réglages identiques à ceux du moteur principal : `sharp.concurrency(2)` et cache Sharp de 64 Mio.
- Un processus Node neuf par étape pour séparer la mémoire de génération, celle des aperçus et celle des exports. Le processus parent attend sa terminaison avant l’étape suivante.
- Le pic RSS est celui fourni par le système à `process.resourceUsage().maxRSS`, converti de Kio en Mio. Ce n’est pas seulement la mémoire du tas JavaScript. Un échantillonnage RSS complémentaire à 25 ms donne des résultats concordants.
- Le temps de rendu entoure uniquement `renderImage`. Le temps de l’étape inclut aussi l’écriture et les vérifications de son résultat ; le démarrage/import des modules du processus n’est pas inclus dans ce temps.
- Les photos et sorties sont créées dans un dossier temporaire privé, puis supprimées par un `finally`. Le script n’écrit pas dans le catalogue utilisateur et n’ouvre aucune fenêtre Electron.

Pour reproduire depuis la racine du projet :

```sh
node Tests/benchmark-large.mjs
```

Le benchmark est volontairement exclu de `npm test`, car il utilise plusieurs Gio de mémoire et prend environ une minute sur cette machine. Il imprime un rapport JSON avec environnement, timings, précision, empreinte et consommation mémoire ; il ne laisse pas les images de test sur disque.

## Contenu et précision contrôlés

La source est un **TIFF RGB 16 bits créé à partir d’un Uint16Array**, avec dégradés de ciel et paysage, zone centrale de couleur peau, yeux/lèvres schématiques et petits résidus colorés. Ce contenu est calculé par le script et ne provient d’aucune photographie. La source compressée mesure 12 086 420 octets.

Le test portrait fournit explicitement des repères géométriques synthétiques. Il mesure le coût des filtres et masques ; il **ne mesure pas la justesse de la détection MediaPipe ni la qualité esthétique sur un visage réel**.

Les exports combinés activent exposition, contraste, saturation, balance relative des blancs, vibrance, ombres/hautes lumières, réduction du bruit, netteté, clarté, vignettage, courbe et HSL, puis les neuf réglages portrait et une correction de perspective horizontale/verticale. Les valeurs exactes sont dans le script et le JSON produit. Les bords transparents de la perspective sont conservés en TIFF et aplatis pour le JPEG.

| Vérification sur une ligne intérieure de 4 096 pixels | Source TIFF16 | Export TIFF16 |
| --- | ---: | ---: |
| Niveaux rouges distincts | 4 096 | **3 713** |
| Niveaux verts distincts | 4 096 | **3 815** |
| Niveaux bleus distincts | 3 860 | **3 432** |
| Échantillons RGB non multiples de 257 | 12 244 | **12 249** |

Les deux images contiennent donc bien plus de 256 niveaux : le TIFF final n’est pas une image 8 bits simplement élargie à 16 bits. Les métadonnées confirment `ushort` et 16 bits par canal. Le JPEG final est bien en 8 bits, après traitement interne 16 bits.

Le TIFF exporté mesure 76 610 196 octets et le JPEG 908 716 octets ; leur taille est propre à ce contenu synthétique et ne permet pas de prévoir la taille d’une photo réelle détaillée ou bruitée.

Empreinte SHA-256 de la source, identique avant et après tous les traitements :

```text
521a83420b3c6968350ac1c4cf6abe9d5cebef884443b19d7a58ce346034866f
```

Le retard maximal observé du timer à 25 ms est d’environ 106 ms pendant l’aperçu couleur, 1,3 ms pour les autres aperçus, 5,7 ms pendant l’étape TIFF et 6,4 ms pendant l’étape JPEG. C’est une indication de réactivité du processus de calcul isolé, pas une mesure de la fluidité de l’interface Electron complète.

## Interprétation pour les grands lots

Le traitement 45 MP fonctionne sur cette configuration. Sa consommation mémoire impose toutefois de conserver une marge pour Electron, les aperçus, les modèles, le GPU, le système et les autres applications. Un tampon RGBA16 de 45 MP représente déjà environ **343 Mio** ; les étapes matérialisées et filtres produisent plusieurs tampons, ce que confirme le pic proche de 4 Gio.

Un lot doit rester progressif et limiter les exports pleine définition simultanés. Cette mesure justifie **un export pleine définition à la fois par défaut** ; elle ne permet pas de promettre deux exports 45 MP en parallèle sur 8 Gio. Une limite de pixels ou un nombre de tâches borné ne remplace pas un budget mémoire.

Ne pas convertir les 24 secondes mesurées en promesse de débit journalier : le benchmark ne couvre ni un lot long, ni le comportement thermique, ni des supports lents, ni le tri/cache, ni des RAW de différents boîtiers. Le temps de 0,005 s de l’import mesure une seule lecture d’en-tête TIFF et une référence SQLite ; ce n’est pas le temps d’import d’un RAW de 45 MP.

À mesurer ensuite sur machines ciblées : un lot mixte de boîtiers et résolutions, pic RSS dans l’application empaquetée, annulation, disque presque plein et reprise, puis machines Windows/Linux propres et Mac de mémoire plus faible. Le script actuel constitue une référence reproductible et limitée, pas un test d’endurance.

## Revue complémentaire de la vue spatiale

### Ce que le code réalise

`src/depth-worker.js` charge les deux fichiers ONNX locaux par le protocole `atelier:`, effectue une inférence WASM dans un worker, puis le termine. Le modèle est **Depth Anything V2 Small ONNX quantifié**, référence figée dans `public/models/depth/MANIFEST.json`. Les deux fichiers ont été relus et leur SHA-256 correspond au manifeste : graphe de 162 005 octets et poids de 38 414 848 octets. Les notices locales indiquent Apache 2.0 pour ce modèle ; ONNX Runtime WASM est fourni localement sous sa licence propre. Aucun modèle Apple n’est impliqué.

L’entrée modèle est limitée à 518 pixels sur le grand côté, avec dimensions multiples de 14 et normalisation RGB ImageNet. `src/depth-core.js` convertit la profondeur **relative** en 256 niveaux après écrêtage des percentiles 2 et 98 ; les valeurs ne sont pas des distances en mètres.

`src/spatial-renderer.js` applique cette carte à un maillage de **193 × 129 sommets et 49 152 triangles**, texturé par l’aperçu existant. Les rotations produisent une vue à relief et de la parallaxe ; elles ne reconstruisent pas un objet volumique complet. Des étirements sont possibles aux discontinuités de profondeur. Les parties initialement cachées et les zones découvertes par la rotation ne sont pas inventées ou remplies. Le texte de l’interface l’indique.

La capture est celle du rendu WebGL `UNSIGNED_BYTE`, enregistrée comme nouvelle variante PNG : **aperçu sRGB 8 bits, grand côté au plus 1 600 pixels dans ce parcours**. Elle ne remplace pas l’export photo principal 16 bits et ne conserve pas un RAW ou un HDR. La protection IPC à 4 096 pixels est une limite défensive ; elle ne porte pas la définition effective de l’aperçu à 4 096 pixels.

### Confidentialité et limites de vérification

La relecture trouve uniquement des chargements `atelier://assets/...` pour ce calcul et l’image provient de l’aperçu local. Le responsable principal a exécuté le test Electron spatial réel : inférence locale d’environ 2 secondes, pixels modifiés avec yaw/pitch, carte visible, variante PNG créée, empreinte source inchangée et aucune requête HTTP observée. Ces observations sont distinctes du benchmark Node 45 MP, qui ne lance ni modèle de profondeur ni WebGL.

La fermeture termine le worker et détruit les ressources du renderer. La qualité d’estimation sur cheveux, transparences, reflets, ciel uniforme et détails fins n’est pas évaluée par le test synthétique. La mesure de 2 secondes n’est pas une garantie de délai sur tous les processeurs ou sur un logiciel WebGL de secours.

### Défauts signalés pendant cette relecture et état des correctifs

1. **P1 — Validation base64 avec débordement de pile.** L’ancienne expression comportant un groupe répété levait `RangeError: Maximum call stack size exceeded` pour une chaîne base64 valide de 4 Mio, malgré une limite annoncée de 24 Mio. Le backend utilise maintenant `desktop/media-input.mjs` avec contrôles linéaires. Reproduction indépendante après correction : entrées de 4 et 12 Mio acceptées, décodées respectivement en 3 et 9 Mio, sans débordement. Le responsable principal a aussi ajouté des tests de grandes entrées et de rejet.
2. **P2 — Position explorée perdue en quittant la photo pour exporter.** La remise à zéro au `pointerleave` a été retirée. Relecture du correctif effectuée : la position reste maintenant posée lors du passage au bouton ; la réinitialisation reste explicite.
3. **P2 — Ancienne erreur/carte après changement de source.** L’effet de chargement remet désormais carte et erreur à zéro avant la nouvelle inférence. Relecture effectuée ; conserver un test de changement de source pendant et après un calcul.

### Améliorations ciblées encore utiles

- Conserver une mention explicite « profondeur relative estimée » et « aperçu PNG 8 bits, 1 600 px maximum » dans l’aide et les limites produit, pour distinguer cette variante du développement 16 bits.
- Tester un contexte WebGL volontairement perdu : afficher une erreur et désactiver la capture si le GPU ne fournit plus d’image. Le scénario n’a pas été exécuté ici ; il constitue un cas de robustesse à couvrir, pas une panne observée.
- Vérifier au conditionnement les empreintes du graphe et des poids du manifeste, en plus de leur présence dans `dist`. La relecture locale ci-dessus ne prouve pas l’identité des fichiers d’un futur paquet téléchargé.
- Ajouter des scènes de référence non privées avec occlusions nettes et surfaces difficiles, puis vérifier le sens proche/loin, les déformations et la capture. Un test où les pixels changent prouve une transformation effective, pas la justesse de la géométrie estimée.

L’ajout d’un autre moteur de vision n’est pas nécessaire pour terminer ces vérifications. Aucune installation d’OpenCV, Lensfun ou outil supplémentaire n’a été effectuée.

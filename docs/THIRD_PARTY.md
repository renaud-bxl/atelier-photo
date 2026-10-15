# Composants tiers d’Atelier Photo

Atelier Photo est une implémentation indépendante. Aucun code, modèle neuronal, nom de marque, élément d’interface ou actif graphique extrait d’Evoto n’est distribué avec cette application.

## Détection locale des portraits

Le moteur utilise `@mediapipe/tasks-vision` 1.1.1, développé par les auteurs de MediaPipe / Google, sous licence Apache License, Version 2.0. Le paquet est compilé dans le worker local ; ses fichiers JavaScript et WebAssembly sont fournis dans `models/wasm/`.

Sources et informations officielles :

- [Dépôt MediaPipe et licence Apache 2.0](https://github.com/google-ai-edge/mediapipe).
- [Guide Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker).
- [API Web Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js).

Le fichier `models/face_landmarker.task` est le bundle officiel Google MediaPipe Face Landmarker, version float16/1, téléchargé depuis [Google Cloud Storage](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task). Il comprend les modèles suivants, tous déclarés sous licence Apache License, Version 2.0 dans leurs fiches respectives :

| Modèle | Auteurs indiqués dans la fiche | Source de licence |
| --- | --- | --- |
| BlazeFace, détection de visage | Valentin Bazarevsky, Google ; fiche par Yury Kartynnik et Artsiom Ablavatski, Google | [Fiche BlazeFace, page 1](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf) |
| MediaPipe FaceMesh V2, repères du visage | Geng Yan et Ivan Grishchenko, Google | [Fiche FaceMesh V2, page 1](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf) |
| Blendshape V2, composant du bundle dont la sortie est désactivée dans Atelier | Ivan Grishchenko, Geng Yan, Andrei Zanfir et Eduard Gabriel Bazavan, Google | [Fiche Blendshape V2, page 1](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf) |

Le texte original de la licence Apache 2.0 est inclus dans `models/LICENSE.txt`. La compilation Vite copie ce fichier avec les modèles pour l’inclure dans l’application distribuée. Le texte de licence a été repris sans modification depuis la copie Apache 2.0 du paquet `@playwright/test` installé ; les attributions MediaPipe ci-dessus identifient les composants auxquels il s’applique ici. Les noms et marques de leurs auteurs ne constituent pas un soutien à Atelier Photo.

La détection s’exécute localement sur des aperçus auto-orientés de 1 600 pixels maximum. Le modèle repère la géométrie du visage ; il ne reconnaît pas l’identité. Les visages petits, tournés ou masqués peuvent être manqués. Sans visage détecté, les retouches de peau, lumière du visage, yeux et dents restent inactives. Les retouches reposent sur des masques et filtres locaux, et ne reproduisent pas les modèles propriétaires d’Evoto.

## Traitement et interface

- [Sharp](https://github.com/lovell/sharp), Apache 2.0, utilise [libvips](https://github.com/libvips/libvips), LGPL-2.1-or-later. Les binaires précompilés Sharp/libvips embarquent leurs composants et notices propres dans les dépendances `@img/`.
- [Electron](https://github.com/electron/electron), MIT, et ses composants Chromium/Node.js sont fournis avec leurs licences et notices de distribution.
- [React](https://github.com/facebook/react), MIT.
- [Lucide](https://github.com/lucide-icons/lucide), ISC.
- Vite, MIT, et ses dépendances servent à construire l’interface ; Playwright, Apache 2.0, sert aux vérifications de développement.

Les licences présentes dans les paquets distribués doivent être conservées lors du conditionnement. La licence MIT d’Atelier Photo n’annule pas les conditions applicables à ses dépendances.

## Formats, qualité et fonctionnement sans réseau

Les retouches locales, la détection de portraits, le catalogue et les exports fonctionnent sans connexion. Les options IA OpenAI, Gemini et Claude nécessitent une connexion et une clé du fournisseur sélectionné. Les photos ne sont envoyées à ce fournisseur qu’après une demande IA explicite.

Les originaux sont conservés. Les exports JPEG, PNG et TIFF utilisent leur résolution entière lorsque l’option de réduction est désactivée. Le moteur travaille en **RGB16** jusqu’à l’encodage : les PNG/TIFF peuvent conserver 16 bits par canal, et JPEG/PNG8 quantifient seulement à la fin. Le TIFF utilise LZW, PNG est sans perte et JPEG applique la qualité choisie. Les tests vérifient la présence de plus de 256 niveaux distincts après les traitements, la conservation de l’alpha et la précision après réencodage. Les sources 8 bits ne gagnent pas de détails absents de l’original. HEIF/HEIC reste dépendant des codecs livrés.

## Développement RAW

`@janhapke/libraw` 0.1.0 fournit le binding MIT et un moteur LibRaw 0.22.2 sous l’élection CDDL 1.0 documentée dans son paquet. Les fichiers `LICENSE` et `THIRD_PARTY_NOTICES.md` du paquet sont conservés dans l’application, avec les références des sources exactes et composants auxiliaires. Les dépendances OpenMP diffèrent selon la plateforme. Voir [RAW](RAW.md) pour les notices, paramètres et limites, et [le dépôt du binding](https://github.com/janhapke/libraw-node).

## Profondeur et vue spatiale

Le modèle **Depth Anything V2 Small**, auteurs Lihe Yang, Bingyi Kang, Zilong Huang, Zhen Zhao, Xiaogang Xu, Jiashi Feng et Hengshuang Zhao, est déclaré Apache 2.0 sur [sa fiche officielle](https://huggingface.co/depth-anything/Depth-Anything-V2-Small). La conversion ONNX quantifiée provient de [onnx-community/depth-anything-v2-small-ONNX](https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX/tree/c3b67641fd837b2368757101311e5d21e511441e), révision `c3b67641fd837b2368757101311e5d21e511441e`. Le manifeste fournit les SHA-256 des deux fichiers de poids/graphe. La licence et les attributions sont dans `models/depth/`. Les modèles Base/Large à licence distincte ne sont pas inclus.

ONNX Runtime Web 1.30.0, [Microsoft, licence MIT](https://github.com/microsoft/onnxruntime/blob/v1.30.0/LICENSE), exécute ce modèle en WebAssembly local. Son runtime et sa licence sont inclus dans `models/onnx/`. Le calcul produit une profondeur relative estimée ; il ne mesure pas les distances réelles et ne reconstruit pas les zones cachées. L’exploration 3D est un maillage texturé, et l’export est un aperçu PNG. Aucun modèle Apple ou Evoto n’est utilisé.

## Bordures génératives

OpenAI/Gemini produisent des bordures depuis un aperçu réduit. L’application recopie le centre original localement en RGBA16 pour le préserver exactement. Les pixels générés et agrandis n’acquièrent pas une précision photographique supplémentaire du fait de leur conteneur PNG16. Le service distant choisi conserve ses propres conditions d’utilisation et de facturation.

Les sources et licences ont été consultées le 15 octobre 2026.

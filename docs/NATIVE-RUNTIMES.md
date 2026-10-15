# Runtimes natifs et vérification des paquets

La préparation est définie dans `scripts/prepare-native.mjs`, exécutée par `.github/workflows/release.yml`. Les versions npm proviennent du verrou installé avec `npm ci --include=optional`. Aucun binaire d’un autre OS n’est réutilisé. Les cibles de distribution sont macOS arm64 et x64, Windows x64 et Linux x64.

## Commandes

Depuis la racine d’Atelier Photo :

```text
node scripts/prepare-native.mjs --verify-only
node scripts/prepare-native.mjs --verify-electron
node scripts/prepare-native.mjs --smoke-packaged
```

La première commande charge Sharp et LibRaw sans modifier de fichier. Elle vérifie un aller-retour PNG, LibRaw 0.22.2 et au moins 1 000 modèles d’appareil. La deuxième prépare les dépendances de l’OS courant, conserve leurs notices, effectue ce contrôle sous Node, puis le répète avec le Node d’Electron. Elle lance également les neuf tests RAW avec `ELECTRON_RUN_AS_NODE=1` : DNG Bayer synthétique, dématriçage réel, TIFF16, plus de 256 niveaux mesurés, cache et annulation.

La dernière commande exécute **le programme empaqueté** avec `--test-native-backend`, sans catalogue ni fenêtre. La branche de démarrage de l’application doit produire `ATELIER_NATIVE_OK` suivi d’un objet JSON et quitter avec le code 0. Tout chargement natif incorrect doit donner un code non nul. Sous Windows, une application graphique peut ne pas attacher sa sortie console : le code de sortie reste vérifié. Sous Linux, la CI utilise Xvfb, teste le dossier conditionné puis **l’AppImage finale**, en [mode officiel extraction et lancement](https://docs.appimage.org/user-guide/troubleshooting/fuse.html#extract-and-run-type-2-appimages) pour ne pas dépendre de FUSE sur le runner.

Les scripts n’ajoutent aucun runtime au système de l’utilisateur et ne téléchargent aucun programme tiers. La préparation Linux/Windows récupère seulement les documents de licence et, dans la CI Linux, les sources correspondant à la bibliothèque déjà installée depuis Ubuntu.

## Linux : Ubuntu 22.04 et AppImage

Le job est fixé à `ubuntu-22.04`, avec sa base glibc 2.35. Il installe `libgomp1`, `patchelf` et `binutils` depuis les dépôts de cet OS. La préparation refuse une autre distribution/version et une architecture autre que x64. Elle :

1. lit les versions binaire et source avec `dpkg-query` ;
2. retrouve le fichier installé et vérifie son appartenance au paquet `libgomp1` ;
3. copie le contenu réel de `libgomp.so.1` à côté de `prebuilds/linux-x64/node.napi.node` ;
4. fixe le **RUNPATH** du module à `$ORIGIN` avec `patchelf` ;
5. vérifie le RUNPATH avec `readelf`, les versions de symboles et les dépendances avec `ldd` ; ce dernier doit résoudre **la copie embarquée** de libgomp, sans ligne « not found » ;
6. conserve `/usr/share/doc/libgomp1/copyright`, GPL-3 et GCC Runtime Library Exception 3.1.

Le dépaquetage ASAR de tout `@janhapke/libraw/**/*` est nécessaire : module, bibliothèque et notices doivent rester voisins sur le disque. L’AppImage contient ainsi son runtime OpenMP ; le paquet Debian déclare aussi `libgomp1` dans `deb.depends`. La glibc, les bibliothèques système GTK et les exigences de lancement d’Electron restent celles de la distribution cible.

La documentation officielle d’[Ubuntu libgomp1 pour Jammy](https://packages.ubuntu.com/jammy/libgomp1) identifie son paquet source GCC. Le régime de la bibliothèque est GPL avec [GCC Runtime Library Exception 3.1](https://gcc.gnu.org/onlinedocs/libgomp/Copying.html). Le texte exact de l’exception est conservé depuis le [dépôt miroir officiel GCC, tag 12.3.0](https://github.com/gcc-mirror/gcc/blob/releases/gcc-12.3.0/COPYING.RUNTIME). Cette exception ne supprime pas les obligations propres à la redistribution de la bibliothèque.

Pour une release, la CI utilise `--with-sources`. Elle télécharge le `.dsc` officiel du paquet GCC exact depuis `archive.ubuntu.com`, puis tous les fichiers qu’il référence, en vérifiant leur taille et leur SHA-256. `--archive-sources` les réunit dans `AtelierPhoto-Linux-native-sources.tar.xz`, publié à côté des installateurs avec son empreinte dans `SHA256SUMS`. Cette archive comprend les sources GCC, les adaptations Debian/Ubuntu et les instructions d’extraction ; il faut la conserver avec chaque release qui embarque ce libgomp. Un échec de récupération bloque la release, sans substituer les sources d’une autre version.

## Windows : CRT et OpenMP Microsoft

Le job utilise `windows-2022` et Visual Studio 2022 installé sur cette machine. `vswhere.exe` retrouve l’installation C++ réelle ; le script choisit une version numérique sous :

```text
VisualStudio/VC/Redist/MSVC/VERSION/x64/Microsoft.VC*.CRT/
VisualStudio/VC/Redist/MSVC/VERSION/x64/Microsoft.VC*.OpenMP/
```

Il copie les DLL de ces deux dossiers de **release**, dont `VCOMP140.dll`, `MSVCP140.dll`, `VCRUNTIME140.dll` et `VCRUNTIME140_1.dll`. Les autres DLL du même CRT sont conservées pour leurs dépendances transitives. Chaque fichier doit être un PE x64 et présenter une signature Authenticode Microsoft valide. Aucun repli vers System32, les dossiers de débogage ou un site de téléchargement tiers n’est accepté.

Les DLL sont copiées à côté du module `.node` pour les tests avant conditionnement, ainsi que dans `build/runtime/win32-x64/`. `win.extraFiles` doit copier le contenu de ce dernier dossier dans le dossier de l’exécutable du paquet ZIP/NSIS :

```json
[{ "from": "build/runtime/win32-x64", "to": ".", "filter": ["**/*"] }]
```

La version des fichiers, leur provenance et leurs empreintes figurent dans `PROVENANCE.json`. La [licence officielle du runtime Visual C++ 2015–2022](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/) est conservée en DOCX, avec la [liste Microsoft des fichiers redistribuables](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution).

Selon la [documentation Microsoft de redistribution](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170), la redistribution de ces fichiers reste soumise aux droits Visual Studio applicables. Le fait qu’un runner les contienne ne prouve pas à lui seul que l’éditeur dispose de ces droits. Cette préparation technique ne certifie donc pas l’autorisation juridique de publier les DLL. La licence de l’éditeur et le fonctionnement des copies locales devront être confirmés avant diffusion publique. Les DLL sont conservées sans modification ; leurs correctifs futurs nécessiteront une nouvelle release de l’application.

## macOS

Les modules précompilés fournis par le paquet npm sont utilisés tels quels. `otool -L` doit ne montrer que `/usr/lib/` et `/System/Library/` ; une dépendance Homebrew externe provoque un échec explicite. La notice du paquet documente son OpenMP LLVM lié statiquement et conserve sa licence. Les notices d’origine LibRaw sont recopiées sans modification. Aucune bibliothèque système Apple n’est copiée dans le paquet.

## Traçabilité et limites

Chaque préparation conserve `build/runtime/OS-ARCH/PROVENANCE.json` et une copie près du `.node`, avec versions, SHA-256, contrôle du chargement natif et rapports de dépendances. La CI archive aussi les notices et manifestes comme artefacts de contrôle. `ATELIER_LIBGOMP_VERSION` et `ATELIER_MSVC_REDIST_VERSION` peuvent imposer une version déjà qualifiée ; une autre version fait échouer la préparation.

Les labels d’OS sont fixés, mais les images hébergées et les correctifs de sécurité évoluent. Le verrou npm, les versions et les empreintes rendent les entrées identifiables ; ils ne constituent pas une promesse de paquets bit pour bit identiques. `SOURCE_DATE_EPOCH` est repris du commit pour l’archive des sources. La [référence GitHub des runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) confirme les quatre labels utilisés.

Sur le Mac arm64 de développement, la préparation a chargé LibRaw 0.22.2, 1 258 appareils, Sharp 0.35.5 et libvips 8.18.7 sous Node et Electron 44.7.2. Les neuf tests RAW ont réussi dans le Node d’Electron. **Aucun runner Windows/Linux n’a été exécuté ici.** La présence du workflow n’atteste donc pas encore leur réussite, ni une installation sur machine propre, ni la signature/notarisation des installateurs.

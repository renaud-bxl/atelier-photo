# Distribution d’Atelier Photo

Le dépôt public [renaud-bxl/atelier-photo](https://github.com/renaud-bxl/atelier-photo) a été créé. Le dossier local `AtelierPhoto` constitue la racine prévue de ce dépôt. Lors de cette préparation, GitHub Pages n’est pas encore activé et aucune release binaire n’est disponible. Les workflows sont préparés pour les prochaines étapes ; leur présence ne prouve pas une publication ni une validation multiplateforme réussie. Aucun paiement PayPal n’a été réalisé.

## Page de présentation et don facultatif

`site/` est un site statique autonome, noir et bleu, signé Renaud. Il propose 0 €, 5 €, 10 €, 20 € ou un montant libre en euros avant le guide d’installation. Le choix initial est 0 €. Un montant libre égal à 0 € fonctionne aussi. Le bouton de continuation reste toujours disponible : aucun paiement, compte ni justificatif n’est exigé.

Un montant positif prépare un lien externe `https://www.paypal.com/donate` avec les paramètres `business=renaud2005@gmail.com`, `currency_code=EUR` et `amount` à deux décimales. Le visiteur décide de poursuivre sur PayPal dans un nouvel onglet. L’application n’envoie pas de paiement, n’utilise pas l’API PayPal, ne lit pas de statut de transaction et ne prétend pas vérifier un don. Le bénéficiaire affiché est exactement l’adresse indiquée par Renaud.

Les paramètres sont fondés sur les [variables officielles PayPal Payments Standard](https://developer.paypal.com/archive/paypal-payments-standard/integration-guide/Appx-websitestandard-htmlvariables) et le [guide officiel des dons](https://developer.paypal.com/sdk/donate/), consultés le 15 octobre 2026. PayPal documente `business` comme identifiant ou adresse confirmée d’un compte et `amount` comme montant de contribution. L’existence, la confirmation et l’éligibilité du compte destinataire n’ont pas été vérifiées. Avant une publication publique, le titulaire pourra contrôler le destinataire sur PayPal sans réaliser de transaction.

### Prévisualiser

Depuis la racine du projet, `python3 -m http.server 4174 --bind 127.0.0.1 --directory site` sert la page sur `http://127.0.0.1:4174`. Aucun service tiers, police distante, suivi de visiteur ou SDK de paiement n’est chargé. Un serveur statique est nécessaire pour charger `config.json` et les modules JavaScript ; l’ouverture directe en `file://` n’est pas le mode prévu.

### Configurer la publication plus tard

`site/config.json` contient volontairement `"repository": null`. La page affiche alors « Dépôt de publication à configurer » et présente uniquement les commandes locales réelles :

```text
npm ci --include=optional
npm start
```

Node.js 24 et npm doivent être installés. Ouvrir un terminal dans le dossier du projet et attendre la réussite de la première commande avant de lancer la seconde. `npm start` construit l’interface puis ouvre Electron.

Le dépôt existe désormais, mais conserver `repository: null` jusqu’à la publication effective d’une release stable contenant les binaires et les deux scripts d’installation. Après leur vérification, remplacer seulement cette valeur par `"renaud-bxl/atelier-photo"`. Une URL GitHub HTTPS du même format est aussi acceptée. Les identifiants malformés sont refusés. Les paramètres PayPal restent ceux du bénéficiaire explicitement choisi.

Avec un dépôt configuré, la page affiche les scripts de la dernière release ainsi qu’un lien vers cette release. Il faut donc publier les scripts **et** les binaires correspondants avant d’activer ce réglage pour éviter des liens de téléchargement inexistants. Définir le dépôt ne prouve pas qu’une version existe. Le parcours gratuit et les commandes locales restent accessibles pendant cette attente.

### Publication GitHub Pages à activer plus tard

`.github/workflows/pages.yml` publiera directement le seul dossier `site/`, sans construction de l’application, installation npm, générateur de site ni clé personnelle. Il se déclenche sur les modifications de `site/**` ou de ce workflow poussées dans `main`, et peut aussi être lancé manuellement depuis `main`. Il utilise l’environnement `github-pages`, les droits `contents: read`, `pages: write` et `id-token: write`, et laisse terminer un déploiement déjà commencé.

Les références vérifiées le 15 octobre 2026 sont [`checkout@v6`](https://github.com/actions/checkout/blob/v6/action.yml), [`configure-pages@v5`](https://github.com/actions/configure-pages/blob/v5/action.yml), [`upload-pages-artifact@v4`](https://github.com/actions/upload-pages-artifact/blob/v4/action.yml) et [`deploy-pages@v5`](https://github.com/actions/deploy-pages/blob/v5/action.yml). Le workflow suit le [mécanisme officiel des workflows Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Il n’emploie pas de jeton d’accès personnel : GitHub fournit les autorisations temporaires du job.

Après la réussite des contrôles de l’application, le propriétaire pourra ouvrir les réglages du dépôt, choisir **Pages → Build and deployment → Source → GitHub Actions**, puis lancer **Publish the Atelier Photo website** sur `main`. L’option `enablement: false` interdit au workflow d’activer Pages lui-même. Tant que Pages n’est pas configuré, une exécution s’arrêtera à cette étape sans publier de site. Aucun de ces réglages ni lancement n’a été effectué ici.

L’adresse de publication sera celle indiquée par le résultat du job Pages ; elle ne doit pas être présentée comme déjà accessible. Le site peut être publié avec les instructions depuis les sources pendant que `repository` reste `null`. Les liens d’installation binaire ne seront activés qu’après la première release complète. Le workflow Pages ne construit et ne publie aucune release de l’application.

## Installateurs

Les scripts exigent un dépôt GitHub public explicitement désigné. Ils ne tentent pas d’en deviner un et n’utilisent aucun jeton GitHub. Ils téléchargent la dernière release stable, sélectionnent un nom d’archive exact, lisent son empreinte dans `SHA256SUMS`, puis vérifient le fichier avant extraction ou installation. L’absence, l’ambiguïté ou l’échec d’une empreinte bloque l’installation.

La vérification SHA-256 contrôle l’intégrité par rapport aux empreintes de la même release ; elle ne remplace pas la signature du code ni la confiance accordée au dépôt. Une installation existante n’est pas écrasée : déplacer l’ancienne version avant de réinstaller. Les scripts ne lancent pas l’application automatiquement.

| Système | Artefact utilisé | Destination par défaut | Architecture préparée |
| --- | --- | --- | --- |
| macOS | `AtelierPhoto-VERSION-mac-ARCH.zip` | `~/Applications/Atelier Photo.app` | Apple Silicon arm64 et Intel x64 |
| Windows | `AtelierPhoto-VERSION-win-x64.zip` | `%LOCALAPPDATA%\Programs\Atelier Photo` | x64 |
| Linux | `AtelierPhoto-VERSION-linux-x64.AppImage` | `~/.local/opt/atelier-photo/AtelierPhoto.AppImage` | x64 |

### Mac et Linux

Après la première release stable, depuis la racine du projet, `bash scripts/install.sh --repo renaud-bxl/atelier-photo` accepte aussi `--destination /chemin/absolu`. `--help` explique son fonctionnement sans réseau. Il utilise `curl`, les outils SHA-256 du système et `ditto` sur Mac. Apple Silicon est détecté également lorsque le terminal fonctionne sous Rosetta. Linux ARM64 est refusé tant que ses builds ne sont pas validées.

Le script n’utilise ni `sudo`, ni suppression d’attributs de quarantaine, ni désactivation de Gatekeeper. L’AppImage reçoit uniquement les permissions d’exécution nécessaires. Les dépendances AppImage du système, notamment FUSE selon la distribution, restent à la charge de l’environnement Linux.

### Windows

Après la première release stable, depuis la racine du projet, `& .\scripts\install.ps1 -Repository 'renaud-bxl/atelier-photo'` utilise PowerShell 5.1 ou supérieur, HTTPS et `Get-FileHash`. Le paramètre `-Destination` permet un autre dossier utilisateur. Le choix ZIP évite tout installateur silencieux et n’exige pas de droits administrateur. Le workflow produit également un installateur NSIS `.exe` pour une installation manuelle ultérieure.

Aucune politique `ExecutionPolicy`, protection SmartScreen ou configuration de sécurité de la machine n’est désactivée. Si la politique actuelle interdit les scripts, l’archive ZIP peut être téléchargée et extraite manuellement après comparaison SHA-256. Windows ARM64 n’est pas annoncé comme validé.

## Construction et releases GitHub

`.github/workflows/release.yml` utilise quatre machines natives : `macos-15` arm64, `macos-15-intel` x64, `windows-2022` x64 et `ubuntu-22.04` x64. Ces labels sont établis par la [référence officielle GitHub des runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Les noms de fichier utilisent les [macros electron-builder v26](https://www.electron.build/v26/docs/file-patterns/) : `${os}` devient `mac`, `win` ou `linux`.

Chaque job exécute `npm ci --include=optional`, prépare les runtimes natifs et vérifie Sharp/LibRaw dans Node puis Electron, lance les tests, construit l’interface et produit les paquets avec `electron-builder --publish never`. Les dépendances natives optionnelles de sharp doivent figurer dans le verrou npm ; ne pas exclure les dépendances optionnelles lors d’une installation. Les builds natives évitent de réutiliser les binaires sharp d’une autre plateforme.

Un lancement manuel du workflow construit des artefacts de contrôle sans publier de release. Seul le push intentionnel d’un tag stable `vMAJEUR.MINEUR.CORRECTIF` correspondant à la version de `package.json` autorise le job final de publication. Tous les jobs doivent réussir. Le job d’assemblage ajoute `install.sh`, `install.ps1` et un `SHA256SUMS` commun aux paquets avant la création de la release. Le droit GitHub d’écriture n’est accordé qu’au job de publication.

La signature de distribution Apple/Windows et la notarisation ne sont pas configurées ; le paquet Mac local utilise une signature ad hoc. Les protections des systèmes peuvent donc empêcher ou signaler les premières builds téléchargées. Les scripts ne les contournent pas. L’application reste gratuite et le don facultatif ; ces choix ne constituent ni une signature de code ni une vérification du paiement. Avant une diffusion au public, vérifier les paquets, la signature souhaitée et le lancement sur chaque système ciblé. La présence du workflow ne constitue pas une validation déjà effectuée sous Windows ou Linux.

## Vérifications locales effectuées

La page a été vérifiée dans un navigateur sur des largeurs de 1 440 et 390 pixels : parcours gratuit, choix de 10 €, montant libre de 0 € et 12,50 €, montant invalide, trois onglets système, branche avec dépôt simulé, absence de débordement mobile et d’erreur JavaScript. Aucun lien PayPal n’a été ouvert. Les fonctions de génération de liens et de validation du dépôt ont été contrôlées hors ligne.

La syntaxe shell et le YAML des workflows ont été vérifiés localement. Les chemins Mac ZIP et Linux AppImage ont été exercés avec des téléchargements entièrement simulés dans un dossier temporaire ; une empreinte incorrecte bloque bien l’installation. PowerShell n’étant pas disponible sur ce Mac, le script Windows n’a pas été exécuté ni validé par son parseur natif. Les builds GitHub, le déploiement Pages et les installations sur de vraies machines Windows/Linux restent à exécuter après publication du code dans le dépôt.

Les bibliothèques RAW et les conditions d’embarquement des runtimes sont détaillées dans [NATIVE-RUNTIMES](NATIVE-RUNTIMES.md). La préparation génère leur provenance ; la CI teste également le chargement natif depuis les paquets. Ces étapes doivent encore être exécutées sur Windows/Linux.

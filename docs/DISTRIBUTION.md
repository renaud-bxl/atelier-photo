# Distribution d’Atelier Photo

Les fichiers sont prêts localement. Aucun dépôt GitHub n’a été créé et aucune page, release ou transaction PayPal n’a été publiée. Le dossier `AtelierPhoto` doit constituer la racine du futur dépôt.

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

Après la création effective du dépôt, remplacer seulement `repository` par son identifiant réel `propriétaire/dépôt`. Une URL GitHub HTTPS du même format est aussi acceptée. Les identifiants malformés sont refusés. Aucun nom de dépôt n’est supposé. Les paramètres PayPal restent ceux du bénéficiaire explicitement choisi.

Avec un dépôt valide, la page affiche les scripts de la dernière release ainsi qu’un lien vers cette release. Il faut donc publier les scripts **et** les binaires correspondants avant d’activer ce réglage. Définir le dépôt ne prouve pas qu’une version existe. Le dossier `site/` pourra être servi par GitHub Pages ou un autre hébergement statique lors de la future publication ; aucun déploiement n’est lancé ici.

## Installateurs

Les scripts exigent un dépôt GitHub public explicitement désigné. Ils ne tentent pas d’en deviner un et n’utilisent aucun jeton GitHub. Ils téléchargent la dernière release stable, sélectionnent un nom d’archive exact, lisent son empreinte dans `SHA256SUMS`, puis vérifient le fichier avant extraction ou installation. L’absence, l’ambiguïté ou l’échec d’une empreinte bloque l’installation.

La vérification SHA-256 contrôle l’intégrité par rapport aux empreintes de la même release ; elle ne remplace pas la signature du code ni la confiance accordée au dépôt. Une installation existante n’est pas écrasée : déplacer l’ancienne version avant de réinstaller. Les scripts ne lancent pas l’application automatiquement.

| Système | Artefact utilisé | Destination par défaut | Architecture préparée |
| --- | --- | --- | --- |
| macOS | `AtelierPhoto-VERSION-mac-ARCH.zip` | `~/Applications/Atelier Photo.app` | Apple Silicon arm64 et Intel x64 |
| Windows | `AtelierPhoto-VERSION-win-x64.zip` | `%LOCALAPPDATA%\Programs\Atelier Photo` | x64 |
| Linux | `AtelierPhoto-VERSION-linux-x64.AppImage` | `~/.local/opt/atelier-photo/AtelierPhoto.AppImage` | x64 |

### Mac et Linux

`bash scripts/install.sh --repo PROPRIETAIRE/DEPOT` accepte aussi `--destination /chemin/absolu`. `--help` explique son fonctionnement sans réseau. Il utilise `curl`, les outils SHA-256 du système et `ditto` sur Mac. Apple Silicon est détecté également lorsque le terminal fonctionne sous Rosetta. Linux ARM64 est refusé tant que ses builds ne sont pas validées.

Le script n’utilise ni `sudo`, ni suppression d’attributs de quarantaine, ni désactivation de Gatekeeper. L’AppImage reçoit uniquement les permissions d’exécution nécessaires. Les dépendances AppImage du système, notamment FUSE selon la distribution, restent à la charge de l’environnement Linux.

### Windows

`& .\scripts\install.ps1 -Repository 'PROPRIETAIRE/DEPOT'` utilise PowerShell 5.1 ou supérieur, HTTPS et `Get-FileHash`. Le paramètre `-Destination` permet un autre dossier utilisateur. Le choix ZIP évite tout installateur silencieux et n’exige pas de droits administrateur. Le workflow produit également un installateur NSIS `.exe` pour une installation manuelle ultérieure.

Aucune politique `ExecutionPolicy`, protection SmartScreen ou configuration de sécurité de la machine n’est désactivée. Si la politique actuelle interdit les scripts, l’archive ZIP peut être téléchargée et extraite manuellement après comparaison SHA-256. Windows ARM64 n’est pas annoncé comme validé.

## Construction et releases GitHub

`.github/workflows/release.yml` utilise quatre machines natives : `macos-15` arm64, `macos-15-intel` x64, `windows-2022` x64 et `ubuntu-22.04` x64. Ces labels sont établis par la [référence officielle GitHub des runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Les noms de fichier utilisent les [macros electron-builder v26](https://www.electron.build/v26/docs/file-patterns/) : `${os}` devient `mac`, `win` ou `linux`.

Chaque job exécute `npm ci --include=optional`, prépare les runtimes natifs et vérifie Sharp/LibRaw dans Node puis Electron, lance les tests, construit l’interface et produit les paquets avec `electron-builder --publish never`. Les dépendances natives optionnelles de sharp doivent figurer dans le verrou npm ; ne pas exclure les dépendances optionnelles lors d’une installation. Les builds natives évitent de réutiliser les binaires sharp d’une autre plateforme.

Un lancement manuel du workflow construit des artefacts de contrôle sans publier de release. Seul le push intentionnel d’un tag stable `vMAJEUR.MINEUR.CORRECTIF` correspondant à la version de `package.json` autorise le job final de publication. Tous les jobs doivent réussir. Le job d’assemblage ajoute `install.sh`, `install.ps1` et un `SHA256SUMS` commun aux paquets avant la création de la release. Le droit GitHub d’écriture n’est accordé qu’au job de publication.

La signature commerciale Apple/Windows et la notarisation ne sont pas configurées ; le paquet Mac local utilise une signature ad hoc. Les protections des systèmes peuvent donc empêcher ou signaler les premières builds téléchargées. Les scripts ne les contournent pas. Avant une diffusion au public, vérifier les paquets, la signature souhaitée et le lancement sur chaque système ciblé. La présence du workflow ne constitue pas une validation déjà effectuée sous Windows ou Linux.

## Vérifications locales effectuées

La page a été vérifiée dans un navigateur sur des largeurs de 1 440 et 390 pixels : parcours gratuit, choix de 10 €, montant libre de 0 € et 12,50 €, montant invalide, trois onglets système, branche avec dépôt simulé, absence de débordement mobile et d’erreur JavaScript. Aucun lien PayPal n’a été ouvert. Les fonctions de génération de liens et de validation du dépôt ont été contrôlées hors ligne.

La syntaxe shell et le YAML du workflow ont été vérifiés. Les chemins Mac ZIP et Linux AppImage ont été exercés avec des téléchargements entièrement simulés dans un dossier temporaire ; une empreinte incorrecte bloque bien l’installation. PowerShell n’étant pas disponible sur ce Mac, le script Windows n’a pas été exécuté ni validé par son parseur natif. Les builds GitHub et les installations sur de vraies machines Windows/Linux restent à exécuter après mise en place du dépôt.

Les bibliothèques RAW et les conditions d’embarquement des runtimes sont détaillées dans [NATIVE-RUNTIMES](NATIVE-RUNTIMES.md). La préparation génère leur provenance ; la CI teste également le chargement natif depuis les paquets. Ces étapes doivent encore être exécutées sur Windows/Linux.

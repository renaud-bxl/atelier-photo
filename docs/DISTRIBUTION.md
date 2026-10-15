# Distribution d’Atelier Photo

Le dépôt public [renaud-bxl/atelier-photo](https://github.com/renaud-bxl/atelier-photo), la [release 0.1.0](https://github.com/renaud-bxl/atelier-photo/releases/tag/v0.1.0) et la [page d’installation](https://renaud-bxl.github.io/atelier-photo/) sont accessibles. GitHub Pages publie le dossier `site/`. Les commandes utilisent les deux scripts de la release stable, qui contient huit paquets applicatifs, les sources natives Linux, ces scripts et `SHA256SUMS`, soit douze fichiers. Aucun paiement PayPal n’a été réalisé.

## Page de présentation et don facultatif

`site/` est un site statique autonome, noir et bleu, signé Renaud. Il propose 0 €, 5 €, 10 €, 20 € ou un montant libre en euros avant le guide d’installation. Le choix initial est 0 €. Un montant libre égal à 0 € fonctionne aussi. Le bouton de continuation reste toujours disponible : aucun paiement, compte ni justificatif n’est exigé.

Un montant positif prépare un lien externe `https://www.paypal.com/donate` avec les paramètres `business=renaud2005@gmail.com`, `currency_code=EUR` et `amount` à deux décimales. Le visiteur décide de poursuivre sur PayPal dans un nouvel onglet. L’application n’envoie pas de paiement, n’utilise pas l’API PayPal, ne lit pas de statut de transaction et ne prétend pas vérifier un don. Le bénéficiaire affiché est exactement l’adresse indiquée par Renaud.

Les paramètres sont fondés sur les [variables officielles PayPal Payments Standard](https://developer.paypal.com/archive/paypal-payments-standard/integration-guide/Appx-websitestandard-htmlvariables) et le [guide officiel des dons](https://developer.paypal.com/sdk/donate/), consultés le 15 octobre 2026. PayPal documente `business` comme identifiant ou adresse confirmée d’un compte et `amount` comme montant de contribution. L’existence, la confirmation et l’éligibilité du compte destinataire n’ont pas été vérifiées. Le titulaire peut contrôler le destinataire sur PayPal sans réaliser de transaction.

### Prévisualiser

Depuis la racine du projet, `python3 -m http.server 4174 --bind 127.0.0.1 --directory site` sert la page sur `http://127.0.0.1:4174`. Aucun service tiers, police distante, suivi de visiteur ou SDK de paiement n’est chargé. Un serveur statique est nécessaire pour charger `config.json` et les modules JavaScript ; l’ouverture directe en `file://` n’est pas le mode prévu.

### Configuration de la publication

`site/config.json` désigne `"repository": "renaud-bxl/atelier-photo"`. La page affiche les commandes de téléchargement des scripts de la dernière release stable et un lien vers les paquets et leurs empreintes. Cette valeur a été activée après la publication et la vérification des douze fichiers.

Pour un nouveau dépôt sans release, laisser `"repository": null`. La page affiche alors « Dépôt de publication à configurer » et présente les commandes locales :

```text
npm ci --include=optional
npm start
```

Node.js 24 et npm doivent être installés. Ouvrir un terminal dans le dossier du projet et attendre la réussite de la première commande avant de lancer la seconde. `npm start` construit l’interface puis ouvre Electron.

Conserver ce mode de secours jusqu’à la publication effective d’une release stable contenant les binaires et les deux scripts d’installation. Une URL GitHub HTTPS du même format est aussi acceptée comme valeur du dépôt. Les identifiants malformés sont refusés. Les paramètres PayPal restent ceux du bénéficiaire explicitement choisi.

Il faut publier les scripts **et** les binaires correspondants avant d’activer ce réglage pour éviter des liens de téléchargement inexistants. Définir le dépôt ne prouve pas qu’une version existe. Le parcours gratuit reste accessible dans les deux modes.

### Publication GitHub Pages

`.github/workflows/pages.yml` publie directement le seul dossier `site/`, sans construction de l’application, installation npm, générateur de site ni clé personnelle. Il se déclenche sur les modifications de `site/**` ou de ce workflow poussées dans `main`, et peut aussi être lancé manuellement depuis `main`. Il utilise l’environnement `github-pages`, les droits `contents: read`, `pages: write` et `id-token: write`, et laisse terminer un déploiement déjà commencé.

Les références vérifiées le 15 octobre 2026 sont [`checkout@v6`](https://github.com/actions/checkout/blob/v6/action.yml), [`configure-pages@v5`](https://github.com/actions/configure-pages/blob/v5/action.yml), [`upload-pages-artifact@v4`](https://github.com/actions/upload-pages-artifact/blob/v4/action.yml) et [`deploy-pages@v5`](https://github.com/actions/deploy-pages/blob/v5/action.yml). Le workflow suit le [mécanisme officiel des workflows Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Il n’emploie pas de jeton d’accès personnel : GitHub fournit les autorisations temporaires du job.

Le dépôt utilise **Pages → Build and deployment → Source → GitHub Actions**. L’option `enablement: false` interdit au workflow d’activer Pages lui-même ; l’activation initiale a été effectuée dans les réglages du dépôt. Le [déploiement du 15 octobre 2026](https://github.com/renaud-bxl/atelier-photo/actions/runs/38767260952) a réussi après cette activation et la page a répondu en HTTPS.

La page affiche maintenant les liens d’installation binaire. Le workflow Pages ne construit et ne publie aucune release de l’application.

## Installateurs

Les scripts exigent un dépôt GitHub public explicitement désigné. Ils ne tentent pas d’en deviner un et n’utilisent aucun jeton GitHub. Ils téléchargent la dernière release stable, sélectionnent un nom d’archive exact, lisent son empreinte dans `SHA256SUMS`, puis vérifient le fichier avant extraction ou installation. L’absence, l’ambiguïté ou l’échec d’une empreinte bloque l’installation.

La vérification SHA-256 contrôle l’intégrité par rapport aux empreintes de la même release ; elle ne remplace pas la signature du code ni la confiance accordée au dépôt. Une installation existante n’est pas écrasée : déplacer l’ancienne version avant de réinstaller. Les scripts ne lancent pas l’application automatiquement.

| Système | Artefact utilisé | Destination par défaut | Architecture préparée |
| --- | --- | --- | --- |
| macOS | `AtelierPhoto-VERSION-mac-ARCH.zip` | `~/Applications/Atelier Photo.app` | Apple Silicon arm64 et Intel x64 |
| Windows | `AtelierPhoto-VERSION-win-x64.zip` | `%LOCALAPPDATA%\Programs\Atelier Photo` | x64 |
| Linux | `AtelierPhoto-VERSION-linux-x86_64.AppImage` | `~/.local/opt/atelier-photo/AtelierPhoto.AppImage` | x64 |

### Mac et Linux

Depuis la racine du projet, `bash scripts/install.sh --repo renaud-bxl/atelier-photo` accepte aussi `--destination /chemin/absolu`. `--help` explique son fonctionnement sans réseau. Il utilise `curl`, les outils SHA-256 du système et `ditto` sur Mac. Apple Silicon est détecté également lorsque le terminal fonctionne sous Rosetta. Linux ARM64 est refusé tant que ses builds ne sont pas validées.

Le script n’utilise ni `sudo`, ni suppression d’attributs de quarantaine, ni désactivation de Gatekeeper. L’AppImage reçoit uniquement les permissions d’exécution nécessaires. Sur Linux x64, le script vérifie SSE4.2 à partir des indicateurs de chaque CPU dans `/proc/cpuinfo` avant tout téléchargement ; une incompatibilité connue bloque l’installation et une information absente reste annoncée comme inconnue. Les dépendances AppImage du système, notamment FUSE selon la distribution, restent à la charge de l’environnement Linux.

### Windows

Depuis la racine du projet, `& .\scripts\install.ps1 -Repository 'renaud-bxl/atelier-photo'` utilise PowerShell 5.1 ou supérieur, HTTPS et `Get-FileHash`. Le paramètre `-Destination` permet un autre dossier utilisateur. Le choix ZIP évite tout installateur silencieux et n’exige pas de droits administrateur. Un installateur NSIS `.exe` est aussi disponible pour une installation manuelle.

Aucune politique `ExecutionPolicy`, protection SmartScreen ou configuration de sécurité de la machine n’est désactivée. Si la politique actuelle interdit les scripts, l’archive ZIP peut être téléchargée et extraite manuellement après comparaison SHA-256. Windows ARM64 n’est pas annoncé comme validé.

## Construction et releases GitHub

`.github/workflows/release.yml` utilise quatre machines natives : `macos-15` arm64, `macos-15-intel` x64, `windows-2022` x64 et `ubuntu-22.04` x64. Ces labels sont établis par la [référence officielle GitHub des runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Les noms de fichier utilisent les [macros electron-builder v26](https://www.electron.build/v26/docs/file-patterns/) : `${os}` devient `mac`, `win` ou `linux`.

Chaque job exécute `npm ci --include=optional`, prépare les runtimes natifs et vérifie Sharp/LibRaw dans Node puis Electron, lance les tests, construit l’interface et produit les paquets avec `electron-builder --publish never`. Les dépendances natives optionnelles de sharp doivent figurer dans le verrou npm ; ne pas exclure les dépendances optionnelles lors d’une installation. Les builds natives évitent de réutiliser les binaires sharp d’une autre plateforme.

Un lancement manuel du workflow construit des artefacts de contrôle sans publier de release. Seul le push intentionnel d’un tag stable `vMAJEUR.MINEUR.CORRECTIF` correspondant à la version de `package.json` autorise le job final de publication. Tous les jobs doivent réussir. Le job d’assemblage ajoute `install.sh`, `install.ps1` et un `SHA256SUMS` commun aux paquets avant la création de la release. Le droit GitHub d’écriture n’est accordé qu’au job de publication.

La première release a été publiée en promouvant exactement l’artefact final du [run validé 38772928683](https://github.com/renaud-bxl/atelier-photo/actions/runs/38772928683), sans reconstruire les binaires. Le tag `v0.1.0` désigne son code testé `eec5b9157332812b23ddeadb760529862eb6dc6d`. Le digest SHA-256 du ZIP de cet artefact est `40bdaee8c0331da80cd7d27748725593bb60fba846247550d74e6f5284ad5e49` ; son inventaire, les onze empreintes de `SHA256SUMS` et les deux scripts identiques à ce commit ont été contrôlés avant publication.

La création de ce tag par GitHub a déclenché une seconde construction du même code. Cette reconstruction redondante a été annulée après la vérification publique de la release ; les paquets distribués restent ceux du run complet réussi ci-dessus. Les douze empreintes publiées par GitHub correspondent aux fichiers vérifiés, et les deux scripts ainsi que `SHA256SUMS` ont été téléchargés anonymement par leurs liens de dernière version stable.

La signature de distribution Apple/Windows et la notarisation ne sont pas configurées ; le paquet Mac utilise une signature ad hoc. Les protections des systèmes peuvent donc empêcher ou signaler les builds téléchargées. Les scripts ne les contournent pas. L’application reste gratuite et le don facultatif ; ces choix ne constituent ni une signature de code ni une vérification du paiement. Les tests sur les runners ciblés ne couvrent pas tous les ordinateurs, systèmes ou pilotes.

## Vérifications locales effectuées

La page a été vérifiée dans un navigateur sur des largeurs de 1 440 et 390 pixels : parcours gratuit, choix de 10 €, montant libre de 0 € et 12,50 €, montant invalide, trois onglets système, branche avec dépôt simulé, absence de débordement mobile et d’erreur JavaScript. Aucun lien PayPal n’a été ouvert. Les fonctions de génération de liens et de validation du dépôt ont été contrôlées hors ligne.

La syntaxe shell et le YAML des workflows ont été vérifiés localement. Les chemins Mac ZIP et Linux AppImage ont été exercés avec des téléchargements entièrement simulés dans un dossier temporaire ; une empreinte incorrecte bloque bien l’installation. La page HTTPS publique a aussi passé le parcours à 0 €, les trois onglets, les montants facultatifs et la largeur mobile, sans erreur JavaScript ni ouverture de PayPal.

Le [run multiplateforme du 15 octobre 2026](https://github.com/renaud-bxl/atelier-photo/actions/runs/38772928683) a réussi les quatre jobs natifs. Sous Windows, le vrai ZIP et l’installation NSIS ont importé un DNG et exporté un TIFF16 ; les trois DLL CRT et OpenMP chargées provenaient du paquet. Le script Terminal a été exécuté par PowerShell 5.1 avec le vrai ZIP et uniquement les téléchargements simulés : succès, empreinte incorrecte et préservation d’une destination existante. Aucun appel payant ni poids local n’a été utilisé.

Sous Linux, le lanceur de l’AppImage extraite est comparé octet par octet au lanceur révisé ; ses commandes ne désactivent pas la sandbox. Le DEB est installé, testé puis désinstallé sur le runner éphémère. Le RAW et l’export TIFF16 sont réels. Le test IA sous Xvfb contrôle explicitement les deux contextes WebGL indisponibles, leur affichage dans le diagnostic, le refus clair de la détection et la neutralisation des neuf réglages portrait, puis un vrai export PNG16. Son résultat porte `faceDetection: unavailable_graphics` et `detectedFaces: null` : il ne constitue pas un test réussi de MediaPipe sur un GPU Linux. Le test ordinaire sur Mac/Windows exige au contraire une détection MediaPipe réelle sur la mire. Aucun drapeau ne force une fonction graphique bloquée ou ne désactive la sandbox.

Les bibliothèques RAW et les conditions d’embarquement des runtimes sont détaillées dans [NATIVE-RUNTIMES](NATIVE-RUNTIMES.md). La préparation génère leur provenance et les sources Linux correspondantes ; les preuves fonctionnelles synthétiques sont conservées dans les artefacts GitHub pendant 14 jours. Les modèles Ollama/ComfyUI sur de vraies photos et leurs performances sur les autres ordinateurs restent des validations séparées.

# IA locale facultative — revue préalable à publication

Intégration ultérieure : voir [le guide actuel](LOCAL-AI.md).

Revue du 15 octobre 2026. Sources primaires uniquement ; aucun modèle installé ou téléchargé, aucune photo transmise, aucune inférence effectuée dans cette revue. Les recommandations matérielles ci-dessous sont des **estimations d’ingénierie**, pas des mesures de performances ni des minima officiels.

## Choix recommandé

Ajouter un fournisseur « Ollama — local, sans frais par appel », facultatif, pour **analyser une vignette et proposer les réglages existants**. Le moteur d’Atelier Photo applique ensuite réellement les couleurs et les neuf contrôles portrait à la source en 16 bits. Le JPEG d’analyse n’est jamais la nouvelle source. Sans installation, sans matériel suffisant ou en cas d’échec du modèle, les outils manuels restent utilisables.

Commencer par Qwen3-VL **Instruct** en Q4_K_M, avec trois choix selon le diagnostic : 2B, 4B, 8B. La carte de Qwen décrit une entrée image + texte et une sortie texte, sous Apache 2.0 ; elle ne démontre pas une expertise de retouche photographique. Les benchmarks de compréhension visuelle ne prouvent donc ni la qualité esthétique des réglages, ni une durée de traitement sur l’ordinateur du client. [Carte officielle Qwen 2B](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct), [Qwen 4B](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct), [Qwen 8B](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct).

Ce chemin ne sait pas supprimer un objet, reconstruire un décor ou agrandir une image en inventant des pixels. Ce sont les limites du **modèle et du protocole retenus**, pas une impossibilité générale d’Ollama : son annonce du 20 janvier 2026 décrit une génération d’images expérimentale sur macOS, avec Windows/Linux annoncés ultérieurement. Un fournisseur génératif local constituerait une fonction séparée, avec ses modèles, besoins et validations propres. [Annonce officielle](https://ollama.com/blog/image-generation).

## Modèles et licences

Tailles décimales affichées par le registre au jour de la revue ; elles correspondent au téléchargement et ne sont pas la RAM/VRAM requise. Les tags peuvent changer : enregistrer le digest complet renvoyé par `/api/tags`, la version d’Ollama et la quantification lors d’une validation.

| Choix | Téléchargement | Quantification | Usage proposé |
| --- | ---: | --- | --- |
| `qwen3-vl:2b-instruct` | 1,9 GB | Q4_K_M | Option sobre ; vérifier la pertinence et les refus de schéma |
| `qwen3-vl:4b-instruct` | 3,3 GB | Q4_K_M | Défaut proposé sur une configuration intermédiaire |
| `qwen3-vl:8b-instruct` | 6,1 GB | Q4_K_M | Option plus lourde, après diagnostic et essai |
| `qwen3-vl:4b-instruct-q8_0` | 5,1 GB | Q8_0 | Option experte, après comparaison de qualité mesurée |
| `qwen3-vl:8b-instruct-q8_0` | 9,8 GB | Q8_0 | Option experte pour mémoire abondante |

Les trois Instruct Q4 sont proposés sous Apache 2.0 ; la famille nécessite Ollama **0.12.7 au minimum**, mais ce plancher de chargement n’est pas une garantie pour toutes les versions et plateformes ultérieures. Au contrôle, les préfixes de digest sont `ea422f1e7365` (2B Instruct), `ee4b975b58c1` (4B), `0533d74300e4` (8B). Ne pas remplacer le premier par l’alias `:2b`, dont le digest observé diffère. [Registre 2B Instruct](https://ollama.com/library/qwen3-vl:2b-instruct), [4B Instruct](https://ollama.com/library/qwen3-vl:4b-instruct), [8B Instruct](https://ollama.com/library/qwen3-vl:8b-instruct), [4B Q8](https://ollama.com/library/qwen3-vl:4b-instruct-q8_0), [8B Q8](https://ollama.com/library/qwen3-vl:8b-instruct-q8_0).

**Google est une alternative à évaluer, pas le premier téléchargement.** Gemma 4 E2B/E4B est multimodal avec sortie texte et poids Apache 2.0. « E4B » désigne les paramètres effectifs : la carte indique environ 8 milliards avec embeddings ; E2B environ 5,1 milliards. Ce nom ne signifie donc pas un encombrement égal à celui de Qwen 2B/4B. Le tag Ollama `gemma4:e4b` présente actuellement plusieurs runtimes : llama.cpp Q4 à 6,6 GB et MLX à 9,5 GB. Éviter ce tag flottant dans une promesse portable ; choisir un artefact explicite après tests. Ne pas attribuer automatiquement la licence de Gemma 4 aux générations Gemma précédentes. [Carte Google](https://huggingface.co/google/gemma-4-E4B-it), [Registre E4B](https://ollama.com/library/gemma4:e4b), [Registre E2B](https://ollama.com/library/gemma4:e2b).

**Meta n’est pas recommandé par défaut.** Llama 3.2 Vision existe en 11B/90B, avec licence spécifique ; la politique comporte une restriction pour les titulaires domiciliés dans l’UE et une exception pour les utilisateurs finaux d’un produit intégrant le modèle. Il serait inexact d’en déduire une interdiction générale de tout usage européen. Sa carte limite en outre le support officiel image + texte à l’anglais. Ce choix ajoute ici des contraintes inutiles. Un Llama textuel « 8B » n’acquiert pas la vision par sa taille. [Carte et conditions Meta](https://huggingface.co/meta-llama/Llama-3.2-11B-Vision-Instruct).

Le code d’Ollama est MIT ; les poids restent soumis à leurs propres licences. Conserver les notices et conditions si l’application redistribue un runtime ou des poids. Télécharger à la demande évite de gonfler chaque installateur d’Atelier Photo. « Gratuit » signifie absence de tarif API par appel pour l’inférence locale ; stockage, électricité, matériel et temps restent nécessaires. [Licence du runtime](https://raw.githubusercontent.com/ollama/ollama/main/LICENSE).

## Diagnostic avant installation et téléchargement

Les trois systèmes doivent être considérés séparément. Ollama documente macOS 14+, Apple Silicon accéléré et Mac x86 en CPU seul ; Windows 10 22H2+ ; Linux propose notamment des paquets amd64 et ARM64. L’existence d’un paquet ARM64 ne prouve pas l’accélération de toutes les puces ARM. Le pilote et le GPU déterminent le backend utilisable. Ne pas recopier une liste figée de cartes dans l’application : fournir le lien officiel et afficher le résultat constaté. [macOS](https://docs.ollama.com/macos), [Windows](https://docs.ollama.com/windows), [Linux](https://docs.ollama.com/linux), [GPU et pilotes](https://docs.ollama.com/gpu).

Afficher avant toute installation/pull :

- Système/version/architecture, modèle CPU, RAM physique ; mémoire disponible quand elle est mesurable avec une méthode adaptée au système. La mémoire libre brute de Node sur macOS n’est pas toute la mémoire récupérable. Une valeur inconnue reste inconnue.
- Nom des GPU, backend/pilote détecté, VRAM dédiée totale/disponible lorsque fiable. Un GPU présent n’est pas la preuve de son utilisation par Ollama. Ne pas utiliser le seul nombre de cœurs CPU pour prédire une durée.
- Sur Apple Silicon, **RAM et mémoire GPU sont un même budget unifié** : ne pas les additionner. Sur PC, distinguer VRAM dédiée et mémoire partagée de l’iGPU ; cette dernière consomme aussi la RAM système.
- Espace disponible sur le **volume où Ollama stocke effectivement les modèles**, ainsi que sur celui de l’installateur si différent. Ne pas mesurer seulement le dossier courant d’Atelier Photo. `OLLAMA_MODELS` peut changer ce lieu ; l’environnement du service peut différer de celui de l’application.
- Version/réponse du serveur local, modèles déjà installés et modèle sélectionné. Réutiliser un modèle existant seulement après contrôle de ses capacités.

Les outils système déjà disponibles peuvent compléter le diagnostic (par exemple `nvidia-smi`), avec lancement direct, arguments fixes, délai et sortie bornés ; ne pas installer des outils de diagnostic ou pilotes en arrière-plan. Si aucune mesure VRAM fiable n’est accessible, proposer le mode prudent puis le vérifier par essai, sans afficher une compatibilité garantie.

| Profil indicatif | Premier essai conseillé | Analyse / contexte | Formulation honnête |
| --- | --- | --- | --- |
| Moins de 8 GiB RAM, OS non pris en charge, espace insuffisant | Aucun téléchargement automatique | — | « Installation déconseillée / prérequis à résoudre » |
| 8 à moins de 16 GiB RAM | 2B Instruct Q4 | Image ≤768 px ; `num_ctx:4096` | « Essai possible ; mémoire serrée, CPU potentiellement lent » |
| 16 à moins de 24 GiB RAM | 4B Instruct Q4 | Image ≤1024 px ; contexte 4096, éventuellement 8192 après essai | « Choix prudent à vérifier » |
| 24 GiB RAM et plus | 8B Instruct Q4, ou 4B pour la rapidité | Image ≤1400 px ; contexte 8192 | « Plus de marge ; performances à mesurer » |

Ces bornes RAM sont une politique conservatrice proposée, **pas des seuils universels**. Un GPU dédié de 10–12 GiB donne une marge estimée pour le 8B Q4 ; 8 GiB peut fonctionner selon le contexte et le partage CPU/GPU, sans garantie. Une grosse VRAM n’autorise pas à ignorer une RAM système faible. À l’inverse, sans GPU pris en charge, l’analyse de réglages peut fonctionner sur CPU si le runtime et la mémoire le permettent ; il faut mesurer la durée, et permettre l’annulation.

Le contexte, l’encodeur d’image, les buffers et le cache s’ajoutent aux poids. Limiter explicitement le contexte : le maximum annoncé par un modèle n’est pas une cible pour un petit JSON. La quantification **Q4/Q8 des poids** est distincte de celle du cache KV et de la précision **16 bits de la photo**. Aucune de ces options ne garantit une qualité esthétique supérieure. [Gestion du contexte](https://docs.ollama.com/context-length).

Réserve disque proposée : au moins `max(2 × taille téléchargée, taille téléchargée + 4 GiB)` sur le volume des modèles, en plus du runtime. C’est une marge applicative pour téléchargement/mises à jour, pas une exigence officielle. Le runtime Windows annonce au moins 4 GB d’espace d’installation. Si la destination des modèles n’est pas déterminable, le diagnostic doit le dire avant de lancer un gros transfert. [Installation Windows](https://docs.ollama.com/windows).

Le benchmark existant d’Atelier Photo a mesuré environ **4 GiB de RSS maximum pour un export 45 MP** sur une seule machine ; il ne mesure pas Ollama et n’est pas une garantie sur les autres systèmes. Prévoir les exports et inférences séquentiellement sur les petits profils et décharger le modèle avant un gros export. [Mesure du moteur](PERFORMANCE.md).

## Installation et progression : parcours minimum solide

1. Diagnostic lisible et choix du modèle avant téléchargement. « Installer Ollama » ouvre le téléchargement/document officiel du système ; pas d’exécution silencieuse de script distant ou d’installation privilégiée depuis le renderer. macOS utilise l’application officielle, Windows son installateur utilisateur ; Linux suit la procédure officielle. Une intégration d’installateur automatique nécessiterait son propre suivi d’erreurs et de fin d’installation.
2. « Vérifier Ollama » interroge le serveur local et sa version. Distinguer « non installé », « installé mais arrêté », « répond mais trop ancien » et « erreur ». Une réponse à `/api/version` ne prouve pas encore que le modèle vision fonctionne.
3. Lister `/api/tags`, puis télécharger seulement un modèle local de la liste autorisée via `/api/pull` en streaming. Afficher statut, octets terminés/total **par digest** ; ne pas compter plusieurs fois les mises à jour du même blob. Ne pas inventer un pourcentage durant les phases sans total. Gérer les lignes NDJSON coupées entre paquets, les erreurs dans un HTTP 200, les erreurs disque et l’annulation.
4. Après succès final, relire tags/digest et `/api/show`. Exiger la capacité `vision`, pas une sous-chaîne dans le nom. Une annulation ne signifie pas que les fichiers partiels sont nettoyés ; ne pas annoncer une suppression ni une reprise garanties sans les avoir vérifiées sur la version ciblée.
5. Faire une petite inférence locale sur une image synthétique non privée, valider le schéma, puis afficher la durée de chargement et la durée de réponse. `/api/ps` permet de constater placement VRAM/contexte du modèle chargé. Afficher « vérifié sur cette machine » seulement après cet essai. Ce résultat ne prouve pas encore la pertinence photographique.

Contrats primaires : [version](https://docs.ollama.com/api-reference/get-version), [modèles installés](https://docs.ollama.com/api/tags), [détails/capacités](https://docs.ollama.com/api-reference/show-model-details), [modèles chargés](https://docs.ollama.com/api/ps), [pull](https://docs.ollama.com/api/pull), [types officiels PullRequest/ProgressResponse](https://raw.githubusercontent.com/ollama/ollama/main/api/types.go).

## Contrat d’analyse et sécurité

Implémenter un module local distinct, limité à une adresse constante telle que `http://127.0.0.1:11434`. Refuser les redirections et les hôtes arbitraires transmis par le renderer ; ne pas hériter d’un proxy ou d’un `OLLAMA_HOST` distant sans parcours distinct. Ne pas mélanger ces appels avec les clés BYOK. Une boucle locale ne suffit pas à exclure le cloud : n’autoriser que les modèles locaux sélectionnés, refuser les variantes `-cloud` et vérifier les détails du modèle plutôt que le suffixe seul.

Le code officiel actuel expose exactement `remote_model` et `remote_host` dans les résultats de `/api/tags`, `/api/show` et `/api/chat`. Rejeter **avant l’envoi de l’image** si l’un des deux est non vide dans tags/show ; revérifier show à l’usage. Rejeter aussi une réponse chat distante, bien que ce contrôle tardif ne puisse annuler un envoi. Le routage serveur utilise ces champs pour joindre un amont : un modèle distant renommé sans suffixe `-cloud` est donc un cas de test nécessaire. `/api/show` expose également `requires` pour une éventuelle exigence de version. Ces champs actuels ne prouvent pas leur présence dans chaque ancienne version ; maintenir l’allowlist et valider la version supportée. [Structures API](https://raw.githubusercontent.com/ollama/ollama/main/api/types.go), [Routage serveur](https://raw.githubusercontent.com/ollama/ollama/main/server/routes.go).

Ollama distingue calcul local et cloud. Sa FAQ documente `OLLAMA_NO_CLOUD=1` ou `disable_ollama_cloud:true` dans sa configuration serveur pour désactiver ses fonctions cloud. L’application doit expliquer le réglage et vérifier son propre comportement, sans modifier silencieusement un serveur partagé. Les téléchargements nécessitent Internet ; le traitement peut ensuite rester local. Ne pas journaliser image, base64, consigne ou réponse intégrale. [Confidentialité et configuration](https://docs.ollama.com/faq).

Utiliser `POST /api/chat`, `stream:false`, `messages` avec une image préparée en **base64 brut** dans `images`, et `format` contenant un véritable JSON Schema. Retirer EXIF/GPS/XMP, limiter pixels et octets avant encodage. Ne jamais passer une URL distante ou un chemin choisi par le modèle. Réutiliser les valeurs absolues du contrat moteur, une explication courte dans la langue choisie, et la protection contre les instructions visibles dans l’image. La vision REST accepte le base64 ; les sorties structurées savent contraindre la forme avec un schéma, qui doit aussi être validé côté client. [Vision](https://docs.ollama.com/capabilities/vision), [JSON Schema](https://docs.ollama.com/capabilities/structured-outputs).

Politique proposée : température 0 pour ce contrat court, `num_predict` borné (par exemple 1200), contexte bas, une seule requête à la fois et aucun outil exécutable. La température 0 suit le conseil de déterminisme d’Ollama ; elle ne garantit ni justesse ni identité entre versions, et diffère des réglages génériques de génération recommandés dans certaines cartes de modèles. Éviter les variantes Thinking ; ne pas ajouter un paramètre `think` non pris en charge. Réponse obligatoire : `done:true`, contenu final non vide, absence d’erreur et de troncature ; parser `message.content`, pas le raisonnement. Délai et annulation doivent laisser l’interface utilisable sur CPU. `keep_alive:0` permet de décharger après la réponse ; garder chaud un modèle pendant un lot est un choix distinct selon le budget mémoire. Les durées renvoyées sont en nanosecondes. [API chat](https://docs.ollama.com/api/chat).

Le schéma doit partager les bornes canoniques du moteur, avec toutes les propriétés attendues et `additionalProperties:false`. Rejeter types incorrects, nombres non finis, réponses tronquées, clés inconnues et valeurs incohérentes ; si un bornage des valeurs est conservé pour compatibilité, le documenter et compter ces corrections au benchmark. Un JSON syntaxiquement valide peut proposer un portrait sur un paysage ou une correction destructrice : garder les contrôles portrait neutres sans visage pertinent et la géométrie neutre sauf demande explicite. Ne pas prétendre mesurer des Kelvin à partir d’un aperçu.

Les neuf contrôles portrait visés sont `skinSmoothing`, `faceLight`, `teethWhitening`, `eyeBrightness`, `blemishReduction`, `skinEvenness`, `underEyeLight`, `eyeContrast`, `lipSaturation`. Une compréhension linguistique de ces contrôles ne démontre pas une segmentation précise des yeux ou des dents : les limites du masque/moteur existant subsistent. Une vignette ne permet pas d’évaluer des défauts fins à 100 %. L’utilisateur doit pouvoir prévisualiser, atténuer et annuler ; le modèle ne doit pas exécuter du code ou modifier directement des fichiers.

## Risques constatés dans l’intégration existante au moment de la revue

| Priorité | Constat / preuve dans le dépôt | Correction requise |
| --- | --- | --- |
| P0 | `desktop/ai-service.mjs:6` et `desktop/main.mjs:36` n’acceptent que les trois fournisseurs à clé. Les handlers `main.mjs:449` et `:476` rejettent l’absence de clé avant traitement. | Capacité explicite `requiresKey:false` pour le local dans les traitements individuel et lot. Aucune fausse clé ou branche de secours cloud. |
| P0 | `ai-service.mjs:200` impose une syntaxe d’identifiant qui refuse `:` ; un tag Ollama ne peut pas y être injecté directement. | Validation locale dédiée, choix autorisés et contrôle du modèle réellement installé. Ne pas assouplir les identifiants des fournisseurs distants inutilement. |
| P0 | Les opérations IA comprennent analyse, édition et agrandissement ; un simple quatrième nom de fournisseur ne démontre pas ces capacités. | Déclarer les capacités dans un fournisseur commun, désactiver et rejeter édition générative/agrandissement côté main et interface pour ce chemin JSON. |
| P1 | `parseRecommendation` accepte valeurs numériques en texte, ignore les clés inconnues et borne les valeurs ; l’exemple du prompt est abrégé alors que toutes les valeurs sont demandées. | Pour le local, schéma complet partagé et validation stricte ; tester qu’aucun résultat incomplet ne devient une réussite silencieuse. |
| P1 | `prepareImage` utilise 1400 px pour tous les profils et le délai distant est fixe. | Ajuster l’aperçu, le contexte, le délai et le déchargement au profil ; ne pas multiplier les modèles ou exports en mémoire sur le petit profil. |

Ces références décrivent l’état lu avant implémentation locale ; revérifier les lignes et le comportement après les modifications concurrentes. La présente revue n’atteste pas que le fournisseur local existe déjà.

## Conditions de validation avant publication

- Tests de protocole : serveur absent, version ancienne, modèle textuel refusé, modèle cloud refusé, mauvaise licence/quantification présentée sans confusion, réponse coupée, JSON hors bornes, dépassement de taille, timeout et annulation. Vérifier les erreurs HTTP 200 dans le flux pull et les paquets NDJSON fragmentés.
- Tests matériels simulés : RAM inconnue ou faible, iGPU partagé, Apple unifié, VRAM inconnue, serveur sur un autre volume, disque insuffisant. Les estimations ne doivent jamais se transformer en badge « compatible » sans essai.
- Au moins un **vrai aller-retour vision local** avant d’annoncer la fonction disponible : version + tag/digest + schéma accepté + contrôles appliqués + pixels modifiés + source inchangée. Sur une source synthétique 16 bits, vérifier encore plus de 256 niveaux après export, indépendamment de la quantification du LLM.
- Mesurer chargement froid puis deux réponses chaudes, temps total, RAM du serveur et de l’application, placement GPU/VRAM, contexte et taille d’image. Ne pas appeler le RSS d’Atelier Photo « mémoire IA totale » : le serveur Ollama est un autre processus. Refaire au moins un cas CPU, un Apple Silicon et un Windows/Linux GPU pris en charge avant une promesse spécifique à ces plateformes.
- Échantillon qualitatif non privé : portrait, paysage, nuit et photo déjà correcte ; noter fidélité à la consigne, erreurs sémantiques, retouches excessives et taux de schémas rejetés. Comparer 2B/4B/8B avant de présenter le 8B comme meilleur. Tester les douze langues et l’affichage RTL ; le support multilingue annoncé ne suffit pas.
- Vérifier hors connexion après téléchargement, sans clé API enregistrée, avec surveillance des destinations réseau du traitement. Aucune redirection vers une API distante en cas de panne. Confirmer lots séquentiels, progression exacte, annulation et déchargement avant export lourd.

État final de cette revue : **architecture et sources vérifiées ; performance, qualité photo et compatibilité universelle non démontrées**. L’intégration minimale proposée est utile et portable dans son protocole, sous réserve des contrôles et essais ci-dessus ; une génération locale de pixels reste une extension facultative séparée.

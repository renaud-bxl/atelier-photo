# IA : clés personnelles et capacités

Documentation officielle consultée le 15 octobre 2026. Aucun appel réel aux fournisseurs n’a été effectué pendant le développement et aucune clé développeur n’est intégrée à l’application.

## Utilisation

L’utilisateur choisit OpenAI, Gemini ou Claude et saisit sa propre clé. L’application chiffre les clés avec Electron safeStorage : Trousseau macOS, DPAPI Windows ou coffre sécurisé de la session Linux. Si le coffre est indisponible ou si Linux utilise le backend `basic_text`, la clé reste seulement en mémoire et n’est pas persistée. Les réglages de modèles et le catalogue ne contiennent aucune clé. Une clé peut être remplacée ou supprimée. Les noms de modèles restent modifiables : leur accès dépend du compte fournisseur et peut évoluer.

Une action IA envoie la photo préparée et la consigne directement au fournisseur sélectionné ; les frais éventuels sont ceux de ce compte. Les retouches et exports locaux fonctionnent sans clé. Les réglages proposés par l’IA sont des suggestions visuelles et ne reproduisent pas les modèles d’Evoto.

## Matrice des fonctions

| Fournisseur | Analyse de la photo et proposition de réglages | Nouvelle image modifiée |
| --- | --- | --- |
| OpenAI | Oui, modèle avec vision via Responses API | Oui, modèle GPT Image via Images Edits API |
| Gemini | Oui, modèle multimodal via Generate Content | Oui, modèle image compatible Generate Content |
| Claude | Oui, modèle avec vision via Messages API | Non ; l’application explique cette limite avant tout appel réseau |

L’analyse renvoie un objet JSON de réglages et une explication dans la langue sélectionnée. Ces réglages sont appliqués par le moteur photo local. L’édition générative renvoie une nouvelle image : elle peut modifier des détails, la résolution ou l’identité visuelle et ne garantit pas une conservation exacte des pixels. L’original doit rester disponible.

## Modèles conseillés pour les champs modifiables

Suggestions basées sur les capacités documentées au jour de consultation ; leur disponibilité n’a pas été vérifiée avec un compte utilisateur.

| Usage | OpenAI | Gemini | Claude |
| --- | --- | --- | --- |
| Analyse et réglages | `gpt-6-luna` | `gemini-3.8-flash` | `claude-sonnet-5-5` |
| Édition générative | `gpt-image-2.5-sunburst` | `gemini-3.1-flash-image` | Indisponible |

OpenAI documente l’entrée image de [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) et les modèles acceptés par [Images Edits](https://developers.openai.com/api/reference/resources/images/methods/edit). Gemini documente [3.8 Flash stable](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash/) pour l’analyse. [3.1 Flash Image stable](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image) reste un choix compatible avec [Generate Content image generation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation), l’API utilisée ici. La documentation Gemini plus récente présente également Nano Banana 2.1 avec une autre API, Interactions ; ce modèle n’est pas le choix par défaut de cette implémentation. Le [guide API Claude](https://platform.claude.com/docs/en/claude_api_primer) recense `claude-sonnet-5-5`.

## Contrat et formats implémentés

`model` désigne le modèle de la tâche courante dans le service ESM `desktop/ai-service.mjs`. L’interface fournit le champ analyse à `recommend` et le champ modèle image à `edit`. Aucune sélection silencieuse d’un autre modèle n’a lieu.

Le service prépare un JPEG pour l’analyse et une PNG pour l’édition, de 1 400 pixels au maximum sur le grand côté. Le processus principal fournit un aperçu local limité à 1 600 pixels. Le service applique l’orientation et retire les métadonnées EXIF/GPS. Il refuse une entrée dépassant 100 Mio, borne l’image préparée à 6 Mio pour l’analyse et 14 Mio pour l’édition, la réponse HTTP à 64 Mio et l’image décodée à 48 Mio. Ces bornes sont des choix de l’application, pas les limites maximales promises par les fournisseurs.

- OpenAI analyse : `POST https://api.openai.com/v1/responses`, contenu `input_image` avec URL de données base64 ; réponse JSON texte. Format décrit dans [Images and vision](https://developers.openai.com/api/docs/guides/images-vision).
- OpenAI édition : `POST https://api.openai.com/v1/images/edits`, tableau `images` avec `image_url` de données base64 ; résultat `data[].b64_json` et format PNG demandé. Aucun téléchargement depuis une URL renvoyée par un modèle.
- Gemini : `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, `inlineData` avec MIME et base64 ; analyse demandée en JSON, édition avec modalités texte et image. Seuls les blocs image finaux, hors pensées, sont considérés.
- Claude : `POST https://api.anthropic.com/v1/messages`, version `2023-06-01`, bloc image avec source base64, MIME JPEG et texte de consigne. Voir [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) et [Messages](https://platform.claude.com/docs/en/api/messages/create).

Le parseur accepte du JSON entouré d’un bloc Markdown. Les réglages absents gardent leur valeur neutre ; les nombres valides sont bornés par le normaliseur de réglages JavaScript. Une réponse sans réglage reconnu, un nombre non fini ou un booléen invalide échoue explicitement. Une image de réponse doit être décodable avant son importation.

## Confidentialité, erreurs et vérification

Les clés sont envoyées dans les en-têtes, jamais dans les paramètres d’URL. Les domaines HTTPS sont fixes. Les redirections sont refusées, les requêtes passent par `fetch` dans le processus principal Node, sans cookie de la fenêtre d’interface ni clé dans le renderer. Les corps d’erreur des fournisseurs ne sont jamais affichés ni journalisés. Les erreurs exposent seulement le fournisseur, le statut HTTP et une action utile : vérifier la clé, le modèle, l’accès, le crédit ou le quota. Le délai maximal de requête est de 180 secondes pour les deux opérations, avec annulation. Aucune relance automatique susceptible de doubler des frais.

Les tests Node couvrent hors ligne le parseur, les enveloppes des trois API, les sorties image simulées, les erreurs et l’annulation. La recommandation simple et par lot analyse l’original pour éviter d’appliquer deux fois des réglages déjà visibles. Les lots sont séquentiels et affichent leur nombre d’appels ; chaque recommandation réussie est appliquée localement. L’édition créative utilise l’aperçu retouché et crée un fichier distinct. Les appels réels, coûts, quotas, refus, accessibilité des modèles et qualité des résultats ne sont pas validés sans la clé personnelle et une action volontaire de l’utilisateur.

## Agrandissement

`desktop/outpainting.mjs` accepte des marges indépendantes gauche/droite/haut/bas de 0 à 100 % de l’axe source, arrondies au pixel. Le canevas est limité à 120 MP et 32 000 px par côté ; la source préparée en pleine définition ne doit pas dépasser 100 Mio. L’aperçu envoyé reste limité à 1 400 px. OpenAI reçoit un masque PNG aux mêmes dimensions, transparent sur les marges et opaque sur tout le rectangle original. Gemini reçoit les coordonnées et une demande de prolongement sémantique.

Le masque du modèle ne constitue pas une garantie de conservation. Après génération, l’application recopie donc les pixels RGBA16 du centre original, transparence comprise, sans fusion ni rééchantillonnage. Les bordures sont redimensionnées depuis le résultat distant : leur détail reste limité à celui de cette génération. Une nouvelle PNG16 est créée et l’original reste intact. Claude est refusé avant toute requête. Les tests simulés vérifient la copie exacte du centre, les masques, les limites et l’annulation ; aucun appel payant n’a été effectué.

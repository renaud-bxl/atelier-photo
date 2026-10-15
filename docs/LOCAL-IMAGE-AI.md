# IA photo entièrement locale : choix et contrat proposé

Intégration ultérieure : voir [le guide actuel](LOCAL-AI.md).

État de la recherche : **15 octobre 2026**. Documentation primaire consultée ; aucun poids téléchargé et aucune génération chronométrée pendant cette étude. Ce document propose l’intégration, il ne certifie pas un backend déjà installé.

## Choix recommandé

Conserver les retouches photo et le développement RAW dans le moteur local existant. Ajouter **Ollama + Qwen3-VL 2B quantifié** pour proposer des réglages à partir d’une photo, et **ComfyUI local + FLUX.2 klein 4B distillé** pour créer une variante ou de nouvelles bordures. La génération est une installation facultative, adaptée au matériel ; elle ne doit pas être présentée comme disponible sur toutes les machines capables d’ouvrir l’application.

Un petit PC peut donc utiliser la retouche locale, puis éventuellement l’analyse sur CPU, sans devoir télécharger un modèle de génération. Les configurations plus puissantes peuvent activer progressivement la génération, puis des modèles plus lourds. Le Mac M3 Pro 36 Go disponible sert uniquement de machine de QA parmi d’autres.

Ollama possède désormais une génération d’images expérimentale : son [annonce officielle](https://ollama.com/blog/image-generation) la décrit sur macOS, avec Windows/Linux et l’édition encore à venir. Cette source ne permet pas d’en faire notre backend d’édition multiplateforme. ComfyUI dispose déjà de workflows d’édition locaux pour les modèles retenus.

## Trois configurations de génération comparées

| Modèle | Usage pertinent | Licence des poids | Charge et compromis |
| --- | --- | --- | --- |
| **FLUX.2 klein 4B distillé** | Choix initial : modification par consigne, suppression/remplacement d’objets, références et variantes | Apache 2.0 | 4 étapes dans l’exemple BFL ; compromis temps/mémoire adapté à un premier backend. |
| **FLUX.2 klein Base 4B** | Option avancée pour comparer la souplesse d’édition, avec davantage d’étapes | Apache 2.0 | Plus lent ; ne pas en déduire une qualité systématiquement meilleure pour toute photo. |
| **Qwen-Image-Edit-2511** | Machines dotées de beaucoup de mémoire : cohérence des personnes, éclairage, changements de vue | Apache 2.0 | Modèle de diffusion de 20B ; l’exemple officiel utilise 40 étapes. Pipeline BF16 complet d’environ 57,7 Go sur disque. |

Sources : [carte FLUX klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B), [tableau BFL des variantes](https://github.com/black-forest-labs/flux2), [carte Qwen Edit 2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511), [fichiers Qwen](https://huggingface.co/Qwen/Qwen-Image-Edit-2511/tree/main).

Ne pas substituer automatiquement « le dernier Qwen » : **Qwen-Image-2.1** est publié sous une [licence Research non commerciale](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/LICENSE), différente de celle d’Edit-2511. Les FLUX klein **9B**, 9B Base et FLUX dev sont également sous [licence non commerciale](https://github.com/black-forest-labs/flux2/blob/main/model_licenses/LICENSE-FLUX-NON-COMMERICAL). Ils ne sont pas retenus pour un outil gratuit utilisable professionnellement et soutenu par des dons.

## Poids, disque, précision : compter tout le pipeline

Les tailles suivantes sont les tailles décimales affichées par les dépôts, et non des mesures de RAM ou de VRAM :

| Profil klein 4B | Diffusion | Encodeur de texte | VAE | Total de ces trois fichiers |
| --- | --- | --- | --- | --- |
| Compatible BF16, précision d’exécution à adapter au backend | 7,75 Go | 8,04 Go | 0,336 Go | **≈16,13 Go** |
| Diffusion FP8 + encodeur standard | 4,07 Go | 8,04 Go | 0,336 Go | **≈12,45 Go** |

Références des fichiers : [diffusion BF16](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/tree/main), [diffusion FP8](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/tree/main), [encodeur Comfy-Org](https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/blob/main/split_files/text_encoders/qwen_3_4b.safetensors), [VAE Comfy-Org](https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/tree/main/split_files/vae). Télécharger sélectivement les fichiers requis : le dépôt BF16 contient aussi une représentation Diffusers qui duplique des poids.

Des variantes plus compactes existent, notamment un [encodeur FP4 de 3,85 Go](https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/blob/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors) et un [klein Base NVFP4 de 2,49 Go](https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4b-nvfp4/tree/main). **« 4 bits » n’est pas un format universel** : NVFP4, GGUF, INT4 et leurs kernels ont des contraintes différentes. Un fichier plus petit peut être déquantifié en mémoire et demander davantage de RAM que sa taille sur disque. Ne pas promettre le même profil FP4/FP8 sur CPU, CUDA, ROCm et MPS.

Le [code de gestion mémoire ComfyUI](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/model_management.py) distingue notamment les capacités de conversion de MPS ; le profil portable de départ doit employer des fichiers BF16/FP16 avec un type d’exécution réellement supporté, puis tester les optimisations par matériel. GGUF ajoute normalement des nœuds supplémentaires à auditer ; il ne constitue pas le profil initial sans extensions.

## Profils matériels et diagnostic avant installation

Les chiffres de la colonne « orientation » ci-dessous sont **des budgets produit prudents à valider**, pas des minimums garantis publiés par les auteurs. Le diagnostic et un petit essai réel décident de l’activation.

| Machine détectée | Fonction proposée | Orientation initiale |
| --- | --- | --- |
| RAM très limitée, GPU non utilisable | Retouche existante ; aucune génération annoncée prête | Réduire les aperçus ; ne pas charger un modèle par défaut. |
| CPU, environ 8–16 Gio de RAM | Analyse visuelle légère Qwen3-VL 2B Q4 ; CPU possible mais plus lent | Aperçu 512 px, contexte court, une demande à la fois ; prévoir environ 6 Gio libres pour modèle/runtime/marge, à recalculer. |
| GPU 8–12 Gio avec RAM système suffisante | Analyse ; essai avancé de klein 4B compact avec déchargement CPU | Ne pas annoncer une compatibilité automatique à 8 Gio ; commencer à 512 px et mesurer la mémoire. |
| GPU dédié 16 Gio ou plus, RAM système autour de 32 Gio | Candidat raisonnable pour klein 4B distillé | Réserver environ 30 Gio de disque pour modèle, environnement et marge ; essai 512 puis 1024 px. |
| Apple Silicon, 24–36 Gio ou plus de mémoire unifiée | Candidat MPS pour klein 4B, sous réserve du test de kernels/mémoire | Profil BF16/FP16 approprié ; **mémoire GPU et RAM sont partagées**, ne pas les additionner. |
| CPU seul avec beaucoup de RAM, typiquement 32–64 Gio ou plus | Génération expérimentale possible avec ComfyUI `--cpu` | Latence élevée, parfois très élevée ; ne pas l’activer comme expérience normale sans mesure. FP32 peut fortement augmenter la mémoire. |
| GPU/RAM nettement plus importants | Qwen Edit 2511 facultatif | Ses poids BF16 seuls dépassent 57 Go ; prévoir un budget disque nettement supérieur, par exemple 90 Gio, et tester l’offload ou une quantification précisément identifiée. |

BFL présente des références qui ne doivent pas devenir une garantie universelle : sa [page klein](https://bfl.ai/models/flux-2-klein) donne environ **8,4 Go de VRAM et 1,2 s sur RTX 5090** pour la variante distillée, **9,2 Go et 17 s** pour Base ; la carte 4B indique aussi environ **13 Go de VRAM**. Les contextes d’exécution diffèrent. Aucun de ces temps ne prédit un Mac, une vieille carte, un CPU ou le démarrage à froid ; cette étude ne dispose pas de mesures locales équivalentes.

ComfyUI documente [Windows, Linux, Apple Silicon/MPS, NVIDIA/CUDA, AMD/ROCm, Intel/XPU et CPU](https://docs.comfy.org/installation/system_requirements). Le [guide manuel](https://docs.comfy.org/installation/manual_install) précise les distributions PyTorch adaptées. Détecter l’architecture exacte, l’OS, les pilotes et la disponibilité du backend PyTorch ; une carte « AMD » seule n’établit pas sa compatibilité ROCm. Les Mac Intel ne disposent pas du même parcours que les Mac Apple Silicon.

Le diagnostic doit relever RAM totale **et disponible**, mémoire du GPU sélectionné, mémoire unifiée, espace réellement libre, versions ComfyUI/PyTorch et modèles présents. Plusieurs cartes ne constituent pas automatiquement une seule grande VRAM. Puis exécuter une petite mire originale avec le profil choisi, noter durée à froid/à chaud et pic mémoire, vérifier une sortie décodable et l’annulation. Un échec mémoire propose une définition inférieure ou laisse la fonction indisponible ; il ne déclenche jamais un fournisseur distant.

## Analyse légère avec Ollama

Choix initial : [`qwen3-vl:2b-instruct`](https://ollama.com/library/qwen3-vl:2b-instruct), **Q4_K_M, 1,9 Go, Apache 2.0** ; les poids d’origine sont également [documentés par Qwen](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct). Ce modèle comprend une image et répond en texte ; il propose des réglages que notre moteur local applique. Il ne remplace pas un modèle de génération de pixels. Son adéquation à la retouche photo doit être évaluée sur nos propres cas.

Ollama fournit l’[analyse d’images](https://docs.ollama.com/capabilities/vision), le [format JSON ou JSON Schema et `keep_alive`](https://docs.ollama.com/api/chat), ainsi que [CPU/Metal et des GPU pris en charge](https://docs.ollama.com/gpu). Envoyer un aperçu nettoyé avec `messages[].images`, demander des réglages JSON, valider les bornes localement et conserver une explication française. Sur petite machine, limiter le contexte et décharger le modèle après l’analyse avant une génération ComfyUI.

Se connecter uniquement à la boucle locale ; refuser les modèles `-cloud`. Pour une instance gérée par l’application, utiliser `OLLAMA_NO_CLOUD=1` et `OLLAMA_HOST=127.0.0.1:11434`, conformément à la [FAQ officielle](https://docs.ollama.com/faq). Un serveur externe existant reste sous le contrôle de l’utilisateur : vérifier son modèle et sa configuration, sans prétendre avoir modifié ses paramètres.

## ComfyUI : contrat d’intégration proposé

Le service Python reste séparé du processus Electron. Une première version peut connecter un ComfyUI déjà installé et testé ; une installation accompagnée pourra ensuite créer un environnement privé et choisir les dépendances selon le matériel. Un bouton « Installer » doit afficher les vrais composants, licences, volume et destination, puis suivre le téléchargement et la vérification. Aucun bouton « Prêt » sans test effectif du backend et des fichiers nécessaires.

API applicative suggérée :

```js
diagnoseLocalImage({ port, profileId })
// -> { ready, device, availableMemory, missingFiles, missingNodes, reason }
editLocalImage({ imageData, instruction, profileId, seed, width, height, signal })
// -> Buffer PNG validé ; profileId choisi dans un catalogue livré avec l’application
```

1. **Transport local strict.** Port configurable borné ; hôte fixé à `127.0.0.1` ou à la boucle IPv6 explicite. Ne pas accepter d’URL distante, d’identifiants d’URL, de chemin de base ou de redirection. Utiliser un transport direct sans proxy ni résolution DNS arbitraire, par exemple `node:http` vers l’adresse littérale. Le renderer ne transmet qu’un identifiant de profil, une consigne et des valeurs bornées ; il ne reçoit aucun accès HTTP général.
2. **Reconnaissance.** Lire `GET /system_stats` et les seuls `GET /object_info/<classe>` nécessaires ; vérifier les types et noms des modèles. Le [contrat local ComfyUI](https://docs.comfy.org/development/comfyui-server/comms_routes) expose ensuite `POST /upload/image`, `POST /prompt`, `GET /history/<prompt_id>` et `GET /view`. Ne pas confondre ces routes avec les API Comfy Cloud authentifiées.
3. **Graphe maîtrisé.** Livrer un graphe **API** fixe, versionné et identifié par hash ; modifier uniquement texte, seed, dimensions et noms de fichiers validés. Le [template officiel klein distillé](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_flux2_klein_image_edit_4b_distilled.json) contient des sous-graphes d’interface : l’exporter une fois en API dépliée et l’auditer avant livraison, au lieu d’envoyer aveuglément ce JSON d’interface. Ses UUID de sous-graphes ne nécessitent pas à eux seuls des plugins tiers.
4. **Nœuds et fichiers.** Autoriser exclusivement les classes cœur réellement présentes dans le profil audité, notamment les loaders, `CLIPTextEncode`, `VAEEncode`, `ReferenceLatent`, l’échantillonnage klein, `VAEDecode` et la sortie. Aucun nœud Python/script/shell, URL, API payante ou gestionnaire d’extension. Modèles safetensors issus d’un manifeste fixé : dépôt, révision, chemin, taille, SHA-256 et licence par fichier. Aucun checkpoint Pickle fourni par un projet utilisateur.
5. **Instance gérée.** Démarrage avec arguments séparés, sans shell : `--listen 127.0.0.1`, port dédié, dossiers privés, `--disable-all-custom-nodes`, `--offline`, `--disable-metadata`, `--disable-auto-launch`. Ces [options existent dans le CLI](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/cli_args.py). Le mode offline bloque notamment les nœuds partenaires et les accès frontend externes ; il ne constitue pas à lui seul un pare-feu pour tout Python. Installer les dépendances à l’avance et tester une exécution réseau coupé.
6. **Tâche bornée.** Une génération à la fois ; image/masque PNG sans EXIF, au plus 1400 px et volume borné ; définition d’inférence initiale 512/1024 adaptée au profil. Polling borné sur le seul ID obtenu, limites de taille JSON/image et délai local configurable, par exemple 10 minutes au départ puis ajusté d’après mesure. Refuser les chemins absolus, `..`, sous-dossiers inattendus et URL dans la réponse ; récupérer uniquement la sortie du nœud prévu et de notre tâche, puis décoder/réencoder avec sharp.
7. **Annulation ciblée.** Les versions actuelles proposent `POST /api/jobs/<id>/cancel` dans le [serveur](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py). N’utiliser cette route qu’avec la version vérifiée. Sur anciennes versions, ne pas interrompre globalement un serveur partagé : suppression du seul ID en file et interruption ciblée seulement si le contrat de cette version est connu. Une instance privée simplifie cette garantie.

## Masques, bordures et changement de vue

Les modèles d’édition savent modifier une scène ; cela ne garantit pas une conservation exacte des zones qui devraient rester intactes. Pour des bordures ou une zone masquée, conserver la protection actuelle : générer une image candidate, puis **recomposer localement les échantillons originaux 16 bits** dans les régions protégées. La sémantique d’un masque ComfyUI doit être définie par le workflow retenu et testée ; ne pas supposer qu’elle est identique au masque alpha de l’API OpenAI.

Le workflow klein d’édition de référence n’établit pas à lui seul un inpainting masqué satisfaisant : valider séparément un graphe de masque/bordures avant d’activer cette capacité. Les vues nouvelles peuvent être demandées comme variantes génératives ; elles inventent les parties invisibles et n’équivalent pas à une reconstruction géométrique certaine. Une homographie locale corrige la perspective de la photo, sans produire ces parties cachées. Les exemples Qwen 2511 incluent des variations de point de vue, sans garantie de précision métrique.

La plupart de ces pipelines produisent des images affichables dont la précision n’est pas celle des pixels RAW originaux. Un conteneur PNG16 final ne transforme pas les bordures générées en détails capturés nativement à 16 bits. Conserver une nouvelle version, son modèle/seed et l’indication des régions générées ; ne jamais écraser l’original.

## Licences du code et distribution publique

| Élément | Licence vérifiée | Conséquence pratique |
| --- | --- | --- |
| [ComfyUI cœur](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE) | GPL v3 | Si redistribué, fournir licence, notices et sources correspondantes/accès requis ; ne pas l’annoncer MIT. |
| [Ollama](https://github.com/ollama/ollama/blob/main/LICENSE) | MIT | Conserver la licence et les attributions si redistribué. |
| [Implémentation BFL flux2](https://github.com/black-forest-labs/flux2/blob/main/LICENSE.md) | Apache 2.0 | Différencier cette licence du code et celle de chaque modèle. |
| [klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE.md), Base 4B, encodeur/VAE retenus | Apache 2.0 | Usage commercial permis avec les obligations de licence/notices ; aucun achat de licence modèle demandé par cette licence. |
| [Qwen-Image historique/code](https://github.com/QwenLM/Qwen-Image/blob/main/LICENSE), Edit-2511, Qwen3-VL 2B | Apache 2.0 | Conserver les versions exactes et leurs notices ; ne pas étendre cette conclusion à Qwen-Image-2.1. |

Le [README BFL](https://github.com/black-forest-labs/flux2) précise aussi qu’il publie le VAE FLUX.2 sous Apache 2.0 : préférer les composants du [repack klein Apache](https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b), plutôt que déduire leur licence du seul nom d’un dépôt `dev`. Les dépendances Python, les éventuels plugins et chaque quantification redistribuée ont leur propre inventaire. Les dons facultatifs ne dispensent pas des conditions des composants ; sélectionner les profils permissifs évite de faire dépendre l’usage professionnel d’une exception non commerciale.

Avant de présenter la fonction comme opérationnelle : fixer les manifestes et versions, tester l’installation/les arrêts/les erreurs sur Windows NVIDIA, Linux NVIDIA/AMD, Apple Silicon et CPU, mesurer mémoire/disque/durée, vérifier les régions protégées et exécuter sans réseau. **Aucun de ces essais de modèle n’a été effectué dans cette étude**, qui n’a téléchargé que de la documentation.

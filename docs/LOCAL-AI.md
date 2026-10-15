# Utiliser une IA sur son ordinateur

Le diagnostic concerne l’ordinateur où Atelier Photo est lancé : Mac, Windows ou Linux. Il ne dépend pas des caractéristiques de la machine qui a servi au développement. Une IA locale est facultative ; les retouches classiques, le RAW et les exports restent disponibles sans modèle ni clé API.

## Analyse et réglages avec Ollama

1. Ouvrir **Réglages IA → IA locale → Vérifier cet ordinateur**.
2. Vérifier le dossier de stockage indiqué. Si Ollama stocke les modèles sur un autre volume, choisir ce dossier pour mesurer le bon disque. Ce choix ne change pas les réglages d’Ollama. Le dossier par défaut est `~/.ollama/models`, ou `OLLAMA_MODELS` si cette variable est visible par Atelier Photo ; le service peut avoir une configuration différente.
3. Le bouton **Installer le moteur local** ouvre les instructions officielles correspondant au système. Installer et ouvrir Ollama, puis **Détecter les modèles**.
4. Télécharger un profil conseillé ou sélectionner un modèle vision local déjà présent. Aucun téléchargement ne démarre à l’ouverture de la carte.
5. **Tester ce modèle** utilise une image synthétique, vérifie une réponse JSON complète et affiche une durée. Ce test ne mesure pas la qualité esthétique sur de vraies photos.
6. Enregistrer, puis demander une proposition de réglages dans l’éditeur. Une proposition individuelle s’applique sur demande et reste annulable. L’analyse d’une sélection applique les réglages progressivement, une photo à la fois.

| Profil livré | Poids approximatifs à télécharger | RAM totale minimale retenue par l’application | RAM conseillée pour un premier essai |
| --- | ---: | ---: | ---: |
| Qwen3-VL Instruct 2B | 1,9 Go | 8 Gio | 16 Gio |
| Qwen3-VL Instruct 4B | 3,3 Go | 16 Gio | 24 Gio |
| Qwen3-VL Instruct 8B | 6,1 Go | 24 Gio | 32 Gio |

Ces budgets sont des **estimations prudentes de l’application**, pas des minima certifiés par le fabricant. Les téléchargements sont exprimés en Go décimaux ; la mémoire du tableau en Gio. Les poids sont en Q4_K_M sous Apache 2.0 ; les tags `-instruct` sont explicites. Ollama doit respecter la version requise par le modèle, avec un plancher de 0.12.7 pour ces profils.

Le budget disque réserve deux fois la taille estimée du téléchargement plus 1 Gio. L’espace disponible est recontrôlé avant une demande de téléchargement. La mémoire libre momentanée peut être basse alors que le système peut récupérer du cache : elle donne un avertissement, sans constituer seule un refus. Le CPU peut être utilisé sans GPU, avec une durée potentiellement longue. La présence d’une carte n’atteste pas son utilisation ; le résultat du service est affiché quand mesurable.

Sur Apple Silicon, RAM et mémoire graphique partagent le même budget. Sur PC, une VRAM dédiée fiable est affichée séparément, sans additionner plusieurs GPU. Une mesure inconnue reste inconnue et le diagnostic ne promet pas la compatibilité. Une version de système ou une architecture non prise en charge est signalée. La matrice de paquets Atelier Photo reste macOS ARM/Intel, Windows x64 et Linux x64.

Le modèle reçoit un JPEG d’analyse de 768 ou 1 024 px maximum, sans EXIF/GPS. Il renvoie des valeurs absolues validées ; le moteur photo applique les réglages à la source en 16 bits. Le JPEG n’est pas substitué au RAW. Le modèle est déchargé après chaque réponse pour libérer sa mémoire. Une petite image ne permet pas d’évaluer toutes les imperfections fines d’un portrait.

Une réponse JSON correcte peut néanmoins proposer de mauvais réglages. L’analyse locale conserve donc le cadrage, la rotation, le miroir et la perspective choisis par le photographe ; ces commandes restent manuelles. Les neuf contrôles portrait sont neutralisés lorsqu’aucun visage n’est détecté ou que la détection échoue. Une proposition individuelle reste à examiner avant application. Essayer le rendu sur une photo avant de lancer une grande sélection.

## Création de pixels avec ComfyUI

Le volet **Retouche générative locale** connecte un ComfyUI local déjà installé, avec le modèle **FLUX.2 Klein 4B Distilled**, l’encodeur `qwen_3_4b.safetensors` et le VAE `flux2-vae.safetensors`. Détecter la configuration, puis choisir chacun des trois fichiers proposés. Les autres familles et les workflows arbitraires ne sont pas acceptés. Les poids génératifs ne sont pas téléchargés automatiquement par Atelier Photo.

Cette fonction demande plus de ressources que l’analyse. Le budget initial est de 24 Gio RAM totale sans VRAM dédiée mesurée d’au moins 8 Gio, ou 16 Gio RAM avec cette VRAM. Le calcul ajoute les buffers nécessaires aux photos et au canevas : de grandes images peuvent exiger davantage. Ce sont encore des budgets d’ingénierie, non des garanties de vitesse ou de qualité. Les configurations FP8 sur Metal ne sont pas validées dans ce profil ; utiliser BF16.

**Configuration disponible** signifie que les composants et noms de modèles attendus sont présents. Cela n’atteste pas qu’une génération réelle a réussi. Le client utilise un graphe fixe avec 4 étapes, limite l’image de référence à 1 MP et 1 400 px, puis valide la sortie. Il ne télécharge aucun script ni extension. Pour l’agrandissement, les échantillons RGBA16 originaux sont recopiés exactement au centre après génération ; la précision des nouvelles bordures dépend du modèle, même dans le fichier PNG16 final.

L’annulation retire uniquement notre tâche si elle attend dans la file. Une tâche déjà exécutée peut se terminer dans un ComfyUI partagé ; Atelier Photo n’interrompt pas les travaux d’autres applications. Les fichiers temporaires d’entrée/sortie restent normalement dans les dossiers locaux de ComfyUI. Aucun fichier arbitraire de ce service n’est supprimé.

## Coût et validation

L’inférence locale n’utilise aucune clé ni facturation API. Matériel, stockage, électricité et temps de calcul restent à la charge de l’utilisateur. Internet sert à installer les moteurs et télécharger les poids. Les échanges de traitement d’Atelier Photo sont limités aux adresses HTTP de boucle locale, sans proxy d’environnement, redirection ou repli vers un fournisseur distant. Les modèles Ollama déclarant un hôte/modèle distant ou un nom cloud sont refusés avant l’envoi de la photo. Le serveur local reste un logiciel choisi et administré par l’utilisateur.

Les tests automatisés couvrent des profils Mac/PC, l’insuffisance de ressources, les mesures inconnues, les protocoles simulés, le refus du cloud, l’annulation et la conservation des pixels 16 bits. Ils ne chargent pas de vrais poids Ollama/ComfyUI. Un essai séparé avec **Ollama 0.40.4 et Qwen3-VL 2B Instruct** a réellement traité une mire en **8,513 s** sur la machine de QA, puis exporté plus de 256 niveaux par canal. Il a aussi révélé un recadrage et des retouches portrait non demandés : les protections applicatives décrites plus haut répondent à ces défauts. Runtime et poids temporaires ont été supprimés après l’essai. Voir [la mesure, les limites et le défaut observé](LOCAL-AI-REAL-QA.md).

Ce temps ne prédit pas la vitesse d’un autre ordinateur. La qualité sur portraits/paysages, ComfyUI, les autres tailles et l’installation de ces moteurs sur Windows/Linux restent à tester réellement. Une configuration détectée n’atteste pas leur bon rendu. Ne pas présenter une simulation comme une mesure du modèle.

Sources primaires : [vision Ollama](https://docs.ollama.com/capabilities/vision), [matériel et pilotes](https://docs.ollama.com/gpu), [Qwen3-VL Instruct 2B](https://ollama.com/library/qwen3-vl:2b-instruct), [confidentialité et dossiers](https://docs.ollama.com/faq), [FLUX.2 Klein dans ComfyUI](https://docs.comfy.org/tutorials/flux/flux-2-klein). Les études préalables détaillées sont dans [LOCAL-AI-REVIEW](LOCAL-AI-REVIEW.md) et [LOCAL-IMAGE-AI](LOCAL-IMAGE-AI.md).

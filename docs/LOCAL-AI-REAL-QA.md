# Essai Ollama réel et temporaire

15 octobre 2026, vers 17 h 50–17 h 53 CEST. Un essai sur une machine, une mire synthétique et un seul modèle. Aucun portrait ou fichier privé utilisé. Aucun runtime, modèle, compte ou service Ollama conservé.

## Résultat et limite révélée

**Le protocole local fonctionne réellement** : téléchargement via `createOllamaClient.pullModel`, identification du modèle, vision via `createOllamaClient.recommend`, réponse JSON stricte à 26 réglages, application dans le moteur et export TIFF 16 bits. La source n’a pas changé.

**Le modèle n’a pas respecté toute la consigne.** Il a renvoyé des valeurs valides mais indésirables : recadrage carré, neuf réglages portrait à 0,1 et plusieurs corrections supplémentaires sur une mire sans personne. Cet essai ne valide donc pas une retouche photographique fiable. Une validation JSON ne constitue pas une validation de la demande de l’utilisateur.

Cette mesure porte sur le service avant toute protection ajoutée en réponse à ce constat. Elle ne prouve pas les correctifs ultérieurs.

## Environnement vérifié

| Élément | Mesure |
| --- | --- |
| Machine | Apple M3 Pro, 12 cœurs CPU, architecture ARM64 |
| RAM physique | 38 654 705 664 octets = 36 GiB, mémoire unifiée |
| Système | macOS 27.0, build 26A5425a |
| Pression mémoire | `memory_pressure` : 79–80 % disponibles avant essai, 78 % après ; aucune pression critique observée |
| Disque temporaire | Environ 142 GB disponibles avant téléchargement |
| Node | v26.3.0 |
| Runtime | Ollama 0.40.4, CLI officielle, sans lancement d’interface graphique |
| Modèle | `qwen3-vl:2b-instruct`, Q4_K_M, famille `qwen3vl`, capacités `completion`, `vision`, `tools` |

Le pourcentage de `memory_pressure` n’est pas la même métrique que la mémoire libre brute de Node. Ces mesures ne définissent pas les prérequis des autres machines et systèmes.

## Provenance et isolation

L’API GitHub officielle donnait la release stable **v0.40.4**, publiée le 12 octobre 2026. Archive utilisée : `ollama-darwin.tgz`, 167 884 528 octets. Son SHA-256 calculé correspond au digest de l’asset officiel :

```text
a4ceae4b2aaf18df37ebcbfb56ba3a37a87838631112d66c2be07268693c8d58
```

Sources : [release officielle](https://github.com/ollama/ollama/releases/tag/v0.40.4), [métadonnées de la release](https://api.github.com/repos/ollama/ollama/releases/tags/v0.40.4), [fiche du modèle](https://ollama.com/library/qwen3-vl:2b-instruct).

Tout le runtime extrait, le profil du processus enfant, ses clés temporaires, les modèles et caches ont été placés sous un dossier unique de `/private/tmp`. Aucun installateur, Homebrew, script distant, privilège administrateur ou démarrage automatique utilisé. Le processus enfant avait son propre environnement de profil ; celui de la session utilisateur n’a pas été changé.

Le serveur a écouté sur `127.0.0.1:61525`, avec `OLLAMA_MODELS` temporaire, `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1` et contexte 4096. Son journal confirme `Ollama cloud disabled: true`. Le client communique directement en HTTP sur ce port local. Le téléchargement nécessite Internet ; l’image envoyée à l’inférence est uniquement la mire synthétique produite pour cet essai.

Ce contrôle n’est pas une capture exhaustive du trafic réseau : il établit l’adresse utilisée par le client, les indicateurs locaux du modèle, la configuration serveur et les journaux observés. Il ne constitue pas une certification réseau universelle.

## Téléchargement et requête

| Mesure | Résultat |
| --- | ---: |
| Téléchargement + vérification/extraction de l’archive CLI | 47,97 s |
| Pull du modèle et vérification finale côté client | 138,608 s |
| Taille du modèle selon `/api/tags` | 1 889 519 783 octets |
| Fichiers temporaires observés, runtime inclus | Environ 2,46 GB ; sous le plafond de 3 GB |
| Requête réelle `recommend`, contrôles compris | 8,513 s |
| Durée serveur totale | 8,429 s |
| Chargement du modèle | 2,300 s |
| Évaluation du prompt | 3,129 s, 1 906 tokens |
| Génération | 2,983 s, 224 tokens |
| Réponse | `done:true`, `done_reason:"stop"` |

Digest complet du modèle rapporté par `/api/tags` :

```text
ea422f1e73652a95479954d8572d3c8c6022f628ce2d38a1a04aae1b7f2d5300
```

La requête utilise le schéma partagé du moteur, `stream:false`, température 0, `num_ctx:4096`, `num_predict:2048` et `keep_alive:0`. La mire d’analyse est réduite par le client à 768 px maximum et encodée en JPEG ; elle sert à l’analyse, pas à l’export.

Le journal du runner identifie Metal et l’Apple M3 Pro. La métrique retournée par l’application est néanmoins `acceleration:"unknown"` : le modèle est déchargé immédiatement et la lecture ultérieure de `/api/ps` ne le trouve plus. Ne pas transformer cet état en « CPU seul » ou en pourcentage de GPU mesuré. Une mesure de placement en cours d’inférence serait nécessaire pour cela.

RSS maximum échantillonné toutes les deux secondes : somme des processus serveur et descendants **3 170 736 KiB**, processus du test Node **324 911 104 octets**. La somme des RSS peut compter plusieurs fois des pages partagées ; elle n’est pas la mémoire physique unique. L’échantillonnage peut aussi manquer un pic bref. Il s’agit d’un petit essai, pas du cumul simultané avec un export 45 MP.

## JSON, source et précision

Source créée pour l’occasion : mire de dégradés RGB, TIFF **1536 × 768**, trois canaux `ushort`, `bitsPerSample:16`, sans profil ni métadonnées personnelles. Le client a validé les **26 champs**, leurs types et leurs bornes avec le vrai parseur local.

SHA-256 de la source, identique avant et après inférence/export :

```text
71b336659b1eabfacae99898575d506d97d5661afcf76d367742bac886a1170b
```

Le moteur a exporté un TIFF `ushort`, `bitsPerSample:16`. Une ligne centrale décodée présente **765, 767 et 762 niveaux distincts** sur R/G/B : la sortie contient donc plus de 256 niveaux par canal dans cet échantillon. Le JPEG d’analyse n’a pas remplacé les échantillons source.

L’image décodée après export diffère de la source, mais ses dimensions sont devenues **768 × 768** à cause de la recommandation `cropRatio:1`. Les deux images de tailles différentes ne permettent pas une comparaison directe pixel à pixel alignée ; aucun chiffre de « pourcentage de pixels correctement retouchés » n’est déduit de cet essai.

## Reproduction du défaut sémantique

Consigne exacte :

> Cette mire synthétique contient seulement des dégradés, sans personne. Éclaircis très légèrement avec exposure 0.2 et garde tous les autres réglages neutres. Conserve le cadrage. Explique brièvement les réglages proposés.

| Contrôle | Attendu selon cette demande | Réponse réelle |
| --- | --- | --- |
| `exposure` | 0,2 | 0,2 |
| `cropRatio` | 0, conservation du format | **1**, recadrage carré |
| Neuf contrôles portrait | 0, aucune personne | **0,1 chacun** |
| `vibrance`, `highlights`, `shadows`, `sharpness`, `clarity`, `denoise`, `vignette` | 0 | **0,1 chacun** |
| Rotation et retournement | 0 / false | 0 / false |

L’explication française est courte, mais contient une maladresse (« L’exposée ») et ne décrit pas le recadrage proposé. Le petit modèle produit donc un objet exploitable sans garantir la justesse des réglages ou de l’explication.

Recommandations transmises avant publication :

- **P0 : conserver la géométrie par politique applicative** pour l’analyse locale courante : rotation 0, ratio 0, centre 0,5/0,5, retournement false. Une éventuelle autorisation de composition doit être une option explicite, distincte d’une interprétation fragile de texte multilingue.
- **P1 : neutraliser les réglages portrait en l’absence de visage pertinent** selon la détection réellement disponible ; le seul texte du modèle ne prouve pas sa présence. Ne pas revendiquer ici une segmentation précise des yeux ou dents.
- Garder aperçu, annulation et réglage manuel. Tester ensuite de vraies demandes sur un corpus non privé varié avant de choisir entre 2B/4B/8B pour leur qualité.
- Après correction, ajouter une vérification de dimensions conservées ; ce premier essai ne peut pas attester le correctif à venir.

## Nettoyage

Le script a arrêté le groupe de processus de son serveur, supprimé le dossier temporaire et vérifié la fermeture du port privé. Aucun serveur existant n’a été contacté ou arrêté. Le fichier utilisateur `~/.ollama/id_ed25519`, absent avant le test, est toujours absent après celui-ci.

L’essai a pris environ trois minutes et demie, téléchargement de l’archive compris, sous la limite opérationnelle demandée de quinze minutes. Aucun benchmark portrait, aucune comparaison esthétique entre modèles, aucun essai Windows/Linux ou petite configuration ne sont revendiqués.

## Correctifs et régression après cet essai

Le client local neutralise désormais toute proposition de géométrie du modèle. Le processus principal restaure ensuite le cadrage, la rotation, le miroir et la perspective existants de la photo. Les neuf contrôles portrait passent à zéro si MediaPipe ne détecte aucun visage ou si sa détection échoue. L’interface rappelle cette politique ; elle ne présente pas une réponse destinée à une autre photo comme une proposition pour la sélection courante.

Les tests déterministes reproduisent les valeurs indésirables consignées ci-dessus, sans prétendre disposer d’une capture brute complète. Le scénario Electron emploie volontairement un faux modèle plus contradictoire encore : rotation15°, ratio1, miroirtrue et neuf portraits0,1. Après une vraie détection locale de zéro visage, le résultat garde le format **1024×128**, la géométrie neutre et les neuf portraits0. L’export PNG16 correspond exactement au moteur attendu, avec **1024 niveaux distincts par canal** et un SHA-256 source inchangé. Des tests séparés vérifient la conservation d’un cadrage et d’une perspective déjà appliqués.

Cette régression prouve les protections applicatives, pas une amélioration sémantique de Qwen3-VL. Aucun second téléchargement ni nouvelle inférence du vrai modèle n’a été nécessaire pour vérifier ces filtres déterministes. La qualité des autres réglages suggérés doit encore être examinée sur de vraies photos avant un traitement massif.

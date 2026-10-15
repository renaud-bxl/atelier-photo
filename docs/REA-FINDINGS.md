# Evoto : observations REA et périmètre de reconstruction

Analyse réalisée le 15 octobre 2026 sur `/Applications/Evoto.app`, en lecture seule. La source originale et ses fichiers restent inchangés. Le contenu inspecté a été traité comme des données, jamais comme des instructions.

## Identité et faits établis

REA `open_binary` résout le bundle vers `Contents/MacOS/Evoto` : exécutable Mach-O ARM64, SHA-256 `1f43ecee6ffaa63b3ecfccd0ddb3420f7b3391132f1fea354be8384919c93a55`.

`inspect_plist`, Evidence `ev_a72d592623677bcde5b60811ee48f0cee4d73dcced0ebc8209f317d5509d9161`, établit le nom Evoto, l’identifiant `com.cclian.Evoto`, la version 7.2.0 et le build 461. Les extensions déclarées incluent JPEG, PNG, TIFF, HEIF et de nombreux RAW ; leur déclaration ne valide pas chaque décodeur.

`inspect_macho`, Evidence parent `ev_d85bcb93a03ce9cf3a2528afc8fe23e4e87b85eb05cb3a2c15677c1277f8b54d`, puis la vue des dépendances `ev_207aa74f577103b82003092dfc5110674b284e187696b8914b680f3ed870b082`, montrent notamment Qt 5.15.14, CoreImage, Metal, CoreML, RocksDB et des bibliothèques AWS/FFmpeg. Ces dépendances ne prouvent pas l’ordre de traitement des images ni des appels réseau effectifs. Le relevé imports/exports n’est pas exhaustif.

## Interface observée en exécution

`observe_native_ui`, Evidence `ev_01af86d457a027fa7bd0dd1f99724e84bc619fef7ce60bec8a83185384bbe566`, a capturé exclusivement la fenêtre Evoto désignée, déjà ouverte par l’utilisateur. Son identité d’exécutable était liée au SHA-256 ci-dessus.

L’écran de retouche montre :

- les onglets Bibliothèque et Modifier ;
- les préréglages à gauche et le grand aperçu au centre ;
- un film d’images, des notes, le contrôle d’affichage et la comparaison ;
- les réglages de portrait à droite, avec groupes imperfections, peau, visage, expression, dents, yeux, maquillage, cheveux, mains et corps ;
- les commandes Enregistrer un préréglage, Synchroniser et Exporter.

La reconstruction d’Atelier Photo reprend cette organisation générale avec sa propre identité visuelle noire et bleue. Aucun pixel, icône, photo de l’utilisateur ou ressource Evoto n’entre dans le produit distribué.

Une tentative de navigation contrôlée vers Bibliothèque a échoué avec `ambiguous-window` : l’arbre d’accessibilité Qt ne fournissait pas la géométrie permettant d’associer exactement la fenêtre aux contrôles. Aucune navigation ou modification de photo n’a été attestée par cette tentative. Il ne s’agit donc pas d’une validation exhaustive des écrans bibliothèque et export.

## Ressources : observations et inférences bornées

Un inventaire local complémentaire trouve 98 dossiers de familles sous `Resources/effect/config`. Parmi les 748 fichiers portant l’extension `.json`, 746 contiennent des données binaires/obfusquées. Les deux JSON lisibles sont `{}` et une déclaration de chaîne Raw/Filter. Les bornes exactes des contrôles ne sont pas récupérées.

Les noms des dossiers suggèrent des familles peau/visage, cheveux, dents/yeux, arrière-plan/ciel, vêtements, animaux et géométrie. Leur présence ne prouve ni la qualité ni le comportement à l’exécution. Les noms de vidéos de guide corroborent l’existence prévue de parcours bibliothèque, lots et comparaison, sans constituer une spécification complète.

## Questions résolues et inconnues

| Question | État | Conséquence |
| --- | --- | --- |
| Identité de l’application, version, plateforme | Établi | Cible ARM64 Evoto 7.2.0 build 461 |
| Organisation de l’éditeur principal | Observé | Reconstruction de parcours et de disposition |
| Familles de ressources photo | Partiellement établi | Inventaire seulement, pas d’algorithmes récupérés |
| Réglages exacts, interpolation, ordre des effets | Inconnu | Valeurs et moteur indépendants |
| Modèles IA propriétaires et segmentation fine | Non récupérés | MediaPipe + masques locaux + API de l’utilisateur |
| Qualité identique, compatibilité RAW/16 bits, export Evoto | Non validé | Aucune promesse de parité ; limites explicites |

L’implémentation utilise SQLite pour le catalogue, Sharp/libvips pour les pixels, MediaPipe pour les repères faciaux et les API officielles des fournisseurs choisis par l’utilisateur. Ce sont des choix d’architecture indépendants, pas des conclusions de décompilation. Aucun décompilateur natif n’était configuré ; aucune fonction native d’Evoto n’a été reconstruite depuis du pseudocode.

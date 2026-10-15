# Import de préréglages personnels

`desktop/preset-import.mjs` lit les fichiers choisis par l’utilisateur comme des données inertes. Il ne modifie pas les originaux et n’écrit pas dans le catalogue. L’appelant utilise ensuite l’API du catalogue utilisateur pour conserver le résultat. Aucun XMP du dossier personnel fourni n’a été ajouté au code, aux tests, aux ressources de l’application ou à une release.

Les tests contiennent uniquement de petits exemples inventés. Les préréglages personnels, dont certains portent des mentions de copyright SparkleStock ou 2000px Media Inc., ne doivent pas être redistribués avec le projet. Le nom, le groupe et la mention de droits sont conservés dans les métadonnées d’import pour l’usage local de l’utilisateur.

## API

```js
parseXMP(text, { filename = '' })
// { name, category, adjustments, compatibility,
//   supportedFields, unsupportedFields, sourceHash,
//   sourceUUID, sourceSettingsHash, copyright, sourceName }

await inspectPresetFolder(absoluteDirectory)
// { presets, errors, summary }

parseCube(text)
// { title, size, domainMin, domainMax, values }
```

`sourceHash` est l’empreinte SHA-256 du texte source. `sourceUUID` est l’UUID CRS normalisé lorsqu’il est valide. `sourceSettingsHash` est une empreinte des attributs et propriétés CRS de rendu, y compris les éléments non interprétés ; aucune table propriétaire n’est renvoyée. L’inspection déduplique les sources identiques, ou les sources partageant un UUID et les mêmes réglages. Deux variantes différentes restent distinctes, même si elles partagent un UUID ou un nom. Les noms identiques restants reçoivent un suffixe « (2) », « (3) », etc.

`supportedFields` et `unsupportedFields` contiennent les noms CRS natifs, et non les noms des contrôles du moteur. Le résumé compte les fichiers trouvés, analysés, conservés, doublons, erreurs et niveaux de compatibilité. Il agrège aussi les champs CRS pris en charge ou signalés. Une erreur sur un fichier n’empêche pas l’inspection des autres.

L’inspection parcourt les sous-dossiers, ignore les liens symboliques et accepte au maximum 20 000 XMP, avec 24 niveaux de dossiers et 2 Mo par fichier. Les fichiers doivent être en UTF-8. Les autres extensions sont ignorées ; les fichiers CUBE sont traités séparément par `parseCube`.

## Adaptation XMP

La lecture respecte les espaces de noms XML. Seuls les attributs et propriétés CRS de la Description RDF principale sont utilisés pour le rendu. Les attributs imbriqués dans un `Look` ne sont jamais pris pour des réglages globaux. Le nom et le groupe privilégient la valeur RDF `x-default`, puis la première traduction disponible et enfin le nom de fichier. Les mentions de droits CRS ou Dublin Core sont conservées.

| Champ Camera Raw | Réglage Atelier Photo | Adaptation |
| --- | --- | --- |
| Exposure2012 | exposure | −3 à +3 EV |
| Contrast2012 | contrast | 1 + valeur/100, borné à 0,5…1,8 |
| Saturation | saturation | 1 + valeur/100, borné à 0…2 |
| Vibrance | vibrance | valeur/100, borné à −1…1 |
| IncrementalTemperature | temperature | correction relative bornée à −100…100 |
| Temperature | temperature | approximation (Kelvin − 6 500)/100, bornée à −100…100 |
| IncrementalTint ou Tint | tint | −100…100 ; l’incrément relatif est prioritaire |
| Highlights2012 | highlights | valeur/100, −1…1 |
| Shadows2012 | shadows | valeurs positives/100, 0…1 ; valeurs négatives signalées |
| Sharpness | sharpness | valeur/50, 0…2 |
| LuminanceSmoothing | denoise | valeur/100, 0…1 |
| Clarity2012 | clarity | valeurs positives/100, 0…1 ; valeurs négatives signalées |
| PostCropVignetteAmount | vignette | valeurs négatives inversées et divisées par 50 ; éclaircissement des coins signalé |
| Whites2012 et Blacks2012 | whites, blacks | valeurs natives bornées à −100…100 |
| GrainAmount | grain | 0…100 |
| Hue/Saturation/LuminanceAdjustment* | hsl | 8 bandes, valeurs natives −100…100 |
| SplitToning* | splitToning | teintes 0…360, saturations 0…100, balance −100…100 |
| ToneCurvePV2012 et variantes RVB | toneCurves | séquences de points 0…255, abscisses strictement croissantes |
| ConvertToGrayscale = True | saturation | 0 ; le mélangeur noir et blanc Adobe reste signalé s’il intervient |

Les courbes comportent 2 à 256 points. Une courbe invalide est signalée et son canal garde une courbe neutre. Le canal global `rgb` vaut par défaut `[[0,0],[255,255]]` ; les canaux rouge, vert et bleu absents sont des tableaux vides. Le HSL comporte les bandes `red`, `orange`, `yellow`, `green`, `aqua`, `blue`, `purple`, `magenta`, avec `hue`, `saturation`, `luminance`. Le virage partiel comporte `shadowHue`, `shadowSaturation`, `highlightHue`, `highlightSaturation` et `balance`. Une teinte de virage partiel sans saturation n’est pas comptée comme un effet visible.

Les modèles de netteté, bruit, contraste, balance des blancs, courbes, HSL et grain d’Atelier Photo diffèrent de ceux d’Adobe. Les nombres sont des adaptations vers les contrôles locaux ; aucun résultat identique à Lightroom, Camera Raw ou à un profil Adobe n’est promis.

## Compatibilité et application

| Valeur | Sens | Comportement de l’interface |
| --- | --- | --- |
| `adapted` | Contrôles interprétables, sans effet manquant identifié | Proposer l’application comme adaptation |
| `partial` | Des réglages interprétables existent, mais des effets ou profils restent absents | Permettre l’adaptation avec cette limite visible |
| `profile-required` | Le rendu dépend d’un profil, Look ou d’une table ; aucun véritable effet local n’a pu être extrait | Afficher la référence, sans appliquer un faux préréglage neutre |
| `unsupported` | Aucune adaptation de rendu utilisable | Afficher la référence ou le motif, sans proposer une application trompeuse |

Les `Look`, `LookStub`, `RGBTable`, `Table_*`, profils caméra et tables propriétaires Adobe ne sont ni décodés ni exécutés. La présence de réglages neutres tels qu’Exposure=0 et Saturation=0 dans un préréglage de profil ne le rend pas applicable. Les calibrations primaires, dehaze, texture, courbes paramétriques, mélangeur noir et blanc, masques, corrections optiques, géométrie spécifique et paramètres additionnels non reproduits sont signalés lorsqu’ils peuvent modifier le résultat.

Les valeurs structurées `toneCurves`, `hsl`, `whites`, `blacks`, `splitToning` et `grain` doivent être conservées par la normalisation du moteur lors de l’intégration. Le parseur les retourne ; cela ne suffit pas à prouver qu’une ancienne version du moteur les applique. Le catalogue ne doit jamais effacer `compatibility`, `copyright` ou les métadonnées de provenance lors de l’enregistrement d’un import.

## LUT CUBE

Le parseur accepte les LUT **3D** de taille entière 2 à 65. Il exige exactement `size³ × 3` nombres finis et des domaines RGB de trois nombres avec une borne maximale strictement supérieure à la minimale sur chaque canal. Les bornes par défaut sont 0 et 1. Les valeurs sont conservées dans l’ordre du fichier : rouge varie le plus vite, puis vert, puis bleu. L’index d’une entrée est `(bleu × size² + vert × size + rouge) × 3`.

Les LUT 1D sont explicitement refusées. Les tailles, directives, comptes de valeurs, domaines et nombres invalides sont rejetés ; le fichier est limité à 32 Mo. `parseCube` ne calcule pas de rendu et ne remplace pas les tables RGB propriétaires intégrées aux XMP. L’application fournit ensuite la LUT au moteur via son propre identifiant SHA-256 et son intensité.

## Sécurité et vérification

Le lecteur XML n’exécute rien. Il refuse `DOCTYPE`, `ENTITY`, entités inconnues, caractères XML invalides, balises déséquilibrées, attributs répétés et documents trop complexes. Seules les entités XML prédéfinies et les références numériques valides sont décodées. Aucune URL, ressource externe, instruction de traitement ou référence de profil n’est suivie.

Le dossier utilisateur fourni a été inspecté en lecture seule : **656 XMP, 2 918 458 octets**, **656 analyses réussies**, aucune erreur et aucun doublon. Le classement conservateur obtenu est **502 adaptations partielles, 151 références nécessitant un profil et 3 éléments non pris en charge**. Ces trois éléments sont des fichiers de préférences, favoris ou valeurs RAW par défaut, plutôt que des effets photo applicables. Aucun fichier n’a été copié ou redistribué.

Parmi les sources, 453 contiennent des courbes globales lisibles, 438 des réglages HSL et 320 une température incrémentale ; 200 contiennent une mention de droits. Ces comptages décrivent les données lues et n’établissent pas une fidélité de rendu Adobe.

Les tests hors ligne couvrent la lecture des métadonnées, les bornes, les attributs Look trompeurs, les références de profils, les courbes, les espaces de noms, les entités/DTD, la déduplication, une LUT identité 2×2×2 et les entrées invalides. Un rendu sur un petit dégradé synthétique confirme que l’exposition importée traverse la normalisation du moteur et modifie les pixels. L’égalité visuelle avec Lightroom n’est pas testée ni annoncée.

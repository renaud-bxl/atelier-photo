# Site statique multilingue

Le site est indépendant du programme de bureau. Il ne contient ni clé API ni accès aux moteurs IA locaux. Le guide décrit leurs réglages dans l’application.

## Sources et génération

- `site/index.html` est un **gabarit**, pas la page à publier directement.
- `site/locales/fr.json` définit les messages : chaque clé est le texte français exact, chaque valeur française lui est identique. Le catalogue contient 133 messages.
- Les onze autres fichiers de `site/locales/` ont exactement les mêmes clés. Les paramètres `{0}`, `{1}`, etc. restent présents. Les modèles, chemins et commandes techniques ne sont pas traduits.
- `site/style.css` et `site/app.js` sont partagés par toutes les langues.

Depuis la racine du projet :

```sh
node scripts/build-site.mjs
```

La commande génère `site-dist/`. Elle exige les douze catalogues complets, des valeurs non vides, les mêmes paramètres et l’image OG PNG de 1200 × 630. Une traduction manquante arrête la génération avant de remplacer le site précédent. Il n’existe aucun repli français dans les pages publiées.

L’URL publique par défaut est `https://renaud-bxl.github.io/atelier-photo/`. Pour une autre destination :

```sh
node scripts/build-site.mjs --site-url https://example.org/atelier-photo/ --out-dir site-dist
```

`SITE_URL` permet également de configurer cette base. Le répertoire de sortie porte un marqueur de génération ; le script refuse de remplacer un dossier non vide sans ce marqueur.

## Pages et métadonnées

Le français est à la racine ; les autres pages sont `/en/`, `/nl/`, `/es/`, `/zh/`, `/ja/`, `/ar/`, `/de/`, `/pt/`, `/it/`, `/hi/` et `/ko/`. Chaque page contient déjà son texte, sa langue et sa direction avant toute exécution JavaScript. L’arabe utilise `dir="rtl"` ; les marques, codes et adresses restent isolés de gauche à droite.

Chaque document possède un titre Bêta, une description, son canonical absolu, douze liens `hreflang` et un `x-default` français. Open Graph et Twitter utilisent le titre et la description traduits, ainsi que l’image partagée `og/atelier-photo-beta-v2.png`. Le logo de l’en-tête, du pied de page, de l’onglet et de l’icône Apple reprend directement `public/app-icon.svg` et `public/app-icon.png`, les sources de l’application. Le générateur les copie sous des noms portant leur empreinte SHA-256 dans `brand/`, sans copie manuelle ni modification du dessin. La carte OG utilise ce même dessin ; son nouveau nom évite de reprendre l’ancien monogramme AP en cache. Les liens CSS/JS utilisent `./` à la racine et `../` dans les sous-pages ; le préfixe GitHub Pages `/atelier-photo/` est donc conservé.

Le titre et la présentation commencent par l’IA locale gratuite sans clé API. La description rappelle qu’elle dépend des capacités de l’ordinateur ; OpenAI, Gemini et Claude sont présentés ensuite comme options avec les clés personnelles.

Les messages du navigateur sont embarqués dans un attribut HTML contenant du JSON échappé. `app.js` les utilise pour les montants, PayPal, la copie des commandes et l’état des téléchargements. Le contenu traduit est inséré avec `textContent`, jamais interprété comme du HTML.

Les liens CSS et JavaScript portent une version dérivée du SHA-256 de leurs contenus. Une nouvelle page traduite ne réutilise ainsi pas les anciens contrôles français conservés en cache par un navigateur.

L’adresse publique à partager reste `https://renaud-bxl.github.io/atelier-photo/` pour toutes les versions. Les publications actualisent cette même page et les commandes ciblent la dernière release GitHub. Un ancien paramètre `v` est retiré de la barre d’adresse avec `history.replaceState`, sans rechargement ni nouvelle entrée d’historique ; la langue, l’ancre et les autres paramètres sont conservés. Les empreintes des fichiers CSS/JS assurent leur actualisation indépendamment du lien public.

L’aperçu de l’accueil suit légèrement la souris, avec des angles et déplacements bornés. Il revient au repos à la sortie du pointeur, au défilement et à la perte de visibilité. L’effet respecte `prefers-reduced-motion` et s’active uniquement avec un pointeur fin capable de survol ; les appareils tactiles conservent l’aperçu fixe.

Le sélecteur navigue vers un vrai document HTML et conserve l’ancre courante. Il n’y a ni routeur client ni redirection automatique selon le navigateur. Le guide en cinq étapes et ses liens officiels sont accessibles sans JavaScript ; une navigation de langues supplémentaire et le téléchargement GitHub sont alors disponibles dans les éléments `noscript`.

## Vérification et publication

Prévisualiser **`site-dist/`**, avec un serveur qui conserve le sous-chemin `/atelier-photo/` si l’on souhaite reproduire GitHub Pages. Vérifier au minimum les métadonnées initiales, les douze liens de langue, le guide sans JavaScript, les montants de don, les commandes copiées et l’absence de débordement en arabe et sur mobile.

Seul `site-dist/` est un artefact de publication. La génération ne publie rien et ne modifie ni les versions du logiciel ni ses catalogues de traduction.

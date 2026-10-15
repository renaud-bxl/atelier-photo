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

Chaque document possède un titre Bêta, une description, son canonical absolu, douze liens `hreflang` et un `x-default` français. Open Graph et Twitter utilisent le titre et la description traduits, ainsi que l’image partagée `og/atelier-photo-beta-v1.png`. Les liens CSS/JS utilisent `./` à la racine et `../` dans les sous-pages ; le préfixe GitHub Pages `/atelier-photo/` est donc conservé.

Les messages du navigateur sont embarqués dans un attribut HTML contenant du JSON échappé. `app.js` les utilise pour les montants, PayPal, la copie des commandes et l’état des téléchargements. Le contenu traduit est inséré avec `textContent`, jamais interprété comme du HTML.

Le sélecteur navigue vers un vrai document HTML et conserve l’ancre courante. Il n’y a ni routeur client ni redirection automatique selon le navigateur. Le guide en cinq étapes et ses liens officiels sont accessibles sans JavaScript ; une navigation de langues supplémentaire et le téléchargement GitHub sont alors disponibles dans les éléments `noscript`.

## Vérification et publication

Prévisualiser **`site-dist/`**, avec un serveur qui conserve le sous-chemin `/atelier-photo/` si l’on souhaite reproduire GitHub Pages. Vérifier au minimum les métadonnées initiales, les douze liens de langue, le guide sans JavaScript, les montants de don, les commandes copiées et l’absence de débordement en arabe et sur mobile.

Seul `site-dist/` est un artefact de publication. La génération ne publie rien et ne modifie ni les versions du logiciel ni ses catalogues de traduction.

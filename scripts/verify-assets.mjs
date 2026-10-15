import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyModelAssets} from '../desktop/model-assets.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
console.log(`${await verifyModelAssets(join(root,'public/models'))} ressources de modèles vérifiées par SHA-256.`);

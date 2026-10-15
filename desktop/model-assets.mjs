import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
export async function verifyModelAssets(base){
  const manifest=JSON.parse(await readFile(join(base,'ASSETS.json'),'utf8'));
  const files=Object.entries(manifest.sha256||{});
  if(files.length<5)throw new Error('Le manifeste des modèles est incomplet.');
  for(const [name,expected] of files){
    if(isAbsolute(name)||name.split(/[\\/]/).some(part=>!part||part==='..')||!/^[a-f0-9]{64}$/.test(expected))throw new Error('Le manifeste des modèles est non valide.');
    const actual=createHash('sha256').update(await readFile(join(base,name))).digest('hex');
    if(actual!==expected)throw new Error(`Le modèle local est endommagé : ${name}`);
  }
  return files.length;
}

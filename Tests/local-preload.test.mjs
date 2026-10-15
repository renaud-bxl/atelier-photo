import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('local IPC messages remain translatable without exposing or inventing a renderer capability',async()=>{
  let exposed;
  const message='L’espace disque disponible est insuffisant pour installer le moteur local.';
  const calls=[];
  vm.runInNewContext(readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld:(name,api)=>{assert.equal(name,'atelier');exposed=api;}},
      ipcRenderer:{invoke:async(name,...args)=>{calls.push([name,...args]);throw new Error(`Error invoking remote method '${name}': Error: ${message}`);}},webUtils:{}}),
  });
  await assert.rejects(exposed.localEngineInstall(),error=>error.message===message);
  await assert.rejects(exposed.localPull({model:'qwen3-vl:2b-instruct'}),error=>error.message===message);
  assert.deepEqual(calls,[['atelier:localEngineInstall'],['atelier:localPull',{model:'qwen3-vl:2b-instruct'}]]);
  assert.equal(exposed.spawn,undefined);assert.equal(exposed.downloadURL,undefined);assert.equal(Object.isFrozen(exposed),true);
});

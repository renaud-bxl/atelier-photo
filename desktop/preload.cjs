const { contextBridge, ipcRenderer, webUtils } = require('electron');
const methods = ['list','getPhoto','counts','metadata','importPhotos','importFolder','importDropped','update','remove','presets','importPresets','savePreset','deletePreset','sync','exportPhotos','cancelJob','getSettings','saveSpatialPreview','setLanguage','saveSettings','saveKey','deleteKey','ai','aiBatch','cancelAI','detectFaces','saveProject','openProject','openExternal','faceReady','completeFaceTask'];
const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke(`atelier:${name}`, ...args)]));
for(const name of ['localHardware','localRecommendations','chooseLocalModelDirectory','localStatus','localPull','cancelLocalPull','localBenchmark','openLocalInstaller','comfyStatus','localEngineStatus','localEngineInstall','localEngineStart','localEngineStop','cancelLocalEngineInstall'])api[name]=async(...args)=>{
  try{return await ipcRenderer.invoke(`atelier:${name}`,...args);}
  catch(error){
    // Preserve the application's translatable message across Electron's wrapper.
    const prefix=`Error invoking remote method 'atelier:${name}': `;
    const message=typeof error?.message==='string'?error.message:'Cette action n’a pas pu être effectuée.';
    throw new Error(message.startsWith(prefix)?message.slice(prefix.length).replace(/^Error: /,''):message);
  }
};
api.filePath = file => { try { return webUtils.getPathForFile(file); } catch { return ''; } };
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Le rappel doit être une fonction.');
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  let subscribed = true;
  return () => { if (subscribed) { ipcRenderer.removeListener(channel, handler); subscribed = false; } };
}
api.onProgress = callback => subscribe('atelier:progress', callback);
api.onFaceTask = callback => subscribe('atelier:faceTask', callback);
contextBridge.exposeInMainWorld('atelier', Object.freeze(api));

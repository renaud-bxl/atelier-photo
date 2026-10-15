/** Linear checks: repeated regex capture groups can overflow on multi-MiB PNGs. */
export function decodeSpatialBase64(value){
  if(typeof value!=='string'||!value.length||value.length>24*1024*1024||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('Aperçu spatial non valide.');
  return Buffer.from(value,'base64');
}

// ImageNet RGB preprocessing specified by the pinned DPT image processor.
export function depthDimensions(width,height,maxSide=518){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Dimensions de photo non valides.');
  const scale=maxSide/Math.max(width,height);
  return {width:Math.max(14,Math.round(width*scale/14)*14),height:Math.max(14,Math.round(height*scale/14)*14)};
}
export function depthTensor(rgba,width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>518*518||rgba.length!==width*height*4)throw new Error('Image de profondeur non valide.');
  const pixels=width*height,output=new Float32Array(pixels*3),mean=[.485,.456,.406],std=[.229,.224,.225];
  for(let i=0;i<pixels;i++)for(let channel=0;channel<3;channel++)output[channel*pixels+i]=(rgba[i*4+channel]/255-mean[channel])/std[channel];
  return output;
}
export function normalizeDepth(values){
  if(!ArrayBuffer.isView(values)||values.length<1||values.length>518*518)throw new Error('Carte de profondeur non valide.');
  for(const value of values)if(!Number.isFinite(value))throw new Error('Carte de profondeur non valide.');
  const sorted=Float32Array.from(values).sort(),low=sorted[Math.floor((sorted.length-1)*.02)],high=sorted[Math.floor((sorted.length-1)*.98)];
  const result=new Uint8Array(values.length);
  if(high-low<1e-8){result.fill(128);return result;}
  for(let i=0;i<values.length;i++)result[i]=Math.round(Math.min(1,Math.max(0,(values[i]-low)/(high-low)))*255);
  return result;
}

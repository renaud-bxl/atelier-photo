import * as ort from 'onnxruntime-web/wasm';
import { depthTensor,normalizeDepth } from './depth-core.js';

ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths={mjs:'atelier://assets/onnx/ort-wasm-simd-threaded.mjs',wasm:'atelier://assets/onnx/ort-wasm-simd-threaded.wasm'};
ort.env.logLevel='error';
let session;
async function load(){
  if(!session){
    const responses=await Promise.all(['model_quantized.onnx','model_quantized.onnx_data'].map(name=>fetch(`atelier://assets/depth/${name}`)));
    if(responses.some(r=>!r.ok))throw new Error('Le modèle de profondeur local est indisponible.');
    const [graph,weights]=await Promise.all(responses.map(r=>r.arrayBuffer()));
    session=await ort.InferenceSession.create(new Uint8Array(graph),{executionProviders:['wasm'],externalData:[{path:'model_quantized.onnx_data',data:new Uint8Array(weights)}]});
  }
  return session;
}
self.onmessage=async({data:message})=>{
  try{
    const {width,height,rgba}=message;
    const tensor=new ort.Tensor('float32',depthTensor(new Uint8ClampedArray(rgba),width,height),[1,3,height,width]);
    const engine=await load();
    const outputs=await engine.run({[engine.inputNames[0]]:tensor});
    const output=outputs[engine.outputNames[0]],dims=output.dims;
    const w=dims.at(-1),h=dims.at(-2);
    if(w!==width||h!==height||output.data.length!==w*h)throw new Error('Dimensions de profondeur inattendues.');
    const pixels=normalizeDepth(output.data);
    self.postMessage({width:w,height:h,pixels:pixels.buffer},[pixels.buffer]);
    tensor.dispose();for(const value of Object.values(outputs))value.dispose();
  }catch(error){self.postMessage({error:error?.message||'Le calcul de profondeur a échoué.'});}
};

import React,{useEffect,useRef,useState} from 'react';
import {Layers3,LoaderCircle,RotateCcw,Download} from 'lucide-react';
import {ModalFrame} from './Dialogs.jsx';
import {depthDimensions} from './depth-core.js';
import {createSpatialRenderer} from './spatial-renderer.js';

export default function SpatialPhotoModal({photo,source,onClose,onCreated}){
  const canvas=useRef(),image=useRef(),renderer=useRef();
  const [depth,setDepth]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const [yaw,setYaw]=useState(0),[pitch,setPitch]=useState(0),[strength,setStrength]=useState(.5),[showDepth,setShowDepth]=useState(false),[pointer,setPointer]=useState({x:0,y:0});
  useEffect(()=>{
    let cancelled=false;setDepth(null);setError('');
    const worker=new Worker(new URL('./depth-worker.js',import.meta.url),{type:'module'});
    const timeout=setTimeout(()=>{if(!cancelled){setError('Le calcul de profondeur a échoué.');worker.terminate();}},120000);
    worker.onmessage=({data})=>{
      clearTimeout(timeout);if(cancelled)return;
      if(data.error)setError(data.error);else setDepth({width:data.width,height:data.height,pixels:new Uint8Array(data.pixels)});
      worker.terminate();
    };
    worker.onerror=()=>{clearTimeout(timeout);if(!cancelled)setError('Le calcul de profondeur a échoué.');worker.terminate();};
    const picture=new Image();picture.crossOrigin='anonymous';
    picture.onload=()=>{
      if(cancelled)return;
      image.current=picture;
      const size=depthDimensions(picture.naturalWidth,picture.naturalHeight),input=document.createElement('canvas');
      input.width=size.width;input.height=size.height;
      const context=input.getContext('2d',{willReadFrequently:true});context.drawImage(picture,0,0,size.width,size.height);
      const rgba=context.getImageData(0,0,size.width,size.height).data.buffer;
      worker.postMessage({...size,rgba},[rgba]);
    };
    picture.onerror=()=>{clearTimeout(timeout);if(!cancelled)setError('Cette image n’a pas pu être affichée.');worker.terminate();};
    picture.src=source;
    return()=>{cancelled=true;clearTimeout(timeout);worker.terminate();picture.onload=null;picture.onerror=null;};
  },[source]);
  useEffect(()=>{
    if(!depth||!canvas.current||!image.current)return;
    const element=canvas.current;const lost=event=>{event.preventDefault();setError('Cette image n’a pas pu être affichée.');};element.addEventListener('webglcontextlost',lost);
    try{
      canvas.current.width=image.current.naturalWidth;canvas.current.height=image.current.naturalHeight;
      renderer.current=createSpatialRenderer(canvas.current,image.current,depth);
    }catch(error){setError(error.message);}
    return()=>{element.removeEventListener('webglcontextlost',lost);renderer.current?.destroy();renderer.current=null;};
  },[depth]);
  useEffect(()=>{renderer.current?.draw({yaw:yaw+pointer.x*3,pitch:pitch+pointer.y*3,strength,showDepth});},[depth,yaw,pitch,strength,showDepth,pointer]);
  async function capture(){
    if(!renderer.current||!canvas.current)return;if(renderer.current.isContextLost()){setError('Cette image n’a pas pu être affichée.');return;}setSaving(true);
    try{const item=await window.atelier.saveSpatialPreview({id:photo.id,pngBase64:canvas.current.toDataURL('image/png').split(',')[1]});await onCreated(item);onClose();}
    catch(error){setError(error.message);}finally{setSaving(false);}
  }
  return <ModalFrame title="Vue spatiale" subtitle="Aucune photo n’est envoyée : ce calcul s’effectue sur votre ordinateur." icon={Layers3} onClose={onClose} width={1120}
    footer={<><span className="muted tiny">{depth?`${image.current?.naturalWidth} × ${image.current?.naturalHeight} px`:''}</span><button className="secondary" onClick={()=>{setYaw(0);setPitch(0);setStrength(.5);setPointer({x:0,y:0});}}><RotateCcw size={14}/>Réinitialiser la vue</button><button className="primary" disabled={!depth||Boolean(error)||saving||showDepth} onClick={capture}>{saving?<LoaderCircle className="spin" size={15}/>:<Download size={15}/>}Exporter l’aperçu spatial</button></>}>
    {error&&<p className="spatial-error" role="alert">{error}</p>}
    <div className="spatial-stage" onPointerMove={event=>{const box=event.currentTarget.getBoundingClientRect();setPointer({x:(event.clientX-box.left)/box.width*2-1,y:(event.clientY-box.top)/box.height*2-1});}}>
      {!depth&&!error&&<div className="spatial-loading"><LoaderCircle className="spin" size={28}/><p>Analyse locale de la profondeur…</p></div>}
      <canvas ref={canvas} data-testid="spatial-canvas" aria-label="Vue spatiale" style={{visibility:depth&&!error?'visible':'hidden'}}/>
    </div>
    <div className="spatial-controls">{[['Déplacement horizontal',yaw,setYaw,-10,10],['Déplacement vertical',pitch,setPitch,-10,10],['Intensité du relief',strength,setStrength,0,1]].map(([label,value,setter,min,max])=><label key={label}>{label}<input aria-label={label} type="range" min={min} max={max} step={.01} value={value} onChange={e=>setter(Number(e.target.value))} disabled={!depth}/></label>)}<label className="check-row"><input type="checkbox" checked={showDepth} onChange={e=>setShowDepth(e.target.checked)} disabled={!depth}/>Afficher la carte de profondeur</label></div>
    <p className="muted tiny">Déplacez le pointeur sur la photo pour explorer le relief.</p><p className="muted tiny">La profondeur est estimée. Les parties cachées de la scène ne sont pas reconstruites.</p>
  </ModalFrame>;
}

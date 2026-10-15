import React, { useMemo, useState } from 'react';
import { Aperture, ChevronDown, FolderOpen, Plus, Search, Trash2, X, Info } from 'lucide-react';
import { builtinPresets } from './builtin-presets.js';

export function PresetBrowser({presets,onApply,onImport,onDelete,onClose,hasPhoto}){
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[limit,setLimit]=useState(80),[busy,setBusy]=useState(false),[details,setDetails]=useState(null);
  const all=useMemo(()=>[...builtinPresets,...presets.map(p=>({...p,category:p.adjustments?._import?.category||'Styles importés',color:'bluehour'}))],[presets]);
  const items=useMemo(()=>all.filter(p=>(filter==='all'||(filter==='original'?p.original:filter==='imported'?!p.original:p.category===filter))&&p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())),[all,search,filter]);
  async function importFiles(folder){setBusy(true);try{await onImport(folder);}finally{setBusy(false);}}
  return <div className="modal-backdrop"><section className="modal preset-browser" role="dialog" aria-modal="true" aria-label="Styles & préréglages">
    <div className="modal-heading"><div><span className="eyebrow blue">{all.length} STYLES</span><h2>Styles & préréglages</h2></div><button className="icon-button" aria-label="Fermer" onClick={onClose}><X size={20}/></button></div>
    <div className="preset-import-actions"><button className="secondary" disabled={busy} onClick={()=>importFiles(false)}><Plus size={14}/>Importer XMP / LUT</button><button className="secondary" disabled={busy} onClick={()=>importFiles(true)}><FolderOpen size={14}/>Importer un dossier</button><span className="muted tiny">Fichiers : XMP et LUT 3D .cube</span></div>
    <div className="row preset-filter-row"><div className="search-field"><Search size={15}/><input autoFocus placeholder="Rechercher un style…" value={search} onChange={e=>{setSearch(e.target.value);setLimit(80);}}/></div><select aria-label="Filtrer les styles" value={filter} onChange={e=>{setFilter(e.target.value);setLimit(80);}}><option value="all">Tous les styles</option><option value="original">Préréglages originaux</option><option value="imported">Styles importés</option>{[...new Set(builtinPresets.map(p=>p.category))].map(c=><option key={c} value={c}>{c}</option>)}</select></div>
    <div className="style-browser-grid">{items.slice(0,limit).map(p=>{
      const meta=p.adjustments?._import,unavailable=['profile-required','unsupported'].includes(meta?.compatibility);
      return <div className={`style-card ${unavailable?'unavailable':''}`} key={p.id}>
        <button className="style-apply" disabled={!hasPhoto||unavailable} onClick={()=>{onApply(p);onClose();}}><span className={`look-swatch ${p.color||'bluehour'}`}><Aperture size={26}/></span><strong>{p.name}</strong><small>{p.category}</small><span className="style-status">{unavailable?'Profil externe requis':meta?.compatibility==='partial'?'Adaptation partielle':meta?'Compatible':'Préréglages originaux'}</span></button>
        <div className="style-card-actions">{meta&&<button className="text-button" title="Voir les réglages adaptés" onClick={()=>setDetails(details===p.id?null:p.id)}><Info size={13}/></button>}{!p.original&&<button className="text-button" title="Supprimer le préréglage" onClick={()=>onDelete(p.id)}><Trash2 size={12}/></button>}</div>
        {details===p.id&&<div className="style-details"><p>{meta.sourceName}</p><p>{meta.supportedFields?.join(', ')}</p>{meta.unsupportedFields?.length>0&&<p className="muted">{meta.unsupportedFields.join(', ')}</p>}{meta.copyright&&<small>© {meta.copyright}</small>}</div>}
      </div>;
    })}</div>
    {items.length>limit&&<button className="secondary full" onClick={()=>setLimit(n=>n+80)}>Plus de styles <ChevronDown size={14}/></button>}
    <div className="preset-browser-footer"><span>{items.length} styles</span><span className="muted tiny">XMP · sRGB · adaptation locale</span></div>
  </section></div>;
}

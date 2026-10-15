import { useSyncExternalStore } from 'react';

const modules = import.meta.glob('../locales/*.json', { eager: true, import: 'default' });
export const dictionaries = Object.fromEntries(Object.entries(modules).map(([path, values]) => [path.split('/').at(-1).replace('.json',''),values]));
export const languages = [
  ['fr','Français'],['nl','Nederlands'],['en','English'],['es','Español'],['zh','简体中文'],['ja','日本語'],['ar','العربية'],['de','Deutsch'],['pt','Português'],['it','Italiano'],['hi','हिन्दी'],['ko','한국어']
];
let current = 'fr';
try { const stored=localStorage.getItem('atelier.language'); if(languages.some(([code])=>code===stored))current=stored; } catch {}
const listeners = new Set(), cache = new Map();
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const templates = Object.keys(dictionaries.fr || {}).filter(key=>/\{\d+\}/.test(key)).sort((a,b)=>b.length-a.length).map(key=>{
  const placeholders=[];
  let pattern='',last=0;
  for(const match of key.matchAll(/\{(\d+)\}/g)){pattern+=escapeRegex(key.slice(last,match.index))+'(.*?)';placeholders.push(Number(match[1]));last=match.index+match[0].length;}
  pattern+=escapeRegex(key.slice(last));
  return {key,placeholders,regex:new RegExp(`^${pattern}$`,'u')};
});
function updateDocument(){document.documentElement.lang=current;document.documentElement.dir=current==='ar'?'rtl':'ltr';}
updateDocument();
export function getLanguage(){return current;}
export function setLanguage(code){
  if(!languages.some(([id])=>id===code))return;
  current=code;cache.clear();try{localStorage.setItem('atelier.language',code);}catch{}updateDocument();for(const listener of listeners)listener();
}
export function useLanguage(){return useSyncExternalStore(callback=>{listeners.add(callback);return()=>listeners.delete(callback);},getLanguage);}
function pluralVariables(key,vars,language){
  const result={...vars};
  if(/étoile\{1\}/.test(key)&&vars[1]==='s')result[1]=({nl:'ren',de:'e',it:'e',ja:'',zh:'',ar:'',hi:'',ko:''})[language]??'s';
  else if(/photo\{1\}/.test(key)&&vars[1]==='s')result[1]=({nl:'’s',it:'',ja:'',zh:'',ar:'',hi:'',ko:''})[language]??'s';
  else if(/sélectionnée\{1\}/.test(key)&&vars[1]==='s')result[1]=({nl:'’s',it:'e',ja:'',zh:'',ar:'',hi:'',ko:''})[language]??'s';
  return result;
}
export function translate(input, language=current){
  if(typeof input!=='string'||language==='fr'||!input.trim())return input;
  const table=dictionaries[language];if(!table)return input;
  const normalized=input.replace(/\s+/g,' ').trim();
  const cacheKey=`${language}:${normalized}`;
  let output=cache.get(cacheKey);
  if(output===undefined){
    output=table[normalized];
    // Whole counters must be recognized before open-ended message templates:
    // "{0} photo{1}" must never consume a selection suffix as its plural.
    const counter=/^([\d\s.,]+) (photos?)(?: · ([\d\s.,]+) sélectionnée(s)?)?$/u.exec(normalized);
    if(output===undefined&&counter){
      output=`${counter[1]} ${table[counter[2]]||counter[2]}`;
      if(counter[3])output+=' '+translate(`· ${counter[3]} sélectionnée${counter[4]||''}`,language);
    }
    if(output===undefined){
      for(const template of templates){const match=template.regex.exec(normalized);if(!match)continue;
        const vars={};template.placeholders.forEach((id,index)=>{vars[id]=match[index+1];});
        if(template.key==='Valeur {0}')vars[0]=translate(vars[0],language);
        if(template.key==='{0} styles importés · {1} ignorés{2}')vars[2]=translate(vars[2],language);
        const localized=pluralVariables(template.key,vars,language);
        output=(table[template.key]||template.key).replace(/\{(\d+)\}/g,(_m,id)=>localized[id]??'');break;
      }
    }
    if(output===undefined){
      const counter=/^([\d\s.,]+) (photos?)$/u.exec(normalized);
      const rating=/^(.*?)(, \d+ étoile(?:s)?)(, retenue)?$/u.exec(normalized);
      if(counter)output=`${counter[1]} ${table[counter[2]]||counter[2]}`;
      else if(rating)output=rating[1]+translate(rating[2],language)+(rating[3]?translate(rating[3],language):'');
      else if(normalized.includes(' · ')){
        output=normalized.split(' · ').map((part,index)=>translate(index?`· ${part}`:part,language)).join(' ');
      }
    }
    if(output===undefined)output=normalized;
    if(cache.size>5000)cache.clear();cache.set(cacheKey,output);
  }
  const leading=input.match(/^\s*/)?.[0]||'',trailing=input.match(/\s*$/)?.[0]||'';
  return leading+output+trailing;
}
export function localizeProps(props){
  if(!props)return props;
  const result={...props};
  for(const key of ['title','subtitle','placeholder','aria-label','alt'])if(typeof result[key]==='string')result[key]=translate(result[key]);
  // This span is the second half of the Atelier Photo wordmark, not a photo counter.
  if(typeof result.className==='string'&&result.className.split(/\s+/).includes('brand-light'))return result;
  if(typeof result.children==='string')result.children=translate(result.children);
  else if(Array.isArray(result.children)){
    if(result.children.every(child=>child===null||child===undefined||typeof child==='string'||typeof child==='number')){
      const joined=result.children.filter(child=>child!==null&&child!==undefined).join('');
      const localized=translate(joined);
      // Prefer whole-message templates so languages can reorder variables. If there
      // is no whole-message translation, preserve known fragments around live values.
      result.children=localized.replace(/\s+/g,' ').trim()===joined.replace(/\s+/g,' ').trim()
        ? result.children.map(child=>typeof child==='string'?translate(child):child)
        : localized;
    }
    else result.children=result.children.map(child=>typeof child==='string'?translate(child):child);
  }
  return result;
}

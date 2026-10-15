import React, { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, FolderOutput, Info, KeyRound, LoaderCircle, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import {LocalAIPanel} from './LocalAIPanel.jsx';

const blue = '#7db7ff';
const providers = [
  { id: 'openai', name: 'OpenAI', url: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Gemini', url: 'https://aistudio.google.com/app/apikey' },
  { id: 'claude', name: 'Claude', url: 'https://console.anthropic.com/settings/keys' },
];
const messageOf = error => error?.message || 'Cette action n’a pas pu être effectuée.';
const fieldStyle = { width: '100%', boxSizing: 'border-box', background: '#111317', color: '#f1f2f4', border: '1px solid #383c44', borderRadius: 8, padding: '10px 12px', font: 'inherit' };
const labelStyle = { display: 'grid', gap: 8, margin: 0, fontSize: 12, color: '#c7cbd2', minWidth: 0 };
const cardStyle = { padding: 18, marginTop: 0, background: '#202329', border: '1px solid #30343c', borderRadius: 12 };

export function ModalFrame({ title, subtitle, icon: Icon, onClose, children, footer, width = 700 }) {
  const headingId = useId();
  const dialog = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = dialog.current;
    frame?.querySelector('button, input, select')?.focus();
    const onKeyDown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab') return;
      const focusable = [...frame.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); frame.focus(); return; }
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const onKeyUp = event => event.stopPropagation();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000a', backdropFilter: 'blur(7px)', display: 'grid', placeItems: 'center', padding: 24 }}>
    <section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
      style={{ width, maxWidth: '100%', maxHeight: 'calc(100vh - 48px)', padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#181a1e', color: '#f1f2f4', border: '1px solid #383c44', borderRadius: 18, boxShadow: '0 28px 100px #0009' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '25px 26px 22px', flexShrink: 0 }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 46, height: 46, flexShrink: 0, color: blue, borderRadius: 12, background: '#7db7ff12' }}><Icon size={23} /></span>
        <div style={{ flex: 1 }}><h2 id={headingId} style={{ margin: '1px 0 6px', fontSize: 23, fontWeight: 600 }}>{title}</h2><p className="muted" style={{ margin: 0, fontSize: 13, color: '#969da9' }}>{subtitle}</p></div>
        <button type="button" className="secondary" onClick={onClose} aria-label="Fermer" style={{ padding: 6, display: 'flex', borderRadius: 8 }}><X size={17} /></button>
      </header>
      <div style={{ padding: '0 26px 24px', overflowY: 'auto', minHeight: 0 }}>{children}</div>
      {footer && <footer style={{ padding: '17px 26px', borderTop: '1px solid #30343c', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 15, flexShrink: 0 }}>{footer}</footer>}
    </section>
  </div>;
}

export function SettingsModal({ onClose, onSaved, notify }) {
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState({ openai: '', gemini: '', claude: '' });
  const [messages, setMessages] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (!window.atelier?.getSettings) { setError('Connexion à l’application indisponible. Rouvrez Atelier Photo.'); return; }
    window.atelier.getSettings().then(value => { if (alive) setSettings(value); }).catch(cause => { if (alive) setError(messageOf(cause)); });
    return () => { alive = false; };
  }, []);

  const updateModel = (key, provider, value) => setSettings(current => ({ ...current, [key]: { ...current[key], [provider]: value } }));
  const keyAction = async (provider, remove = false) => {
    setBusy(`${remove ? 'delete' : 'save'}-${provider}`);
    setMessages(current => ({ ...current, [provider]: null }));
    try {
      const result = remove ? await window.atelier.deleteKey(provider) : await window.atelier.saveKey(provider, drafts[provider].trim());
      // Keep unsaved model and provider choices while refreshing only key status.
      setSettings(current => ({ ...current, keys: result.keys, encryptedStorage: result.encryptedStorage }));
      setDrafts(current => ({ ...current, [provider]: '' }));
      setMessages(current => ({ ...current, [provider]: { text: remove ? 'Clé effacée.' : 'Clé enregistrée.', error: false } }));
      notify?.(remove ? 'Clé effacée.' : 'Clé enregistrée.');
    } catch (cause) {
      setMessages(current => ({ ...current, [provider]: { text: messageOf(cause), error: true } }));
    } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('settings'); setError('');
    try {
      const result = await window.atelier.saveSettings({ provider: settings.provider, models: settings.models, imageModels: settings.imageModels,localAI:settings.localAI });
      onSaved?.(result);
      notify?.('Réglages IA enregistrés.');
      onClose();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(''); }
  };
  const openKeys = async url => {
    try { await window.atelier.openExternal(url); } catch (cause) { setError(messageOf(cause)); }
  };
  const active = providers.find(provider => provider.id === settings?.provider);

  return <ModalFrame title="Votre assistant IA" subtitle="Clé personnelle ou IA sur votre ordinateur." icon={Sparkles} onClose={onClose}
    footer={<><span className="muted" style={{ color: '#969da9', fontSize: 11 }}>{settings?.provider==='local'?'Les performances dépendent de votre matériel.':'Les modèles dépendent des accès de votre compte.'}</span><button type="button" className="primary" onClick={save} disabled={!settings || Boolean(busy)}>{busy === 'settings' ? 'Enregistrement…' : 'Enregistrer'}</button></>}>
    {error && <p role="alert" className="error" style={{ color: '#ff9999', margin: '0 0 16px' }}>{error}</p>}
    {!settings ? !error && <p className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><LoaderCircle size={17} />Chargement des réglages…</p> : <div style={{ display: 'grid', gap: 21 }}>
      <section style={{ display: 'grid', gap: 12 }}>
        <h3 className="section-title" style={{ margin: 0, color: '#969da9', fontSize: 10, letterSpacing: '0.13em' }}>FOURNISSEUR ACTIF</h3>
        <div role="group" aria-label="Fournisseur IA actif" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
          {[...providers,{id:'local',name:'IA locale'}].map(provider => <button type="button" key={provider.id} aria-pressed={settings.provider === provider.id} onClick={() => setSettings(current => ({ ...current, provider: provider.id }))}
            style={{ border: `1px solid ${settings.provider === provider.id ? '#7db7ff66' : '#363a43'}`, borderRadius: 9, padding: '10px 12px', background: settings.provider === provider.id ? '#7db7ff18' : '#202329', color: settings.provider === provider.id ? blue : '#c7cbd2', cursor: 'pointer', font: 'inherit', fontSize: 13 }}>{provider.name}</button>)}
        </div>
        {settings.provider==='local'?<LocalAIPanel value={settings.localAI} onChange={localAI=>setSettings(current=>({...current,localAI}))}/>:<div className="card" style={{ ...cardStyle, display: 'grid', gap: 15 }}>
          <label className="field" style={labelStyle}>Modèle d’analyse · {active?.name}<input value={settings.models?.[settings.provider] || ''} onChange={event => updateModel('models', settings.provider, event.target.value)} maxLength={120} spellCheck={false} style={fieldStyle} /></label>
          {settings.provider !== 'claude' ? <label className="field" style={labelStyle}>Modèle de retouche d’image<input value={settings.imageModels?.[settings.provider] || ''} onChange={event => updateModel('imageModels', settings.provider, event.target.value)} maxLength={120} spellCheck={false} style={fieldStyle} /></label> : <p className="muted" style={{ margin: 0, display: 'flex', gap: 9, fontSize: 12, lineHeight: 1.55, color: '#969da9' }}><Info size={17} style={{ flexShrink: 0, marginTop: 1 }} />Claude analyse les photos et propose des réglages. Pour une retouche générative d’image, choisissez OpenAI, Gemini ou ComfyUI en mode local.</p>}
        </div>}
      </section>
      {settings.provider!=='local'&&<><section style={{ display: 'grid', gap: 10 }}>
        <h3 className="section-title" style={{ margin: '0 0 2px', color: '#969da9', fontSize: 10, letterSpacing: '0.13em' }}>CLÉS PERSONNELLES</h3>
        {providers.map(provider => <div className="card" key={provider.id} style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <KeyRound size={15} color={blue} /><strong style={{ fontSize: 13 }}>{provider.name}</strong>
            <span className="muted" style={{ color: settings.keys?.[provider.id] ? blue : '#969da9', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11 }}>{settings.keys?.[provider.id] && <CheckCircle2 size={12} />}{settings.keys?.[provider.id] ? 'Clé enregistrée' : 'Non connecté'}</span>
            <button type="button" onClick={() => openKeys(provider.url)} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, border: 0, padding: 0, background: 'none', color: blue, cursor: 'pointer', fontSize: 11 }}>Obtenir une clé <ExternalLink size={11} /></button>
          </div>
          <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input aria-label={`Clé API ${provider.name}`} type="password" value={drafts[provider.id]} autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={1024} placeholder={settings.keys?.[provider.id] ? 'Nouvelle clé pour remplacer la clé existante' : 'Collez votre clé API'}
              onChange={event => { const value = event.target.value; setDrafts(current => ({ ...current, [provider.id]: value })); setMessages(current => ({ ...current, [provider.id]: null })); }}
              style={{ ...fieldStyle, minWidth: 0, flex: 1 }} />
            <button type="button" className="secondary" onClick={() => keyAction(provider.id)} disabled={Boolean(busy) || !drafts[provider.id].trim()} style={{ flexShrink: 0 }}>{busy === `save-${provider.id}` ? '…' : 'Sauvegarder'}</button>
            <button type="button" className="secondary" aria-label={`Effacer la clé ${provider.name}`} title="Effacer la clé" onClick={() => keyAction(provider.id, true)} disabled={Boolean(busy) || !settings.keys?.[provider.id]} style={{ display: 'flex', padding: 9 }}><Trash2 size={16} /></button>
          </div>
          {messages[provider.id] && <p role={messages[provider.id].error ? 'alert' : 'status'} className={messages[provider.id].error ? 'error' : ''} style={{ margin: '9px 0 0', fontSize: 11, color: messages[provider.id].error ? '#ff9999' : blue }}>{messages[provider.id].text}</p>}
        </div>)}
      </section>
      <div style={{ display: 'flex', gap: 10, padding: 15, background: '#7db7ff09', borderRadius: 10, color: '#969da9', fontSize: 12, lineHeight: 1.6 }}><ShieldCheck size={19} color={blue} style={{ flexShrink: 0, marginTop: 2 }} /><div>{settings.encryptedStorage ? 'Vos clés sont chiffrées par le système sur cet appareil.' : 'Les clés restent en mémoire pour cette session. Vous devrez les ressaisir au prochain lancement.'}<br />Une photo est transmise au fournisseur choisi uniquement lorsque vous lancez explicitement une action IA.</div></div></>}
    </div>}
  </ModalFrame>;
}

export function ExportModal({ count, onClose, onExport }) {
  const [format, setFormat] = useState('jpeg');
  const [quality, setQuality] = useState(92);
  const [bitDepth,setBitDepth]=useState(16);
  const [maxDimension, setMaxDimension] = useState('');
  const [watermarkEnabled, setWatermarkEnabled] = useState(false);
  const [watermark, setWatermark] = useState('');
  const [error, setError] = useState('');
  const submit = () => {
    try {
      onExport({ format, quality, bitDepth:format==='jpeg'?8:bitDepth, maxDimension: maxDimension ? Number(maxDimension) : null, watermark: watermarkEnabled ? watermark.trim() : '' });
      onClose();
    } catch (cause) { setError(messageOf(cause)); }
  };
  return <ModalFrame title="Exporter vos photos" subtitle={`${Number(count || 0).toLocaleString('fr-FR')} photo${count > 1 ? 's' : ''} à exporter`} icon={FolderOutput} onClose={onClose} width={530}
    footer={<><button type="button" className="secondary" onClick={onClose}>Annuler</button><button type="button" className="primary" onClick={submit} disabled={!count}>Choisir le dossier et exporter</button></>}>
    {error && <p role="alert" className="error" style={{ color: '#ff9999' }}>{error}</p>}
    <div className="card" style={{ ...cardStyle, display: 'grid', gap: 22 }}>
      <div className="field" style={labelStyle}><span>Format</span><div role="group" aria-label="Format d’export" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>{['jpeg', 'png', 'tiff'].map(value => <button key={value} type="button" aria-pressed={format === value} onClick={() => setFormat(value)} style={{ border: `1px solid ${format === value ? '#7db7ff66' : '#383c44'}`, padding: 10, background: format === value ? '#7db7ff18' : '#181a1e', color: format === value ? blue : '#c7cbd2', borderRadius: 8, cursor: 'pointer' }}>{value.toUpperCase()}</button>)}</div></div>
      {format === 'jpeg' && <label className="field" style={labelStyle}><span style={{ display: 'flex', justifyContent: 'space-between' }}>Qualité JPEG <output>{quality} %</output></span><input type="range" aria-label="Qualité JPEG" min={50} max={100} step={1} value={quality} onChange={event => setQuality(Number(event.target.value))} style={{ width: '100%', accentColor: blue }} /></label>}
      {format!=='jpeg'&&<label className="field" style={labelStyle}>Profondeur de couleur<select aria-label="Profondeur de couleur" value={bitDepth} onChange={e=>setBitDepth(Number(e.target.value))} style={fieldStyle}><option value={16}>16 bits par canal</option><option value={8}>8 bits par canal</option></select></label>}
      <label className="field" style={labelStyle}>Dimensions<select aria-label="Dimensions" value={maxDimension} onChange={event => setMaxDimension(event.target.value)} style={fieldStyle}><option value="">Taille originale</option><option value="4096">4 096 px · bord le plus long</option><option value="2048">2 048 px · bord le plus long</option><option value="1600">1 600 px · bord le plus long</option></select></label>
      <div style={{ display: 'grid', gap: 10 }}><label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: '#c7cbd2', cursor: 'pointer' }}><input type="checkbox" checked={watermarkEnabled} onChange={event => setWatermarkEnabled(event.target.checked)} style={{ accentColor: blue }} />Ajouter un filigrane</label><input aria-label="Texte du filigrane" value={watermark} onChange={event => setWatermark(event.target.value)} disabled={!watermarkEnabled} maxLength={200} placeholder="Votre signature" style={{ ...fieldStyle, opacity: watermarkEnabled ? 1 : 0.45 }} /></div>
    </div>
    <p className="muted" style={{ margin: '17px 0 0', fontSize: 12, color: '#969da9' }}>Chaque export crée un nouveau fichier. Vos originaux sont conservés.</p>
  </ModalFrame>;
}

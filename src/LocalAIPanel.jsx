import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, FlaskConical, LoaderCircle, RefreshCw } from 'lucide-react';
import { translate, useLanguage } from './i18n.js';
import { inspectLocalGraphics } from './graphics-capabilities.js';

const blue = '#7db7ff';
const card = { display: 'grid', gap: 12, padding: 16, background: '#202329', border: '1px solid #343943', borderRadius: 12, minWidth: 0 };
const muted = { margin: 0, color: '#a5acb8', fontSize: 12, lineHeight: 1.6 };
const input = { width: '100%', minWidth: 0, boxSizing: 'border-box', background: '#111317', border: '1px solid #3c424e', color: '#f1f2f4', padding: 9, borderRadius: 7, font: 'inherit', fontSize: 12 };
const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 9 };
const label = { display: 'grid', gap: 7, fontSize: 12, minWidth: 0 };
const defaultOllamaURL = 'http://127.0.0.1:11434';
const defaultComfyURL = 'http://127.0.0.1:8188';

export function localEngineOptions(value = {}) {
  if (value.engineMode === 'managed') return { engineMode: 'managed' };
  return { engineMode: 'external', ollamaURL: value.ollamaURL || 'http://127.0.0.1:11434', modelsDirectory: value.modelsDirectory || undefined };
}

/** UI validation complements the main process's authoritative loopback check. */
export function isLocalEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && ['/', ''].includes(url.pathname);
  } catch { return false; }
}

/** Unknown measurements remain usable with a caution; confirmed shortages block pulls. */
export function localDownloadState(hardware, recommendation) {
  if (!hardware) return { allowed: false, reason: 'diagnostic' };
  if (!recommendation) return { allowed: false, reason: 'model' };
  if (recommendation.assessment?.status === 'insufficient') return { allowed: false, reason: 'assessment' };
  const available = hardware.storage?.freeBytes, required = recommendation.assessment?.requiredDiskBytes;
  const storageVerified = hardware.storage?.configurationVerified !== false;
  if (storageVerified && Number.isFinite(available) && available >= 0 && Number.isFinite(required) && required > available) return { allowed: false, reason: 'disk' };
  return { allowed: true, unknown: !storageVerified || recommendation.assessment?.status === 'unknown' || !Number.isFinite(available) || available < 0
    || !Number.isFinite(required) || required < 0 || !Number.isFinite(hardware.memory?.totalBytes) || hardware.memory.totalBytes <= 0 };
}

function formatMessage(key, ...values) {
  return translate(key).replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
}
function reasonText(code) {
  const normalized = String(code).toLowerCase().replaceAll('-', '_');
  const messages = {
    engine_platform_unsupported: 'Ce moteur intégré n’est pas disponible pour ce système.',
    engine_os_too_old: 'Cette version du système est trop ancienne pour le moteur intégré.',
    engine_os_unverified: 'La compatibilité de cette version du système reste à vérifier.',
    resource_estimates_only: 'Ces recommandations sont des estimations ; testez le modèle sur cet ordinateur.',
    model_download_size_unknown: 'La taille du téléchargement reste à vérifier.',
    storage_unknown: 'L’espace du dossier des modèles reste à vérifier.',
    storage_below_required: 'L’espace disponible est insuffisant pour ce modèle.',
    memory_requirements_unknown: 'Les besoins en mémoire restent à vérifier.',
    memory_below_minimum: 'La mémoire vive est insuffisante pour ce modèle.',
    working_memory_above_total: 'La mémoire vive est insuffisante pour ce modèle.',
    memory_below_recommended: 'La mémoire disponible est limitée ; l’analyse peut être lente.',
    free_memory_unknown: 'Les besoins en mémoire restent à vérifier.',
    free_memory_low: 'La mémoire libre est basse ; le système peut encore récupérer de la mémoire.',
    cpu_only_slow: 'L’analyse utilisera le processeur et peut être lente.',
    gpu_multiple_devices: 'Plusieurs cartes graphiques ont été détectées.',
    gpu_unified_memory_shared: 'La mémoire graphique est partagée avec la mémoire vive.',
    gpu_backend_unverified: 'Les performances graphiques restent à vérifier.',
  };
  if (messages[normalized]) return messages[normalized];
  if (/disk|storage.*insufficient|insufficient.*storage/.test(normalized) && !/unknown|unverified/.test(normalized)) return 'L’espace disponible est insuffisant pour ce modèle.';
  if (/ram|memory/.test(normalized) && /low|insufficient|minimum/.test(normalized)) return 'La mémoire vive est insuffisante pour ce modèle.';
  if (/cpu|no_acceleration|unsupported_gpu/.test(normalized)) return 'L’analyse utilisera le processeur et peut être lente.';
  if (/storage|model.*path|disk/.test(normalized)) return 'L’espace du dossier des modèles reste à vérifier.';
  if (/gpu|vram|acceleration/.test(normalized)) return 'Les performances graphiques restent à vérifier.';
  return 'Certaines informations matérielles n’ont pas pu être vérifiées.';
}
function phaseText(event) {
  const status = String(event?.phase || event?.status || '').toLowerCase();
  const runtime = ['runtime', 'local-runtime'].includes(event?.kind);
  if (runtime && /extract|unpack/.test(status)) return 'Extraction du moteur…';
  if (runtime && /starting|launch/.test(status)) return 'Démarrage du moteur…';
  if (runtime && /stopping/.test(status)) return 'Arrêt du moteur…';
  if (/verif|digest|sha|check/.test(status)) return 'Vérification des fichiers…';
  if (/success|complete|termin|ready/.test(status)) return runtime ? 'La préparation du moteur est en cours.' : 'Téléchargement terminé.';
  if (runtime && /download|pull/.test(status)) return 'Téléchargement du moteur…';
  if (runtime) return Number.isFinite(event?.totalBytes) && event.totalBytes > 0 ? 'Téléchargement du moteur…' : 'Installation du moteur…';
  return Number.isFinite(event?.totalBytes) && event.totalBytes > 0 ? 'Téléchargement du modèle…' : 'Préparation du téléchargement…';
}
const modelNames = values => (Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? value : value?.name).filter(value => typeof value === 'string' && value.length > 0);
const compatibleModels = status => (Array.isArray(status?.models) ? status.models : []).filter(model => typeof model?.name === 'string' && model.name.length > 0
  && model.local === true && !model.remote_host && !model.remote_model && Array.isArray(model.capabilities) && model.capabilities.includes('vision'));

export function LocalAIPanel({ value = {}, onChange }) {
  const language = useLanguage();
  const [hardware, setHardware] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [status, setStatus] = useState(null);
  const [comfy, setComfy] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState(null);
  const [benchmark, setBenchmark] = useState(null);
  const [engine, setEngine] = useState(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const alive = useRef(true), pulling = useRef(false), cancelling = useRef(false), current = useRef(value), busyRef = useRef(false), progressRevision = useRef(0), localJobRef = useRef(false);
  current.current = value;
  const api = window.atelier;
  const ollamaURL = value.ollamaURL ?? defaultOllamaURL;
  const comfyURL = value.comfyURL ?? defaultComfyURL;
  const selected = value.model || '';
  const engineMode = value.engineMode === 'managed' ? 'managed' : 'external';
  const activeJob = progress || engine?.job;
  const locked = Boolean(busy || activeJob);
  const models = compatibleModels(status);
  const selectedReady = status?.available === true && models.some(model => model.name === selected);
  const modelVerified = name => benchmark?.model === name && benchmark.mode === engineMode && (engineMode === 'managed' || benchmark.url === ollamaURL);
  const refreshEngine = async () => {
    if (typeof api?.localEngineStatus !== 'function') return null;
    const revision = progressRevision.current;
    const snapshot = await api.localEngineStatus();
    if (alive.current && revision === progressRevision.current) {
      setEngine(snapshot);
      localJobRef.current = Boolean(snapshot?.job);
      if (!snapshot?.job) {
        setProgress(null); setCancellingJob(false); cancelling.current = false;
        if (typeof snapshot?.lastResult?.error === 'string') setError(snapshot.lastResult.error);
        else if (snapshot?.lastResult?.cancelled) setNotice(snapshot.lastResult.kind === 'runtime' ? 'Installation du moteur annulée.' : 'Téléchargement annulé.');
      }
    }
    return snapshot;
  };

  useEffect(() => {
    alive.current = true;
    refreshEngine().catch(cause => { if (alive.current) setError(cause?.message || 'Cette action n’a pas pu être effectuée.'); });
    const unsubscribe = window.atelier?.onProgress?.(event => {
      if (!alive.current) return;
      if (['local-runtime', 'local-model'].includes(event?.kind)) {
        progressRevision.current++; localJobRef.current = true;
        setProgress({ ...event, kind: event.kind === 'local-runtime' ? 'runtime' : 'model' });
      } else if (event === null && localJobRef.current) {
        progressRevision.current++;
        refreshEngine().catch(cause => { if (alive.current) setError(cause?.message || 'Cette action n’a pas pu être effectuée.'); });
      }
    });
    return () => { alive.current = false; if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(() => { refreshEngine().catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [Boolean(activeJob)]);

  const change = patch => { if (alive.current) { current.current = { ...current.current, ...patch }; onChange?.(current.current); } };
  const switchMode = next => { change({ engineMode: next }); setHardware(null); setRecommendations([]); setStatus(null); setBenchmark(null); setError(''); };
  const bytes = count => {
    if (!Number.isFinite(count) || count < 0) return translate('Information indisponible');
    const unit = count >= 1e9 ? 'GB' : count >= 1e6 ? 'MB' : 'KB';
    const divisor = unit === 'GB' ? 1e9 : unit === 'MB' ? 1e6 : 1e3;
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(count / divisor)} ${unit}`;
  };
  const fail = cause => { if (alive.current) setError(cause?.message || 'Cette action n’a pas pu être effectuée.'); };
  const invoke = async (name, argument) => {
    if (typeof api?.[name] !== 'function') throw new Error('Connexion à l’application indisponible. Rouvrez Atelier Photo.');
    return api[name](argument);
  };
  const operation = async (name, action) => {
    if (busyRef.current || locked) return;
    busyRef.current = true;
    setBusy(name); setError(''); setNotice('');
    try { await action(); } catch (cause) { fail(cause); } finally { busyRef.current = false; if (alive.current) setBusy(''); }
  };
  const endpoint = url => {
    if (!isLocalEndpoint(url)) throw new Error('Utilisez une adresse locale valide, comme http://127.0.0.1:11434.');
    return url;
  };
  const inspect = async (options = localEngineOptions(current.current)) => {
    if (options.engineMode === 'external') endpoint(options.ollamaURL);
    const result = await invoke('localStatus', options);
    if (alive.current) setStatus(result);
    return result;
  };
  const diagnose = () => operation('hardware', async () => {
    setHardware(null); setRecommendations([]); setBenchmark(null);
    const options = localEngineOptions(current.current);
    const results = await Promise.allSettled([invoke('localHardware', options), invoke('localRecommendations', options)]);
    if (!alive.current) return;
    if (results[0].status === 'fulfilled') setHardware({ ...results[0].value, graphics: inspectLocalGraphics() });
    if (results[1].status === 'fulfilled') setRecommendations(Array.isArray(results[1].value) ? results[1].value : []);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
  const pull = recommendation => operation('pull', async () => {
    if (!localDownloadState(hardware, recommendation).allowed) return;
    const options = localEngineOptions(current.current);
    if (options.engineMode === 'external') endpoint(options.ollamaURL);
    pulling.current = true; cancelling.current = false; setProgress(null); setBenchmark(null);
    try {
      const result = await invoke('localPull', { model: recommendation.id, ...options });
      if (!alive.current) return;
      if (result?.cancelled || cancelling.current) { setNotice('Téléchargement annulé.'); return; }
      const next = await inspect();
      if (compatibleModels(next).some(model => model.name === recommendation.id)) change({ model: recommendation.id });
      setNotice('Les téléchargements sont terminés. Testez le modèle avant d’analyser vos photos.');
    } catch (cause) {
      if (cancelling.current || cause?.name === 'AbortError') { if (alive.current) setNotice('Téléchargement annulé.'); }
      else throw cause;
    } finally { pulling.current = false; cancelling.current = false; await refreshEngine().catch(() => {}); }
  });
  const cancelPull = async () => {
    if (cancelling.current || cancellingJob) return;
    cancelling.current = true;
    setCancellingJob(true);
    try { await invoke(activeJob?.kind === 'runtime' ? 'cancelLocalEngineInstall' : 'cancelLocalPull'); } catch (cause) { cancelling.current = false; setCancellingJob(false); fail(cause); }
  };
  const testModel = () => operation('benchmark', async () => {
    setBenchmark(null);
    const options = localEngineOptions(current.current);
    if (options.engineMode === 'external') endpoint(options.ollamaURL);
    const result = await invoke('localBenchmark', { model: selected, ...options });
    if (result?.validRecipe !== true) throw new Error('Le modèle n’a pas renvoyé de réglages valides.');
    if (alive.current) setBenchmark({ ...result, model: selected, url: ollamaURL, mode: engineMode });
    await refreshEngine();
  });
  const inspectComfy = () => operation('comfy', async () => {
    const result = await invoke('comfyStatus', { ...localEngineOptions(current.current), baseURL: endpoint(comfyURL) });
    if (alive.current) setComfy(result);
  });
  const chooseDirectory = () => operation('directory', async () => {
    if (current.current.engineMode === 'managed') return;
    const directory = await invoke('chooseLocalModelDirectory');
    if (typeof directory === 'string' && directory && alive.current) {
      change({ modelsDirectory: directory }); setHardware(null); setRecommendations([]); setBenchmark(null);
    }
  });
  const installEngine = () => operation('engineInstall', async () => {
    if (!hardware || current.current.engineMode !== 'managed') return;
    try {
      const result = await invoke('localEngineInstall');
      if (!alive.current) return;
      setEngine(result);
      if (result?.cancelled) { setNotice('Installation du moteur annulée.'); return; }
      if (result?.installed) change({ engineMode: 'managed' });
      if (result?.running) { await inspect({ engineMode: 'managed' }); setNotice('Moteur installé et démarré.'); }
    } finally { await refreshEngine().catch(() => {}); }
  });
  const startEngine = () => operation('engineStart', async () => {
    const result = await invoke('localEngineStart');
    if (!alive.current) return;
    setEngine(result); change({ engineMode: 'managed' });
    if (result?.running) await inspect({ engineMode: 'managed' });
  });
  const stopEngine = () => operation('engineStop', async () => {
    const result = await invoke('localEngineStop');
    if (alive.current) { setEngine(result); setStatus(null); setBenchmark(null); }
  });
  const updateComfyModel = (key, name) => change({ comfyModels: { ...current.current.comfyModels, [key]: name } });
  const warnings = hardware ? [...new Set([
    ...(Array.isArray(hardware.warnings) ? hardware.warnings : []).map(reasonText),
    ...(!hardware.gpu?.name || hardware.gpu?.accelerationHint === 'unknown' ? ['Les performances graphiques restent à vérifier.'] : []),
    ...(hardware.gpu?.kind === 'cpu' || hardware.gpu?.accelerationHint === 'cpu' ? ['L’analyse utilisera le processeur et peut être lente.'] : []),
  ])] : [];
  const completed = Math.max(0, Number.isFinite(activeJob?.completedBytes) ? activeJob.completedBytes : 0);
  const total = Number.isFinite(activeJob?.totalBytes) && activeJob.totalBytes > 0 ? activeJob.totalBytes : null;
  const runtimeDiskShortage = hardware?.storage?.configurationVerified !== false && Number.isFinite(hardware?.storage?.freeBytes) && Number.isFinite(engine?.requiredDiskBytes) && hardware.storage.freeBytes < engine.requiredDiskBytes;
  const installAllowed = engineMode === 'managed' && hardware && engine?.supported === true && !runtimeDiskShortage && recommendations.some(model => localDownloadState(hardware, model).allowed);
  const assessmentLabel = status => ({ recommended: 'Recommandé', slow: 'Analyse plus lente', insufficient: 'Prérequis insuffisants', unknown: 'À vérifier' })[status] || 'À vérifier';

  return <div data-testid="local-ai-panel" style={{ display: 'grid', gap: 15, color: '#e9edf4' }}>
    <div style={{ ...row, color: blue }}><CheckCircle2 size={16} aria-hidden="true" /><strong>Analyse et réglages</strong><span style={{ fontSize: 12 }}>Aucune clé API nécessaire.</span></div>
    <p style={muted}>Analyser les photos et proposer des réglages. Le moteur photo applique les corrections en 16 bits.</p>
    <p style={muted}>Une connexion Internet est nécessaire pour télécharger le moteur et les modèles. L’analyse s’effectue ensuite sur cet ordinateur.</p>
    {error && <p role="alert" className="error" style={{ ...muted, color: '#ffaaaa', overflowWrap: 'anywhere' }}>{translate(error)}</p>}
    {notice && <p role="status" style={{ ...muted, color: blue }}>{translate(notice)}</p>}
    <div role="group" aria-label="Choix du moteur d’analyse local" style={row} data-testid="local-engine-mode">
      <button type="button" className={engineMode === 'managed' ? 'primary' : 'secondary'} aria-pressed={engineMode === 'managed'} disabled={locked} onClick={() => switchMode('managed')}>Utiliser le moteur intégré</button>
      <button type="button" className={engineMode === 'external' ? 'primary' : 'secondary'} aria-pressed={engineMode === 'external'} disabled={locked} onClick={() => switchMode('external')}>Utiliser une installation existante</button>
    </div>
    {activeJob && <div role="status" aria-live="polite" style={{ ...card, borderColor: '#466fa8' }}>
      <p style={{ margin: 0, fontSize: 12 }}>{translate(phaseText(activeJob))}</p>
      <progress aria-label={activeJob.kind === 'runtime' ? 'Téléchargement du moteur…' : 'Téléchargement du modèle…'} max={total || undefined} value={total ? Math.min(completed, total) : undefined} style={{ width: '100%', accentColor: blue }} />
      {total && <span style={muted}>{formatMessage('Téléchargement : {0} sur {1}', bytes(completed), bytes(total))}</span>}
      <p style={muted}>Le téléchargement peut continuer pendant que les réglages sont fermés.</p>
      <button type="button" className="secondary" disabled={cancellingJob} style={{ justifySelf: 'start' }} onClick={cancelPull}>{activeJob.kind === 'runtime' ? 'Annuler l’installation' : 'Annuler le téléchargement'}</button>
    </div>}

    <section style={card} aria-label="Diagnostic local">
      <div style={{ ...row, justifyContent: 'space-between' }}><h3 style={{ margin: 0, fontSize: 14 }}>Vérifier cet ordinateur</h3><button type="button" className="secondary" onClick={diagnose} disabled={locked}>{busy === 'hardware' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} {busy === 'hardware' ? 'Vérification de cet ordinateur…' : 'Vérifier cet ordinateur'}</button></div>
      {hardware && <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 1fr) minmax(0, 2fr)', gap: '8px 12px', margin: 0, fontSize: 12 }}>
        <dt>Système</dt><dd style={{ margin: 0 }}>{({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[hardware.platform] || hardware.platform || translate('Information indisponible')}</dd>
        <dt>Version du système</dt><dd style={{ margin: 0 }}>{hardware.osVersion || translate('Information indisponible')}</dd>
        <dt>Architecture</dt><dd style={{ margin: 0 }}>{hardware.arch || translate('Information indisponible')}</dd>
        <dt>Processeur</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{hardware.cpu?.name || translate('Information indisponible')}</dd>
        <dt>Mémoire vive</dt><dd style={{ margin: 0 }}>{bytes(hardware.memory?.totalBytes)}</dd>
        <dt>Mémoire libre mesurée</dt><dd style={{ margin: 0 }}>{bytes(hardware.memory?.freeBytes)}</dd>
        <dt>Carte graphique</dt><dd style={{ margin: 0 }}>{hardware.gpu?.name || translate('Information indisponible')}</dd>
        <dt>Mémoire graphique</dt><dd style={{ margin: 0 }}>{bytes(hardware.gpu?.vramBytes)}</dd>
        <dt>Espace disponible</dt><dd style={{ margin: 0 }}>{bytes(hardware.storage?.freeBytes)}</dd>
        <dt>Dossier des modèles</dt><dd dir="ltr" style={{ margin: 0, overflowWrap: 'anywhere' }}>{hardware.storage?.path || translate('Information indisponible')}</dd>
        <dt>Détection des visages : contexte graphique</dt><dd style={{ margin: 0 }}>{hardware.graphics?.webgl === true ? 'Compatible' : 'Indisponible'}</dd>
        <dt>Vue spatiale : contexte graphique</dt><dd style={{ margin: 0 }}>{hardware.graphics?.webgl2 === true ? 'Compatible' : 'Indisponible'}</dd>
      </dl>}
      {hardware?.graphics && (!hardware.graphics.webgl || !hardware.graphics.webgl2) && <p style={muted}>Un pilote graphique compatible est nécessaire pour ces fonctions. Les réglages classiques et l’analyse Ollama restent disponibles.</p>}
      {warnings.map(message => <p style={muted} key={message}>{translate(message)}</p>)}
      {engineMode === 'external' && <><div style={row}><button type="button" className="secondary" onClick={chooseDirectory} disabled={locked}>Choisir le dossier des modèles</button></div>
      {value.modelsDirectory && <p dir="ltr" style={{ ...muted, overflowWrap: 'anywhere' }}>{value.modelsDirectory}</p>}
      <p style={muted}>Ce dossier sert à mesurer l’espace disponible. Il doit correspondre au dossier utilisé par Ollama ; ce choix ne modifie pas sa configuration.</p></>}
      <p style={muted}>Ce diagnostic reste sur votre ordinateur.</p>
    </section>

    <section style={card} aria-label="Moteur intégré Ollama" data-testid="managed-engine-panel">
      <div style={{ ...row, justifyContent: 'space-between' }}><h3 style={{ margin: 0, fontSize: 14 }}>Moteur intégré Ollama</h3><span style={{ color: blue, fontSize: 11 }}>Gratuit · sans frais API</span></div>
      <p style={muted}>Le moteur et ses modèles sont gérés par Atelier Photo, sans clé API ni droits administrateur.</p>
      <p role="status" style={{ ...muted, color: blue }}>{engine === null ? 'Service non vérifié' : engine.running ? 'Moteur en cours d’exécution' : engine.installed ? 'Moteur arrêté' : 'Moteur non installé'}</p>
      {engine?.supported === false && <p role="alert" style={{ ...muted, color: '#ffaaaa' }}>Ce moteur intégré n’est pas disponible pour ce système.</p>}
      {engine?.version && <p dir="ltr" style={muted}>Ollama {engine.version}</p>}
      {Number.isFinite(engine?.downloadBytes) && <p style={muted}>{formatMessage('Téléchargement du moteur : {0}', bytes(engine.downloadBytes))}</p>}
      {Number.isFinite(engine?.requiredDiskBytes) && <p style={muted}>{formatMessage('Espace nécessaire : {0}', bytes(engine.requiredDiskBytes))}</p>}
      {engine?.license && <p style={muted}>{formatMessage('Licence : {0}', engine.license)}</p>}
      {engine?.runtimeDirectory && <p style={muted}><span>Dossier du moteur</span><br /><code dir="ltr" style={{ overflowWrap: 'anywhere' }}>{engine.runtimeDirectory}</code></p>}
      {engine?.modelsDirectory && <p style={muted}><span>Dossier des modèles</span><br /><code dir="ltr" style={{ overflowWrap: 'anywhere' }}>{engine.modelsDirectory}</code></p>}
      {runtimeDiskShortage && engineMode === 'managed' && <p style={{ ...muted, color: '#ffaaaa' }}>L’espace disponible est insuffisant pour ce modèle.</p>}
      <div style={row}>
        <button type="button" className="primary" data-testid="managed-runtime-install" disabled={locked || !installAllowed || engine?.installed} onClick={installEngine}><Download size={14} aria-hidden="true" /> {busy === 'engineInstall' ? 'Installation du moteur…' : 'Installer le moteur local'}</button>
        <button type="button" className="secondary" data-testid="managed-engine-start" disabled={locked || engineMode !== 'managed' || !engine?.installed || engine?.running} onClick={startEngine}>{busy === 'engineStart' ? 'Démarrage du moteur…' : 'Démarrer le moteur'}</button>
        <button type="button" className="secondary" data-testid="managed-engine-stop" disabled={locked || !engine?.running} onClick={stopEngine}>{busy === 'engineStop' ? 'Arrêt du moteur…' : 'Arrêter le moteur'}</button>
        <button type="button" className="secondary" disabled={locked} onClick={() => operation('engineStatus', refreshEngine)}>Vérifier le moteur</button>
      </div>
      <p style={muted}>Aucun téléchargement ne démarre sans votre action.</p>
      <p style={muted}>Le moteur intégré s’arrête lorsque vous quittez Atelier Photo.</p>
    </section>

    <details style={card} open={engineMode === 'external'}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>Installation existante · options avancées</summary>
      <p style={muted}>Utilisez cette section pour un service Ollama que vous gérez vous-même.</p>
      <label style={label}>Adresse du moteur local<input type="url" aria-label="Adresse du moteur local" value={ollamaURL} disabled={locked || engineMode !== 'external'} spellCheck={false} dir="ltr" style={input} onChange={event => { change({ ollamaURL: event.target.value }); setStatus(null); setBenchmark(null); }} /></label>
      <p style={muted}>Seules les adresses de cet ordinateur sont acceptées.</p>
      <button type="button" className="secondary" style={{ justifySelf: 'start' }} disabled={locked || !hardware} onClick={() => operation('installer', () => invoke('openLocalInstaller', { engine: 'ollama' }))}><ExternalLink size={14} aria-hidden="true" /> Installer Ollama manuellement</button>
      <p style={muted}>Le bouton ouvre les instructions officielles. L’installation reste à votre initiative.</p>
    </details>

    <section style={card} aria-label="Modèle d’analyse local">
      <span role="status" style={{ color: status?.available ? blue : '#a5acb8', fontSize: 12 }}>{status === null ? 'Service non vérifié' : status.available ? 'Service local disponible' : 'Le service local ne répond pas. Ouvrez Ollama, puis réessayez.'}</span>
      <div style={row}><button type="button" className="secondary" disabled={locked} onClick={() => operation('status', () => inspect())}>{busy === 'status' && <LoaderCircle size={14} className="spin" aria-hidden="true" />} {busy === 'status' ? 'Recherche des modèles…' : 'Détecter les modèles'}</button></div>
      <label style={label}>Modèle d’analyse local<select aria-label="Modèle d’analyse local" value={selected} disabled={locked} style={input} onChange={event => { change({ model: event.target.value }); setBenchmark(null); }}>
        <option value="">Choisir un modèle installé</option>
        {selected && !models.some(model => model.name === selected) && <option value={selected}>{selected}</option>}
        {models.map(model => <option key={model.name} value={model.name}>{model.name} · {bytes(model.size)}</option>)}
      </select></label>
      {status?.available && models.length === 0 && <p style={muted}>Aucun modèle compatible installé.</p>}
      {status?.available && selected && !models.some(model => model.name === selected) && <p style={muted}>Ce modèle ne peut pas analyser les photos.</p>}
      <div style={row}><button type="button" className="secondary" disabled={locked || !selectedReady} onClick={testModel}><FlaskConical size={14} aria-hidden="true" /> {busy === 'benchmark' ? 'Test local en cours…' : 'Tester ce modèle'}</button></div>
      <p style={muted}>Le test utilise une image synthétique et ne transmet aucune photo personnelle.</p>
      {modelVerified(selected) && <div role="status" style={{ display: 'grid', gap: 3, color: blue, fontSize: 12 }}>
        <span>Modèle vérifié</span>
        {Number.isFinite(benchmark.elapsedMs) && benchmark.elapsedMs >= 0 && <span>{formatMessage('Réponse vérifiée en {0} s', new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(benchmark.elapsedMs / 1000))}</span>}
        <span>{translate(({ cpu: 'Accélération : processeur', gpu: 'Accélération : carte graphique', hybrid: 'Accélération : processeur et carte graphique' })[benchmark.acceleration] || 'Accélération non déterminée')}</span>
      </div>}
    </section>

    <section style={card} aria-label="Modèles conseillés pour cet ordinateur">
      <h3 style={{ margin: 0, fontSize: 14 }}>Modèles conseillés pour cet ordinateur</h3>
      {!hardware && <p style={muted}>Vérifiez cet ordinateur avant de télécharger un modèle.</p>}
      {recommendations.map(recommendation => {
        const availability = localDownloadState(hardware, recommendation);
        const reasons = [...new Set((recommendation.assessment?.reasons || []).map(reasonText))];
        if (availability.reason === 'disk' && !reasons.includes('L’espace disponible est insuffisant pour ce modèle.')) reasons.push('L’espace disponible est insuffisant pour ce modèle.');
        if (availability.unknown && !reasons.includes('Certaines informations matérielles n’ont pas pu être vérifiées.')) reasons.push('Certaines informations matérielles n’ont pas pu être vérifiées.');
        const installed = models.some(model => model.name === recommendation.id);
        return <article key={recommendation.id} style={{ display: 'grid', gap: 8, paddingTop: 12, borderTop: '1px solid #363c46' }}>
          <div style={{ ...row, justifyContent: 'space-between' }}><strong style={{ fontSize: 12 }}>{recommendation.name || recommendation.id}</strong><span style={{ fontSize: 11, color: recommendation.assessment?.status === 'insufficient' ? '#ffb4a5' : blue }}>{translate(assessmentLabel(recommendation.assessment?.status))}</span></div>
          <p style={muted}>{formatMessage(recommendation.downloadEstimated ? 'Environ {0} à télécharger' : '{0} à télécharger', bytes(recommendation.downloadBytes))}</p>
          {Number.isFinite(recommendation.assessment?.requiredDiskBytes) && <p style={muted}>{formatMessage('Espace conseillé : {0}', bytes(recommendation.assessment.requiredDiskBytes))}</p>}
          {recommendation.license && <p style={muted}>{formatMessage('Licence : {0}', recommendation.license)}</p>}
          {reasons.map(message => <p key={message} style={muted}>{translate(message)}</p>)}
          <button type="button" className="secondary" style={{ justifySelf: 'start' }} disabled={locked || !availability.allowed || (engineMode === 'managed' ? !engine?.installed : status?.available !== true) || installed} onClick={() => pull(recommendation)}><Download size={14} aria-hidden="true" /> {installed ? modelVerified(recommendation.id) ? 'Modèle vérifié' : 'Modèle téléchargé · test nécessaire' : formatMessage('Télécharger {0}', recommendation.name || recommendation.id)}</button>
        </article>;
      })}
    </section>

    <details style={card}>
      <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>Retouche générative locale</summary>
      <p style={muted}>La génération de nouvelles images utilise ComfyUI, installé séparément.</p>
      <p style={muted}>ComfyUI utilise des modèles séparés pour créer de nouvelles images. Aucun modèle génératif n’est téléchargé ici.</p>
      <button type="button" className="secondary" title="Ouvrir la page officielle d’installation de ComfyUI" disabled={locked || !hardware} style={{ justifySelf: 'start' }} onClick={() => operation('comfyInstaller', () => invoke('openLocalInstaller', { engine: 'comfyui' }))}><ExternalLink size={14} aria-hidden="true" /> Installer ComfyUI</button>
      <label style={label}>Adresse de ComfyUI<input type="url" aria-label="Adresse de ComfyUI" value={comfyURL} disabled={locked} spellCheck={false} dir="ltr" style={input} onChange={event => { change({ comfyURL: event.target.value }); setComfy(null); }} /></label>
      <button type="button" className="secondary" disabled={locked} style={{ justifySelf: 'start' }} onClick={inspectComfy}>{busy === 'comfy' && <LoaderCircle size={14} className="spin" aria-hidden="true" />} {busy === 'comfy' ? 'Recherche de ComfyUI…' : 'Détecter ComfyUI'}</button>
      {comfy && <p role="status" style={muted}>{comfy.ready ? 'Configuration disponible' : comfy.missingNodes?.length > 0 ? 'Prérequis insuffisants' : 'Le service ComfyUI ne répond pas. Lancez-le, puis réessayez.'}</p>}
      {comfy?.assessment && <div role={comfy.assessment.status === 'insufficient' ? 'alert' : 'status'} style={{ display: 'grid', gap: 7 }}>
        {comfy.assessment.status === 'insufficient' && <p style={{ ...muted, color: '#ffaaaa' }}>La mémoire vive mesurée est insuffisante pour cette retouche générative locale.</p>}
        <p style={muted}>{Number.isFinite(comfy.assessment.requiredMemoryBytes) && comfy.assessment.requiredMemoryBytes > 0
          ? formatMessage('Budget mémoire estimé : {0}', bytes(comfy.assessment.requiredMemoryBytes))
          : translate('Les besoins en mémoire restent à vérifier.')}</p>
        <p style={muted}>Cette estimation n’est pas un minimum officiel. Le besoin réel dépend des modèles et de la taille de la photo.</p>
      </div>}
      {Array.isArray(comfy?.missingNodes) && comfy.missingNodes.length > 0 && <p style={muted}>{formatMessage('Composants manquants : {0}', comfy.missingNodes.join(', '))}</p>}
      {comfy?.models && <div style={{ display: 'grid', gap: 12 }}>
        {['diffusion', 'textEncoder', 'vae'].map((key, index) => {
          const title = ['Modèle de diffusion', 'Encodeur de texte', 'Décodeur VAE'][index], names = modelNames(comfy.models[key]), name = value.comfyModels?.[key] || '';
          return <label key={key} style={label}>{translate(title)}<select aria-label={translate(title)} value={name} disabled={locked} style={input} onChange={event => updateComfyModel(key, event.target.value)}>
            <option value="">Choisir un modèle</option>{name && !names.includes(name) && <option value={name}>{name}</option>}{names.map(name => <option key={name} value={name}>{name}</option>)}
          </select></label>;
        })}
      </div>}
      <p style={muted}>Les chemins des modèles sont fournis par votre installation ComfyUI.</p>
    </details>
  </div>;
}

export default LocalAIPanel;

import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Image as ImageIcon, Images, LoaderCircle, Star } from 'lucide-react';

const PAGE_SIZE = 200;
const MAX_PAGES = 6;
const ROW_HEIGHT = 210;
const GAP = 14;
const blue = '#7db7ff';

const PhotoCard = memo(function PhotoCard({ item, active, selected, onSelect, onOpen }) {
  const [broken, setBroken] = useState(false);
  return <button type="button" role="gridcell" data-testid="photo-card" data-photo-id={item.id} aria-selected={selected}
    aria-label={`${item.name}${item.rating ? `, ${item.rating} étoile${item.rating > 1 ? 's' : ''}` : ''}${item.picked ? ', retenue' : ''}`}
    className={`photo-card${active ? ' active' : ''}${selected ? ' selected' : ''}`}
    onClick={event => onSelect(item, event)} onDoubleClick={() => onOpen?.(item)} title={item.name}
    style={{ minWidth: 0, height: 196, padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', textAlign: 'left', color: '#eff1f5', background: selected ? '#7db7ff10' : '#1c1f24', border: `1px solid ${active ? blue : selected ? '#7db7ff88' : '#30343c'}`, borderRadius: 10, overflow: 'hidden', cursor: 'pointer', outlineOffset: 3 }}>
    <div style={{ position: 'relative', height: 143, flexShrink: 0, background: '#131519', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <span style={{ color: '#555d6b', display: 'grid', justifyItems: 'center', gap: 7 }}><ImageIcon size={25} strokeWidth={1.3} />{broken && <span style={{ fontSize: 10 }}>Aperçu indisponible</span>}</span>
      {!broken && <img src={`atelier://thumbnail/${encodeURIComponent(item.id)}`} alt="" draggable={false} decoding="async" onError={() => setBroken(true)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />}
      {item.picked && <span aria-hidden="true" style={{ position: 'absolute', right: 8, top: 8, width: 22, height: 22, display: 'grid', placeItems: 'center', borderRadius: 6, background: blue, color: '#101723' }}><Check size={14} strokeWidth={2.5} /></span>}
      {selected && <span aria-hidden="true" style={{ position: 'absolute', left: 8, top: 8, width: 18, height: 18, display: 'grid', placeItems: 'center', borderRadius: 4, background: '#101723bb', border: `1px solid ${blue}`, color: blue }}><Check size={12} /></span>}
    </div>
    <div style={{ padding: '9px 11px', display: 'grid', gap: 5 }}>
      <span style={{ display: 'block', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '14px' }}>{item.name}</span>
      <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 3, color: item.rating ? blue : '#555d6b', height: 12 }}>{Array.from({ length: 5 }, (_, index) => <Star key={index} size={10} fill={index < item.rating ? blue : 'none'} strokeWidth={1.4} />)}</span>
    </div>
  </button>;
});

/** The DOM contains visible rows only; the metadata LRU holds at most six pages. */
export function VirtualLibrary({ query = {}, refreshToken, activeId, selectedIds, onSelect, onOpen, onSelectionChange, onTotal }) {
  const viewport = useRef(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const [total, setTotal] = useState(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cache = useRef(new Map());
  const pending = useRef(new Set());
  const failed = useRef(new Set());
  const queue = useRef([]);
  const activeRequests = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  const wantedPages = useRef(new Set([0]));
  const totalValue = useRef(null);
  const onTotalRef = useRef(onTotal);
  onTotalRef.current = onTotal;
  const queryKey = JSON.stringify([query.search || '', query.filter || 'all', query.sort || 'added']);
  const queryValue = useRef(null);
  queryValue.current = { search: query.search || '', filter: query.filter || 'all', sort: query.sort || 'added' };
  const allSelected = selectedIds === 'all';
  const selected = useMemo(() => selectedIds instanceof Set ? selectedIds : new Set(Array.isArray(selectedIds) ? selectedIds : []), [selectedIds]);
  const selectedCount = allSelected ? total || 0 : selected.size;
  const columns = Math.max(1, Math.floor((size.width + GAP) / (176 + GAP)));
  const rowCount = Math.ceil((total || 0) / columns);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + size.height) / ROW_HEIGHT) + 2);
  const pump = useRef(() => {});

  // Reassigning this function keeps queued work on the current query, with two IPC calls at most.
  pump.current = () => {
    if (!mounted.current) return;
    if (!window.atelier?.list) {
      queue.current = [];
      setLoading(false);
      setError('Connexion à la bibliothèque indisponible. Rouvrez Atelier Photo.');
      return;
    }
    while (activeRequests.current < 2 && queue.current.length) {
      const page = queue.current.shift();
      const requestGeneration = generation.current;
      const token = `${requestGeneration}:${page}`;
      if (cache.current.has(page) || pending.current.has(token) || failed.current.has(page)) continue;
      const requestQuery = { ...queryValue.current, offset: page * PAGE_SIZE, limit: PAGE_SIZE };
      activeRequests.current++;
      pending.current.add(token);
      setLoading(true);
      Promise.resolve().then(() => window.atelier.list(requestQuery)).then(result => {
        if (!mounted.current || generation.current !== requestGeneration) return;
        if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('La bibliothèque a reçu une réponse incomplète.');
        cache.current.delete(page);
        cache.current.set(page, result.items.slice(0, PAGE_SIZE));
        while (cache.current.size > MAX_PAGES) {
          const oldest = [...cache.current.keys()].find(key => !wantedPages.current.has(key)) ?? cache.current.keys().next().value;
          cache.current.delete(oldest);
        }
        if (totalValue.current !== result.total) {
          totalValue.current = result.total;
          setTotal(result.total);
          onTotalRef.current?.(result.total);
        }
        if (!failed.current.size) setError('');
        setVersion(current => current + 1);
      }).catch(cause => {
        if (!mounted.current || generation.current !== requestGeneration) return;
        failed.current.add(page);
        setError(cause?.message || 'Impossible de charger cette partie de la bibliothèque.');
      }).finally(() => {
        pending.current.delete(token);
        activeRequests.current--;
        if (mounted.current) {
          setLoading(activeRequests.current > 0 || queue.current.length > 0);
          pump.current();
        }
      });
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; queue.current = []; cache.current.clear(); };
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    generation.current++;
    cache.current.clear();
    failed.current.clear();
    wantedPages.current = new Set([0]);
    queue.current = [0];
    totalValue.current = null;
    setTotal(null);
    setError('');
    setScrollTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
    setVersion(current => current + 1);
    pump.current();
  }, [queryKey, refreshToken]);

  useEffect(() => {
    const pages = new Set();
    if (total === null) pages.add(0);
    else if (total > 0) {
      const firstIndex = firstRow * columns;
      const lastIndex = Math.min(total - 1, lastRow * columns - 1);
      for (let page = Math.floor(firstIndex / PAGE_SIZE); page <= Math.floor(lastIndex / PAGE_SIZE); page++) pages.add(page);
    }
    wantedPages.current = pages;
    // Touch visible pages in LRU order and discard requests for views scrolled past.
    for (const page of pages) {
      const items = cache.current.get(page);
      if (items) { cache.current.delete(page); cache.current.set(page, items); }
    }
    queue.current = [...pages].filter(page => !cache.current.has(page) && !pending.current.has(`${generation.current}:${page}`) && !failed.current.has(page)).slice(0, MAX_PAGES);
    pump.current();
  }, [firstRow, lastRow, columns, total, version, queryKey, refreshToken]);

  const handleSelect = (item, event) => {
    if (onSelect) { onSelect(item, event); return; }
    if (!onSelectionChange) return;
    const next = new Set(event.metaKey || event.ctrlKey ? selected : []);
    if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
    onSelectionChange(next);
  };
  const retry = () => {
    failed.current.clear();
    setError('');
    queue.current = [...wantedPages.current].filter(page => !cache.current.has(page));
    pump.current();
  };
  const rows = [];
  for (let row = firstRow; row < lastRow; row++) {
    const cards = [];
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (index >= total) break;
      const item = cache.current.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
      cards.push(item ? <PhotoCard key={item.id} item={item} active={activeId === item.id} selected={allSelected || selected.has(item.id)} onSelect={handleSelect} onOpen={onOpen} /> : <div key={`placeholder-${index}`} aria-hidden="true" style={{ height: 196, background: '#1b1e23', border: '1px solid #292d34', borderRadius: 10 }} />);
    }
    rows.push(<div role="row" key={row} aria-rowindex={row + 1} style={{ position: 'absolute', top: row * ROW_HEIGHT, left: 0, right: 0, height: 196, display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP }}>{cards}</div>);
  }

  return <section className="virtual-library" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, padding: '0 26px' }}>
    <div className="library-summary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 0 15px', minHeight: 18, color: '#929aa8', fontSize: 11 }}>
      <span aria-live="polite">{total === null ? 'Chargement de la bibliothèque…' : `${total.toLocaleString('fr-FR')} photo${total > 1 ? 's' : ''}`}{selectedCount > 0 && ` · ${selectedCount.toLocaleString('fr-FR')} sélectionnée${selectedCount > 1 ? 's' : ''}`}</span>
      {loading && <LoaderCircle size={14} aria-label="Chargement" />}
    </div>
    {error && <div role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, padding: '11px 13px', background: '#ff77770a', border: '1px solid #ff777733', borderRadius: 8, color: '#ffaaaa', fontSize: 12 }}><span style={{ flex: 1 }}>{error}</span><button type="button" className="secondary" onClick={retry}>Réessayer</button></div>}
    <div ref={viewport} data-testid="library-grid" role="grid" aria-label="Bibliothèque photo" aria-rowcount={rowCount} aria-colcount={columns} aria-multiselectable="true" aria-busy={loading}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', paddingRight: 4, overscrollBehavior: 'contain' }}>
      {total === 0 ? <div style={{ minHeight: 310, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#8f98a7', textAlign: 'center', gap: 13 }}><Images size={40} strokeWidth={1} color="#657085" /><strong style={{ color: '#d5dae3', fontSize: 16, fontWeight: 500 }}>{query.search || query.filter && query.filter !== 'all' ? 'Aucune photo ne correspond' : 'Votre bibliothèque vous attend'}</strong><span style={{ fontSize: 12 }}>{query.search || query.filter && query.filter !== 'all' ? 'Essayez un autre filtre ou une autre recherche.' : 'Importez des photos ou un dossier pour commencer.'}</span></div> : <div style={{ position: 'relative', height: rowCount * ROW_HEIGHT, minWidth: 0 }}>{rows}</div>}
    </div>
  </section>;
}

export default VirtualLibrary;

const DEFAULT_CONFIG = Object.freeze({ repository: null, paypalBusiness: 'renaud2005@gmail.com', currency: 'EUR' });

export function normalizeRepository(value) {
  if (typeof value !== 'string') return null;
  let repository = value.trim();
  if (repository.startsWith('https://')) {
    try {
      const url = new URL(repository);
      if (url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
      repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    } catch { return null; }
  }
  const parts = repository.split('/');
  if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0])
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(parts[1]) || parts[1].endsWith('.git')) return null;
  return repository;
}

export function buildPayPalURL(amount, business = DEFAULT_CONFIG.paypalBusiness, itemName = 'Soutien facultatif à Atelier Photo — Renaud') {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return null;
  if (business !== DEFAULT_CONFIG.paypalBusiness) return null;
  const url = new URL('https://www.paypal.com/donate');
  url.searchParams.set('business', business);
  url.searchParams.set('currency_code', 'EUR');
  url.searchParams.set('amount', amount.toFixed(2));
  url.searchParams.set('item_name', itemName);
  return url.href;
}

export function installationCommand(os, repository) {
  const repo = normalizeRepository(repository);
  if (!repo) return 'npm ci --include=optional\nnpm start';
  if (os === 'windows') {
    return `Invoke-WebRequest -Uri 'https://github.com/${repo}/releases/latest/download/install.ps1' -OutFile 'install-atelier-photo.ps1'\n& .\\install-atelier-photo.ps1 -Repository '${repo}'`;
  }
  return `curl --fail --location --proto '=https' --tlsv1.2 'https://github.com/${repo}/releases/latest/download/install.sh' --output install-atelier-photo.sh\nbash ./install-atelier-photo.sh --repo '${repo}'`;
}

function connectPreviewMotion() {
  const preview = document.querySelector('.hero .preview');
  if (!preview) return;
  const enabled = matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
  const properties = ['--preview-rx', '--preview-ry', '--preview-x', '--preview-y'];
  let bounds = null, frame = 0, x = 0, y = 0;
  const reset = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0; bounds = null;
    preview.classList.remove('preview-pointer-active');
    for (const property of properties) preview.style.removeProperty(property);
  };
  const move = event => {
    if (!enabled.matches || event.pointerType !== 'mouse') return;
    // Keep a stable hit rectangle while the card itself tilts.
    bounds ||= preview.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    x = Math.max(-1, Math.min(1, 2 * (event.clientX - bounds.left) / bounds.width - 1));
    y = Math.max(-1, Math.min(1, 2 * (event.clientY - bounds.top) / bounds.height - 1));
    preview.classList.add('preview-pointer-active');
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!enabled.matches) { reset(); return; }
      preview.style.setProperty('--preview-rx', `${(-y * 2.8).toFixed(3)}deg`);
      preview.style.setProperty('--preview-ry', `${(x * 4).toFixed(3)}deg`);
      preview.style.setProperty('--preview-x', `${(x * 3).toFixed(3)}px`);
      preview.style.setProperty('--preview-y', `${(y * 3).toFixed(3)}px`);
    });
  };
  preview.addEventListener('pointerenter', event => {
    if (enabled.matches && event.pointerType === 'mouse') bounds = preview.getBoundingClientRect();
  });
  preview.addEventListener('pointermove', move, { passive: true });
  preview.addEventListener('pointerleave', reset);
  preview.addEventListener('pointercancel', reset);
  enabled.addEventListener('change', reset);
  window.addEventListener('blur', reset);
  window.addEventListener('resize', reset, { passive: true });
  window.addEventListener('scroll', reset, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
}

async function initialize() {
  const language = document.documentElement.lang || 'fr';
  const messages = JSON.parse(document.body.dataset.messages || '{}');
  const t = (key, ...values) => (messages[key] || key).replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
  const appendArrow = (element, text, arrow) => {
    element.replaceChildren(document.createTextNode(`${text} `));
    const icon = document.createElement('span'); icon.textContent = arrow; icon.setAttribute('aria-hidden', 'true'); element.append(icon);
  };
  document.querySelector('#site-language')?.addEventListener('change', event => {
    const destination = new URL(event.target.value, location.href);
    destination.hash = location.hash;
    location.assign(destination.href);
  });
  connectPreviewMotion();
  let config = { ...DEFAULT_CONFIG };
  try {
    const response = await fetch(new URL('config.json', import.meta.url), { cache: 'no-store' });
    if (response.ok) config = { ...config, ...await response.json() };
  } catch { /* Local source instructions remain useful when config cannot be loaded. */ }
  // The recipient is the one explicitly designated by the project's author.
  config.paypalBusiness = DEFAULT_CONFIG.paypalBusiness;
  config.currency = 'EUR';
  const repository = normalizeRepository(config.repository);
  const continueButton = document.querySelector('#continue-button');
  const paypalLink = document.querySelector('#paypal-link');
  const customField = document.querySelector('#custom-field');
  const customInput = document.querySelector('#custom-amount');
  const error = document.querySelector('#donation-error');
  const note = document.querySelector('#donation-note');

  function updateDonation() {
    const selected = document.querySelector('input[name="amount"]:checked')?.value ?? '0';
    customField.hidden = selected !== 'custom';
    const amount = selected === 'custom' ? Number(customInput.value) : Number(selected);
    const valid = Number.isFinite(amount) && amount >= 0 && amount <= 10000
      && /^\d+(?:[.,]\d{1,2})?$/.test(selected === 'custom' ? customInput.value.replace(',', '.') : selected);
    error.hidden = valid;
    error.textContent = valid ? '' : t('Choisissez un montant entre 0 et 10 000 €, avec deux décimales au maximum.');
    const url = valid ? buildPayPalURL(amount, config.paypalBusiness, t('Soutien facultatif à Atelier Photo — Renaud')) : null;
    paypalLink.hidden = !url;
    if (url) {
      paypalLink.href = url;
      appendArrow(paypalLink, t('Ouvrir PayPal — {0} €', amount.toLocaleString(language, { minimumFractionDigits: 0, maximumFractionDigits: 2 })), '↗');
    } else paypalLink.removeAttribute('href');
    continueButton.classList.toggle('secondary', Boolean(url));
    continueButton.classList.toggle('primary', !url);
    appendArrow(continueButton, t(url ? 'Continuer vers l’installation' : 'Continuer gratuitement'), '→');
    note.textContent = t(url ? 'Le don reste facultatif. Continuez quand vous le souhaitez.' : 'Aucun don requis. L’installation est accessible à tous.');
  }
  document.querySelectorAll('input[name="amount"]').forEach(input => input.addEventListener('change', () => {
    updateDonation();
    if (input.value === 'custom' && input.checked) customInput.focus();
  }));
  customInput.addEventListener('input', updateDonation);
  const showInstallation = (scroll = true) => {
    const installation = document.querySelector('#installation');
    installation.hidden = false;
    if (scroll) {
      installation.focus({ preventScroll: true });
      installation.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  };
  continueButton.addEventListener('click', () => showInstallation());
  if (location.hash === '#installation') showInstallation(false);
  updateDonation();

  const status = document.querySelector('#publication-status');
  const releasesLink = document.querySelector('#releases-link');
  if (repository) {
    status.textContent = t('Téléchargements disponibles — {0}', repository);
    status.classList.add('ready');
    releasesLink.href = `https://github.com/${repository}/releases/latest`;
    releasesLink.hidden = false;
    document.querySelectorAll('.local-hint').forEach(element => {
      element.textContent = t('Téléchargez le script, consultez-le, puis lancez la seconde commande. Le téléchargement de l’application sera vérifié avec SHA-256.');
    });
    document.querySelector('#panel-windows .local-hint').textContent += ` ${t('Si votre politique PowerShell bloque les scripts, utilisez le ZIP ou l’installateur manuel disponible ci-dessous.')}`;
    document.querySelector('#install-details').textContent = t('Installation dans votre dossier utilisateur, sans droits administrateur. Paquets vérifiés sur Mac Apple Silicon/Intel, Windows x64 et Ubuntu 22.04 x64. Ils ne disposent pas de signature commerciale Apple/Windows ni de notarisation Apple : les protections de votre système restent actives et peuvent bloquer leur ouverture. Les autres configurations restent à vérifier.');
  }
  for (const os of ['mac', 'windows', 'linux']) {
    document.querySelector(`#command-${os}`).textContent = installationCommand(os, repository);
  }
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const text = document.querySelector(`#command-${button.dataset.copy}`).textContent;
    try { await navigator.clipboard.writeText(text); button.textContent = t('Copié ✓'); }
    catch { button.textContent = t('Sélectionnez le texte'); }
    setTimeout(() => { appendArrow(button, t('Copier'), '⧉'); }, 1800);
  }));

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activate(tab) {
    tabs.forEach(item => { const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; });
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab.dataset.os; });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let next;
      const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
      if (event.key === 'ArrowRight') next = (index + direction + tabs.length) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - direction + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); activate(tabs[next]); tabs[next].focus(); }
    });
  });
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  const guess = /Win/i.test(platform) ? 'windows' : /Linux/i.test(platform) ? 'linux' : 'mac';
  activate(document.querySelector(`[data-os="${guess}"]`));
  document.documentElement.dataset.siteReady = 'true';
}

if (typeof document !== 'undefined') initialize();

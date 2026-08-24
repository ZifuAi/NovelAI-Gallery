'use strict';

const THEMES = {
  dark: [
    ['midnight', 'Midnight'], ['graphite', 'Graphite'], ['nocturne', 'Nocturne'],
    ['forest', 'Forest'], ['ember', 'Ember'], ['orchid', 'Orchid'],
    ['ocean', 'Ocean'], ['rose', 'Rose'], ['sand', 'Sand'], ['void', 'Void'],
  ],
  light: [
    ['daylight', 'Daylight'], ['paper', 'Paper'], ['mist', 'Mist'],
    ['linen', 'Linen'], ['meadow', 'Meadow'], ['blossom', 'Blossom'],
    ['porcelain', 'Porcelain'], ['sky', 'Sky'], ['honey', 'Honey'], ['lavender', 'Lavender'],
  ],
};

const CAPTURE_MODES = [
  {
    id: 'generated',
    title: 'Only save images as I generate them',
    desc: 'New generations land here automatically. Your existing NovelAI history is left alone — use “Import NovelAI history now” in the extension popup if you ever want to pull the backlog in.',
  },
  {
    id: 'all',
    title: 'Save everything, including my existing history',
    desc: 'As above, but also imports whatever NovelAI already has stored the first time it runs. Best if you want a complete archive.',
  },
  {
    id: 'download',
    title: 'Only save images I save or download',
    desc: 'Nothing is saved automatically. A copy lands here whenever you save an image on NovelAI — its own save button, or right-click → Save image as. Your download still goes to your Downloads folder as normal.',
  },
];

const LAYOUTS = ['grid', 'justified', 'waterfall', 'list'];

const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['prompt', 'Prompt A–Z'],
  ['model', 'Model A–Z'],
  ['largest', 'Largest first'],
  ['smallest', 'Smallest first'],
];

// Colour labels for images. Eight is enough to be useful and few enough
// to tell apart at thumbnail size.
const LABEL_COLORS = [
  ['#ff6b6b', 'Red'], ['#ffa94d', 'Orange'], ['#ffd43b', 'Yellow'],
  ['#51cf66', 'Green'], ['#4dabf7', 'Blue'], ['#b197fc', 'Purple'],
  ['#f783ac', 'Pink'], ['#868e96', 'Grey'],
];

function colorLabelName(hex) {
  const custom = state.colorNames[(hex || '').toLowerCase()];
  if (custom) return custom;
  const known = LABEL_COLORS.find(([h]) => h === hex);
  return known ? known[1] : 'Colour';
}

const META_VIEWS = [
  {
    id: 'tags',
    title: 'As tags',
    desc: 'Each comma-separated part becomes its own chip, grouped into collapsible sections. Clicking a tag searches for it.',
  },
  {
    id: 'raw',
    title: 'As raw text',
    desc: 'The prompt exactly as it was written, in a text box you can select and copy from in one go.',
  },
];

const state = {
  query: '',
  view: 'all',
  folderId: null,
  offset: 0,
  limit: 60,
  total: 0,
  items: [],
  current: null,     // shown in the lightbox
  selected: null,    // shown in the inspector panel
  loading: false,
  settings: {
    theme: 'midnight', cardSize: 190, inspectorOpen: false,
    captureMode: 'generated', layout: 'waterfall', sort: 'newest',
    metaView: 'tags', interceptDownloads: false, flagNsfw: true, sidebarWidth: 232,
    autoUpdate: false,
  },
  appVersion: '',    // reported by the running binary
  collapsed: {},     // section id -> true when collapsed
  revealed: new Set(),   // NSFW images un-blurred for this session only
  folderClosed: new Set(),  // collapsed branches of the folder tree
  tags: [],
  colorNames: {},
  colorCounts: {},
  color: null,           // active colour-label filter
  undo: { canUndo: false, canRedo: false },
  selection: new Set(),  // ids ticked in multi-select mode
  selectMode: false,
  anchorId: null,    // for shift-click ranges
  folders: [],
};

const $ = (id) => document.getElementById(id);
const el = {};
[
  'app', 'content', 'search', 'searchClear', 'countPill', 'countAll', 'countFav', 'countPin',
  'refreshBtn', 'folderList', 'addFolderBtn', 'lightbox', 'viewerImg', 'detailsBody',
  'favBtn', 'pinBtn', 'closeBtn', 'toast', 'zoom', 'inspector', 'inspectorBody',
  'inspectorToggle', 'inspectorClose', 'settingsBtn', 'settingsModal', 'settingsClose',
  'darkThemes', 'lightThemes', 'captureModes', 'metaViews', 'interceptSwitch',
  'nsfwSwitch', 'settingsTabs', 'tagManager', 'aboutVersion', 'checkUpdateBtn',
  'updateStatus', 'autoUpdateSwitch', 'aboutRepo', 'installUpdateBtn',
  'installLatestBtn',
  'updateToast', 'updateToastTitle', 'updateToastBody', 'updateToastClose',
  'updateToastLater', 'updateToastGo',
  'updateModal', 'updateStage', 'updateSpinner', 'updateHeadline', 'updateSub',
  'updateBarFill', 'updateActions', 'updateCancel',
  'welcomeModal', 'welcomeTitle', 'welcomeSub', 'welcomeBody', 'welcomeLink', 'welcomeDone',
  'onboardModal', 'onboardBody', 'onboardDots', 'onboardBack', 'onboardNext',
  'onboardSkip', 'onboardStepLabel', 'ctxMenu',
  'folderRootDrop', 'sidebarResizer',
  'importBtn', 'importInput', 'dropzone',
  'extModal', 'extBody', 'extClose', 'setupExtBtn', 'extStatus', 'extDot', 'extStatusText',
  'viewMenuBtn', 'viewMenu', 'viewMenuLabel', 'viewMenuDot', 'viewMenuClear', 'layoutSwitch', 'selectBtn', 'deleteBtn', 'expandBtn',
  'zoomView', 'zoomCanvas', 'zoomImg', 'zoomBack', 'zoomIn', 'zoomOut',
  'zoomLevel', 'zoomName', 'zoomHint',
  'bulkbar', 'bulkCount', 'bulkSelectAll', 'bulkPin', 'bulkFav',
  'bulkFolderBtn', 'bulkFolderMenu', 'bulkDelete', 'bulkClose',
  'clearGalleryBtn', 'clearCount',
  'confirmModal', 'confirmTitle', 'confirmBody', 'confirmOk', 'confirmCancel',
  'toolTabs', 'toolPrompt', 'toolGenerate', 'toolsSettingsBtn',
  'askModal', 'askTitle', 'askSub', 'askInput', 'askError', 'askOk', 'askCancel',
].forEach((id) => { el[id] = $(id); });
el.app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900);
}

// ---------------------------------------------------------------- settings

async function loadSettings() {
  try {
    const s = await fetch('/api/settings').then((r) => r.json());
    state.settings = { ...state.settings, ...s };
  } catch (e) {
    /* fall back to defaults */
  }
  // Which build this is, straight from the running binary rather than a
  // number hardcoded in two places that can drift apart.
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    state.appVersion = h.version || '';
  } catch (e) { /* the About tab shows a dash */ }
  applySettings();
}

function applySettings() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  document.documentElement.style.setProperty('--card-size', `${state.settings.cardSize}px`);
  if (state.settings.sidebarWidth) {
    document.documentElement.style.setProperty('--sidebar-w', `${state.settings.sidebarWidth}px`);
  }
  el.zoom.value = state.settings.cardSize;
  el.app.classList.toggle('inspector-open', !!state.settings.inspectorOpen);
  el.inspectorToggle.classList.toggle('active', !!state.settings.inspectorOpen);

  if (!LAYOUTS.includes(state.settings.layout)) state.settings.layout = 'grid';
  el.layoutSwitch.querySelectorAll('.layout-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === state.settings.layout);
  });
  el.app.dataset.layout = state.settings.layout;

  // The zoom slider means "row height" or "column width" depending on the
  // layout, and nothing at all in list view.
  el.zoom.parentElement.classList.toggle('disabled', state.settings.layout === 'list');

  syncWindowChrome();
}

/**
 * Hand the window's title bar the theme's colors.
 *
 * The caption is painted by Windows, not by this page, so a themed app
 * with a stock title bar looks half-finished. The app passes these on to
 * the desktop window manager; Windows 10 can't colour a caption, so there
 * only the light/dark part applies. Everywhere else it's a no-op.
 */
let lastChrome = '';
function syncWindowChrome() {
  const css = getComputedStyle(document.documentElement);
  const chrome = {
    caption: css.getPropertyValue('--surface-1').trim(),
    text: css.getPropertyValue('--text').trim(),
    border: css.getPropertyValue('--border').trim(),
    dark: THEMES.dark.some(([id]) => id === state.settings.theme),
  };
  const key = JSON.stringify(chrome);
  if (!chrome.caption || key === lastChrome) return;
  lastChrome = key;
  fetch('/api/window/chrome', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chrome),
  }).catch(() => { /* not running inside the desktop window */ });
}

/**
 * A styled yes/no for destructive actions. Deliberately not window.confirm:
 * deleting a library needs to state exactly what is about to go, and the
 * native dialog can't.
 */
function confirmDialog({ title, body, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = title;
    el.confirmBody.innerHTML = body;
    el.confirmOk.textContent = confirmLabel;
    el.confirmModal.hidden = false;
    el.confirmOk.focus();

    const done = (answer) => {
      el.confirmModal.hidden = true;
      el.confirmOk.removeEventListener('click', ok);
      el.confirmCancel.removeEventListener('click', cancel);
      el.confirmModal.removeEventListener('click', backdrop);
      document.removeEventListener('keydown', key, true);
      resolve(answer);
    };
    const ok = () => done(true);
    const cancel = () => done(false);
    const backdrop = (e) => { if (e.target === el.confirmModal) done(false); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };

    el.confirmOk.addEventListener('click', ok);
    el.confirmCancel.addEventListener('click', cancel);
    el.confirmModal.addEventListener('click', backdrop);
    document.addEventListener('keydown', key, true);
  });
}

/**
 * Ask for a line of text, in the app's own dialog rather than the browser's.
 *
 * window.prompt draws an operating-system box that ignores the theme, sits
 * wherever Windows feels like putting it, and has no room for a hint or for
 * saying why a name was refused. This one can do all three, so a rejected
 * name is corrected in place instead of throwing the typing away.
 *
 * `submit` may return an error string to keep the dialog open with that
 * message shown. Resolves with the value, or null if it was cancelled.
 */
function askText({ title, sub = '', value = '', placeholder = '', okLabel = 'Create', submit }) {
  return new Promise((resolve) => {
    el.askTitle.textContent = title;
    el.askSub.textContent = sub;
    el.askSub.hidden = !sub;
    el.askInput.value = value;
    el.askInput.placeholder = placeholder;
    el.askOk.textContent = okLabel;
    el.askError.hidden = true;
    el.askError.textContent = '';
    el.askModal.hidden = false;
    el.askInput.focus();
    el.askInput.select();

    let busy = false;
    const close = (answer) => {
      el.askModal.hidden = true;
      el.askOk.removeEventListener('click', ok);
      el.askCancel.removeEventListener('click', cancel);
      el.askModal.removeEventListener('mousedown', backdrop);
      el.askInput.removeEventListener('input', clearError);
      document.removeEventListener('keydown', key, true);
      resolve(answer);
    };

    const ok = async () => {
      if (busy) return;
      const text = el.askInput.value.trim();
      if (!text && okLabel !== 'Save') { el.askInput.focus(); return; }
      if (!submit) return close(text);

      busy = true;
      el.askOk.disabled = true;
      const err = await submit(text);
      busy = false;
      el.askOk.disabled = false;
      if (err) {
        // Keep what they typed on screen so it can be edited, rather than
        // closing and making them start again.
        el.askError.textContent = err;
        el.askError.hidden = false;
        el.askInput.focus();
        el.askInput.select();
        return;
      }
      close(text);
    };
    const cancel = () => close(null);
    const backdrop = (e) => { if (e.target === el.askModal) close(null); };
    const clearError = () => { el.askError.hidden = true; };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); ok(); }
    };

    el.askOk.addEventListener('click', ok);
    el.askCancel.addEventListener('click', cancel);
    el.askModal.addEventListener('mousedown', backdrop);
    el.askInput.addEventListener('input', clearError);
    document.addEventListener('keydown', key, true);
  });
}

let saveTimer;
function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  applySettings();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.settings),
    }).catch(() => {});
  }, 180);
}

/* The theme grid, the prompt-display choice, the capture modes and the
   save switch all appear in two places now - Settings and the first-run
   setup - so each one is a renderer that takes a container rather than
   markup written twice. */

function themeSwatchHtml(id, name) {
  return `
    <button class="theme-swatch${state.settings.theme === id ? ' active' : ''}" data-theme-id="${id}">
      <div class="swatch-preview" data-theme="${id}" style="background:var(--bg)">
        <div class="swatch-chip" style="background:var(--accent)"></div>
        <div class="swatch-bar" style="background:var(--surface-3)"></div>
      </div>
      <span class="swatch-name">${esc(name)}</span>
    </button>`;
}

function renderThemePicker(darkEl, lightEl, onPick) {
  if (darkEl) darkEl.innerHTML = THEMES.dark.map(([id, n]) => themeSwatchHtml(id, n)).join('');
  if (lightEl) lightEl.innerHTML = THEMES.light.map(([id, n]) => themeSwatchHtml(id, n)).join('');
  [darkEl, lightEl].forEach((root) => {
    if (!root) return;
    root.querySelectorAll('.theme-swatch').forEach((b) => {
      b.addEventListener('click', () => {
        saveSettings({ theme: b.dataset.themeId });
        if (onPick) onPick(b);
      });
    });
  });
}

function optionListHtml(options, selectedId) {
  return options.map((m) => `
    <div class="option${selectedId === m.id ? ' selected' : ''}" data-option="${m.id}">
      <div class="option-radio"></div>
      <div class="option-text">
        <div class="option-title">${esc(m.title)}</div>
        <div class="option-desc">${esc(m.desc)}</div>
      </div>
    </div>`).join('');
}

function renderMetaViews(container, onPick) {
  if (!container) return;
  container.innerHTML = optionListHtml(META_VIEWS, state.settings.metaView || 'tags');
  container.querySelectorAll('.option').forEach((o) => {
    o.addEventListener('click', () => {
      saveSettings({ metaView: o.dataset.option });
      renderMetaViews(container, onPick);
      renderInspector();
      if (state.current) renderDetails();
      if (onPick) onPick(o.dataset.option);
    });
  });
}

function renderCaptureModes(container, onPick) {
  if (!container) return;
  container.innerHTML = optionListHtml(CAPTURE_MODES, state.settings.captureMode);
  container.querySelectorAll('.option').forEach((o) => {
    o.addEventListener('click', () => {
      saveSettings({ captureMode: o.dataset.option });
      renderCaptureModes(container, onPick);
      if (onPick) onPick(o.dataset.option);
    });
  });
}

function renderInterceptSwitch(container) {
  if (!container) return;
  container.innerHTML = `
    <label class="switch-row">
      <input type="checkbox" class="switch-input"${state.settings.interceptDownloads ? ' checked' : ''} />
      <span class="switch-track"><span class="switch-knob"></span></span>
      <span class="switch-text">
        <span class="switch-title">Keep saved images here instead of downloading them</span>
        <span class="switch-desc">
          When you save an image on NovelAI, it goes straight into this gallery
          and no file is written to your Downloads folder. Only applies to
          NovelAI — nothing else you download is touched.
        </span>
      </span>
    </label>`;
  const input = container.querySelector('.switch-input');
  input.addEventListener('change', () => {
    saveSettings({ interceptDownloads: input.checked });
    toast(input.checked
      ? 'Saved images will be kept here instead of downloaded.'
      : 'Saved images will download normally again.');
  });
}

function renderNSFWSwitch(container) {
  if (!container) return;
  container.innerHTML = `
    <label class="switch-row">
      <input type="checkbox" class="switch-input"${state.settings.flagNsfw ? ' checked' : ''} />
      <span class="switch-track"><span class="switch-knob"></span></span>
      <span class="switch-text">
        <span class="switch-title">Blur explicit images in the gallery</span>
        <span class="switch-desc">
          Images whose prompt describes explicit content are covered with a
          Reveal button. Ordinary anatomy — "large breasts" and the like — is
          not flagged, and undesired content is never read as evidence.
          Opening an image always shows it. Turning this on or off re-checks
          your whole library.
        </span>
      </span>
    </label>`;
  const input = container.querySelector('.switch-input');
  input.addEventListener('change', async () => {
    const on = input.checked;
    saveSettings({ flagNsfw: on });
    input.disabled = true;
    try {
      const res = await fetch('/api/nsfw/rescan', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      toast(on
        ? `Explicit images will be blurred${body.changed ? ` — ${body.changed} newly flagged` : ''}`
        : 'Nothing will be flagged');
    } catch (e) {
      toast('Could not re-check the library');
    }
    input.disabled = false;
    state.revealed.clear();
    await load({ reset: true });
  });
}

el.settingsTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.settings-tab');
  if (!tab) return;
  el.settingsTabs.querySelectorAll('.settings-tab').forEach((t) =>
    t.classList.toggle('active', t === tab));
  document.querySelectorAll('.settings-pane').forEach((pane) =>
    pane.classList.toggle('active', pane.dataset.pane === tab.dataset.tab));
  document.querySelector('.settings-body').scrollTop = 0;
});

/**
 * Names for the colour labels. A swatch that means "needs work" is worth
 * more than one that means "red", and the name is searchable.
 */
function renderTagManager(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="hint-inline">
      Give the colours names that mean something to you. Right-click any image
      to label it, then filter by colour from the sort menu.
    </div>
    ${LABEL_COLORS.map(([hex, fallback]) => `
      <div class="label-row">
        <span class="label-swatch" style="background:${hex}"></span>
        <input class="label-input" data-color="${hex}" value="${esc(state.colorNames[hex.toLowerCase()] || '')}"
          placeholder="${esc(fallback)}" spellcheck="false" />
        <span class="label-count">${state.colorCounts[hex.toLowerCase()] || 0}</span>
      </div>`).join('')}`;

  container.querySelectorAll('.label-input').forEach((input) => {
    const save = async () => {
      await fetch('/api/colors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: input.dataset.color, name: input.value }),
      }).catch(() => {});
      await loadColorLabels();
      renderViewMenu();
    };
    input.addEventListener('change', save);
    input.addEventListener('blur', save);
  });
}

function renderSettings() {
  renderThemePicker(el.darkThemes, el.lightThemes, (b) => {
    renderSettings();
    toast(`Theme: ${b.querySelector('.swatch-name').textContent}`);
  });
  renderMetaViews(el.metaViews);
  renderCaptureModes(el.captureModes, () =>
    toast('Capture mode updated — the extension picks this up within a minute.'));
  renderInterceptSwitch(el.interceptSwitch);
  renderNSFWSwitch(el.nsfwSwitch);
  renderTagManager(el.tagManager);
  renderNaiToken();
  renderAbout();
}

/* The NovelAI API token. It lives here rather than on the Image Generation
   screen because it is a once-ever thing, and the app never reads it back -
   only whether one is set. */
async function renderNaiToken() {
  const input = document.getElementById('setToken');
  if (!input) return;

  const paint = async () => {
    let info = null;
    try {
      info = await fetch('/api/nai/token').then((r) => r.json());
    } catch (e) { /* treated as not set */ }
    const set = !!info?.present;
    input.value = '';
    input.placeholder = set
      ? 'A token is saved — paste a new one to replace it'
      : 'Paste your persistent API token';
    document.getElementById('setTokenProtection').textContent =
      info?.protection || 'on this PC';
    document.getElementById('setTokenState').textContent = set
      ? 'A token is saved. Image Generation is ready to use.'
      : 'No token saved yet, so Image Generation can’t reach NovelAI.';
    if (typeof genRefreshToken === 'function') genRefreshToken();
    // A new token means a new balance to read.
    if (typeof genRefreshAnlas === 'function') genRefreshAnlas();
  };

  const save = document.getElementById('setTokenSave');
  const clear = document.getElementById('setTokenClear');
  // renderSettings runs every time the dialog opens, so the handlers are
  // replaced rather than stacked.
  save.onclick = async () => {
    const token = input.value.trim();
    if (!token) return toast('Paste a token first');
    await fetch('/api/nai/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    await paint();
    toast('Token saved');
  };
  clear.onclick = async () => {
    await fetch('/api/nai/token', { method: 'DELETE' });
    await paint();
    toast('Token forgotten');
  };

  await paint();
}

// ---------------------------------------------------------------- storage

// Where the library lives on disk. Every captured image - including one
// saved with "keep saved images here" - is an ordinary .png in this
// folder, and the details panel says so.
let storageInfo = null;
async function loadStorageInfo() {
  try {
    storageInfo = await fetch('/api/storage').then((r) => r.json());
  } catch (e) { /* the path line is simply omitted */ }
}

function imagePathOf(record) {
  if (!storageInfo?.imagesDir || !record?.filename) return '';
  const sep = storageInfo.imagesDir.includes('\\') ? '\\' : '/';
  return `${storageInfo.imagesDir}${sep}${record.filename}`;
}

async function revealImage(record, btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const res = await fetch(`/api/images/${record.id}/reveal`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    toast('Opened in File Explorer');
  } catch (e) {
    toast(e.message || 'Could not open the folder');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// ---------------------------------------------------------------- extension setup

/**
 * Whether the extension is actually installed and talking to us. There's
 * no way to query the browser directly, so this infers it: if anything in
 * the library arrived via the extension, it's working. Before the first
 * capture we can only say "not detected yet", and say so honestly rather
 * than claiming it's missing.
 */
async function extensionStatus() {
  try {
    const data = await fetch('/api/images?limit=1').then((r) => r.json());
    const seen = data.total > 0;
    return seen ? 'working' : 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

async function refreshExtStatus() {
  const status = await extensionStatus();
  if (status === 'working') {
    el.extDot.className = 'dot ok';
    el.extStatusText.textContent = 'Installed and saving images';
  } else {
    el.extDot.className = 'dot';
    el.extStatusText.textContent = 'No images captured yet';
  }
}

async function openExtensionSetup() {
  el.onboardModal.hidden = true;
  el.extModal.hidden = false;
  renderExtensionSteps(el.extBody);
}

/** The install-the-extension walkthrough, used by the modal and by setup. */
async function renderExtensionSteps(container) {
  container.innerHTML = '<div class="empty-note">Loading…</div>';

  let info = { path: '', browsers: [] };
  try {
    info = await fetch('/api/extension/info').then((r) => r.json());
  } catch (e) { /* fall through with empty info */ }

  const browsers = info.browsers || [];
  const browserBtns = browsers.length
    ? browsers.map((b) => `<button class="btn primary" data-browser="${esc(b.id)}">Open ${esc(b.name)}</button>`).join('')
    : `<div class="sub">No Brave/Chrome/Edge install found automatically — open your browser yourself and go to its Extensions page.</div>`;

  container.innerHTML = `
    <div class="steps">
      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Open your browser's Extensions page.
          <div class="sub">This button opens it for you.</div>
          <div class="browser-row">${browserBtns}</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Turn on <strong>Developer mode</strong> — the switch in the top-right of that page.
        </div>
      </div>

      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Click <strong>Load unpacked</strong>, then pick this folder:
          <div class="path-box">
            <code>${esc(info.path || 'unavailable')}</code>
            <button class="btn" data-copy-path>Copy</button>
            <button class="btn" data-open-folder>Open</button>
          </div>
        </div>
      </div>

      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Reload your NovelAI tab once, then generate an image — it should
          appear here on its own.
          <div class="sub">Extensions only attach to pages that load after they're installed.</div>
        </div>
      </div>
    </div>

    <div class="callout">
      Browsers only allow one-click installs for extensions published to their
      web store, and this one isn't. That's why the folder step above is manual —
      it's the same thing every unpublished extension needs, and it's a one-time setup.
    </div>`;

  container.querySelectorAll('[data-browser]').forEach((b) => {
    const label = b.textContent;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Opening…';
      try {
        await fetch('/api/extension/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ browser: b.dataset.browser }),
        });
        toast('Browser opened — continue with step 2');
      } catch (e) {
        toast('Could not open the browser automatically');
      }
      b.disabled = false;
      b.textContent = label;
    });
  });

  const copyBtn = container.querySelector('[data-copy-path]');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(info.path || '').then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1400);
      }).catch(() => toast('Could not copy — select the path manually'));
    });
  }

  const openBtn = container.querySelector('[data-open-folder]');
  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/extension/reveal', { method: 'POST' });
      } catch (e) {
        toast('Could not open the folder');
      }
    });
  }
}

/* The first-run guide to getting a NovelAI API token in.
 *
 * This is the step that used to be "install the browser extension". The app
 * generates images itself now, so the token is what makes it work at all,
 * and the extension is only needed by people who would rather generate on
 * novelai.net - which is a choice, not the way in.
 *
 * It is its own panel rather than a link to Settings because a first run
 * that ends with "now go and find this somewhere else" is not a setup
 * guide. The field, the warnings and the state are all here. */
async function renderTokenSetup(container) {
  container.innerHTML = `
    <div class="steps">
      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Sign in at <strong>novelai.net</strong> with a subscription that can
          generate images.
          <div class="sub">Image generation is a paid NovelAI feature; the app
            can't do it without an account that has it.</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Open <strong>Account Settings</strong>, then
          <strong>Account</strong>, and click
          <strong>Get Persistent API Token</strong>.
          <div class="sub">NovelAI shows the token once. Copy it before you
            close the box.</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num"></div>
        <div class="step-text">
          Paste it here.
          <div class="token-row">
            <input class="pg-input" id="obToken" type="password" spellcheck="false"
              autocomplete="off" placeholder="Paste your persistent API token" />
            <button class="btn primary" id="obTokenSave">Save</button>
          </div>
          <div class="sub" id="obTokenState">Checking…</div>
        </div>
      </div>
    </div>

    <div class="callout warn">
      <strong>Treat this token like a password.</strong> Anyone who has it can
      generate on your account and spend your Anlas. Don't paste it into
      Discord, a forum, a bug report or a screenshot, and don't share it with
      anyone — including anyone claiming to be support.
      <div class="sub">
        It is stored encrypted on this PC and is only ever sent to NovelAI's
        own servers. The app never displays it again, and never sends it
        anywhere else.
      </div>
    </div>

    <div class="callout">
      What you generate through this app is generated on your own NovelAI
      account, so <strong>NovelAI's Terms of Service and content rules apply
      exactly as they do on their site</strong>. Keep to them — the account
      that answers for anything generated here is yours.
    </div>

    <div class="onboard-note">
      You can skip this and add the token later in
      <strong>Settings ▸ Image generation</strong>. The gallery works without
      one; only generating needs it.
    </div>`;

  const input = container.querySelector('#obToken');
  const state = container.querySelector('#obTokenState');

  const paint = async () => {
    let info = null;
    try {
      info = await fetch('/api/nai/token').then((r) => r.json());
    } catch (e) { /* treated as not set */ }
    input.value = '';
    state.textContent = info?.present
      ? 'A token is saved — Image Generation is ready to use.'
      : 'No token saved yet.';
    state.dataset.ok = info?.present ? 'yes' : 'no';
    if (typeof genRefreshToken === 'function') genRefreshToken();
    if (typeof genRefreshAnlas === 'function') genRefreshAnlas();
  };

  container.querySelector('#obTokenSave').addEventListener('click', async () => {
    const token = input.value.trim();
    if (!token) return toast('Paste a token first');
    await fetch('/api/nai/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    await paint();
    toast('Token saved — it never leaves this PC except to NovelAI');
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') container.querySelector('#obTokenSave').click();
  });

  await paint();
}

/* ---------------------------------------------------------------- setup

   First run walks through the things worth deciding once - how it looks,
   how prompts read, what gets saved - and finishes on the one step that
   actually matters, installing the extension. Every choice is a live
   setting, so the app is already configured by the time it's dismissed;
   nothing here is a questionnaire whose answers get applied later.
*/

const ONBOARD_STEPS = [
  {
    id: 'welcome',
    render(c) {
      c.innerHTML = `
        <div class="onboard-hero">
          <img class="onboard-mark" src="appicon.png" alt="" />
          <h1 class="onboard-title">Welcome to NovelAI Tools</h1>
          <p class="onboard-lead">
            This app keeps every image you generate on NovelAI, together with its
            prompt and settings, so you can search and reuse them later.
            Everything stays on this PC.
          </p>
          <div class="onboard-note">
            Three quick questions, then the one step that matters: your
            NovelAI API token, which is what lets the app generate images
            for you.
          </div>
        </div>`;
    },
  },
  {
    id: 'theme',
    title: 'Pick a look',
    lead: 'All 20 themes are here in Settings whenever you want to change it.',
    render(c) {
      c.innerHTML = `
        <div class="theme-heading">Dark</div>
        <div class="theme-grid" data-dark></div>
        <div class="theme-heading">Light</div>
        <div class="theme-grid" data-light></div>`;
      const rerender = () => ONBOARD_STEPS[1].render(c);
      renderThemePicker(c.querySelector('[data-dark]'), c.querySelector('[data-light]'), rerender);
    },
  },
  {
    id: 'prompts',
    title: 'How should prompts read?',
    lead: 'This is what you see when you open one of your images.',
    render(c) { renderMetaViews(c); },
  },
  {
    id: 'saving',
    title: 'What should be saved?',
    lead: 'This covers what you generate in the app, and anything the browser '
      + 'extension catches from novelai.net.',
    render(c) {
      c.innerHTML = `<div data-modes></div><div data-switch></div>`;
      renderCaptureModes(c.querySelector('[data-modes]'));
      renderInterceptSwitch(c.querySelector('[data-switch]'));
    },
  },
  {
    id: 'token',
    title: 'Set up image generation',
    lead: 'One paste, and the app can generate on your NovelAI account itself.',
    render(c) { renderTokenSetup(c); },
  },
  {
    id: 'extension',
    title: 'Generating on novelai.net instead — optional',
    lead: 'Only needed if you would rather use the website and have what you '
      + 'make there land here too. Skip it if you are generating in the app.',
    render(c) { renderExtensionSteps(c); },
  },
  {
    id: 'done',
    render(c) {
      c.innerHTML = `
        <div class="onboard-hero">
          <div class="onboard-tick">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 12.5l5 5L20 6.5"></path>
            </svg>
          </div>
          <h1 class="onboard-title">That's everything</h1>
          <p class="onboard-lead">
            Open <strong>Image Generation</strong>, write a prompt, and what you
            make lands in your gallery. If you set the extension up as well,
            anything you generate on novelai.net arrives here too.
          </p>
          <div class="onboard-note">
            Anything you picked here lives in <strong>Settings</strong>, and
            nothing is final — including the API token.
          </div>
        </div>`;
    },
  },
];

function maybeStartOnboarding() {
  if (state.settings.onboarded) return;
  state.onboardStep = 0;
  el.onboardModal.hidden = false;
  renderOnboardStep();
}

function renderOnboardStep() {
  const i = state.onboardStep;
  const step = ONBOARD_STEPS[i];

  el.onboardBody.innerHTML = '';
  if (step.title) {
    const head = document.createElement('div');
    head.className = 'onboard-step-head';
    head.innerHTML = `<h2 class="onboard-step-title">${esc(step.title)}</h2>
      ${step.lead ? `<p class="onboard-step-lead">${esc(step.lead)}</p>` : ''}`;
    el.onboardBody.appendChild(head);
  }
  const body = document.createElement('div');
  body.className = 'onboard-step-body';
  el.onboardBody.appendChild(body);
  step.render(body);
  el.onboardBody.scrollTop = 0;

  el.onboardDots.innerHTML = ONBOARD_STEPS
    .map((s2, n) => `<span class="onboard-dot${n === i ? ' active' : ''}${n < i ? ' done' : ''}"></span>`)
    .join('');
  el.onboardBack.style.visibility = i === 0 ? 'hidden' : 'visible';
  el.onboardNext.textContent = i === ONBOARD_STEPS.length - 1 ? 'Start using it' : 'Continue';
  el.onboardStepLabel.textContent = `${i + 1} of ${ONBOARD_STEPS.length}`;
}

function finishOnboarding() {
  el.onboardModal.hidden = true;
  saveSettings({ onboarded: true });
  load({ reset: true });
}

function onboardNext() {
  if (state.onboardStep >= ONBOARD_STEPS.length - 1) return finishOnboarding();
  state.onboardStep++;
  renderOnboardStep();
}

function onboardBack() {
  if (state.onboardStep === 0) return;
  state.onboardStep--;
  renderOnboardStep();
}

// ---------------------------------------------------------------- data

function buildParams() {
  const p = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  if (state.query) p.set('q', state.query);
  if (state.view === 'favorites') p.set('favorite', 'true');
  if (state.view === 'pinned') p.set('pinned', 'true');
  if (state.folderId) p.set('folder', state.folderId);
  if (state.color) p.set('color', state.color);
  if (state.settings.sort) p.set('sort', state.settings.sort);
  return p;
}

async function load({ reset, silent } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.items = [];
    // The skeleton is a first-load affordance only. It used to appear
    // whenever there was no .grid on screen, which meant an empty library
    // flashed a grid of placeholder tiles on every background refresh -
    // the gallery looked like it was loading images that don't exist.
    // Anything already on screen, grid or empty state, now simply stays
    // until the new data replaces it.
    if (!silent && !el.content.querySelector('.grid, .state')) renderSkeleton();
  }
  try {
    const res = await fetch(`/api/images?${buildParams()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.total = data.total;
    state.items = state.items.concat(data.items);
    state.offset += data.items.length;
    render();
    refreshCounts();
  } catch (err) {
    renderError(err.message);
  } finally {
    state.loading = false;
  }
}

async function refreshCounts() {
  try {
    const [all, fav, pin] = await Promise.all([
      fetch('/api/images?limit=1').then((r) => r.json()),
      fetch('/api/images?limit=1&favorite=true').then((r) => r.json()),
      fetch('/api/images?limit=1&pinned=true').then((r) => r.json()),
    ]);
    el.countAll.textContent = all.total || '';
    el.countFav.textContent = fav.total || '';
    el.countPin.textContent = pin.total || '';
  } catch (e) { /* cosmetic */ }
}

// ---------------------------------------------------------------- grid

function renderSkeleton() {
  el.content.innerHTML = `<div class="skeleton-grid">${'<div class="skeleton"></div>'.repeat(12)}</div>`;
}

function renderError(msg) {
  el.content.innerHTML = `
    <div class="state">
      <div class="state-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M12 8v5M12 16.5v.5"></path><circle cx="12" cy="12" r="9"></circle>
        </svg>
      </div>
      <div class="state-title">Couldn't load your library</div>
      <div class="state-body">${esc(msg)}. Try refreshing, or restart the app.</div>
    </div>`;
}

function stateBlock(title, body, withHelp) {
  const help = withHelp
    ? `<div class="state-actions">
         <button class="btn" id="stateRefresh">Check again</button>
         <button class="btn" id="stateSetup">Extension setup</button>
       </div>
       <div class="state-hint">
         Already generated some? Click the extension's toolbar icon in your
         browser and use <strong>Import NovelAI history now</strong> — it reads
         what NovelAI has already stored.
       </div>`
    : '';
  return `
    <div class="state">
      <div class="state-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
          <circle cx="8.5" cy="9.5" r="1.6"></circle><path d="M21 15l-5-4.5L7 20"></path>
        </svg>
      </div>
      <div class="state-title">${esc(title)}</div>
      <div class="state-body">${esc(body)}</div>
      ${help}
    </div>`;
}

function emptyState() {
  if (state.query) return stateBlock('No matches', `Nothing matched “${state.query}”. Try a shorter phrase, or a single tag.`);
  if (state.view === 'favorites') return stateBlock('No favorites yet', 'Open any image and hit Favorite to keep it here.');
  if (state.view === 'pinned') return stateBlock('Nothing pinned', 'Pinned images float to the top of every view.');
  if (state.folderId) return stateBlock('This folder is empty', 'Open an image and use Add to folder to file it here.');
  return stateBlock(
    'No images yet',
    'Generate something on NovelAI with the extension installed and it lands here automatically.',
    true
  );
}

/**
 * Reconcile the grid in place rather than rebuilding it.
 *
 * The background refresh runs every few seconds; replacing innerHTML each
 * time re-created every <img>, which made the whole gallery visibly blink
 * as the browser re-decoded images it already had. Instead, existing card
 * nodes are kept and reordered, so untouched images are never re-created
 * and nothing flickers.
 */
function render() {
  if (state.items.length === 0) {
    // Rewriting an identical empty state every few seconds is the same
    // flicker the grid used to have, so it's only rebuilt when what it
    // would say has actually changed.
    const key = `${state.view}|${state.folderId || ''}|${state.query}`;
    if (el.content.dataset.emptyKey !== key) {
      el.content.dataset.emptyKey = key;
      el.content.innerHTML = emptyState();
      const r = document.getElementById('stateRefresh');
      if (r) r.addEventListener('click', () => load({ reset: true }));
      const su = document.getElementById('stateSetup');
      if (su) su.addEventListener('click', openExtensionSetup);
    }
    el.countPill.textContent = '';
    return;
  }

  delete el.content.dataset.emptyKey;
  let grid = el.content.querySelector('.grid');
  if (!grid) {
    el.content.innerHTML = '';
    grid = document.createElement('div');
    grid.className = `grid layout-${state.settings.layout}`;
    el.content.appendChild(grid);
  }

  const existing = new Map();
  grid.querySelectorAll('.card').forEach((n) => existing.set(n.dataset.id, n));

  const wanted = new Set(state.items.map((r) => r.id));
  existing.forEach((node, id) => {
    if (!wanted.has(id)) node.remove();
  });

  let prev = null;
  for (const record of state.items) {
    let node = existing.get(record.id);
    if (node) {
      // Only touch the DOM if the badge state actually changed; the <img>
      // itself is deliberately left untouched.
      if (node.dataset.badges !== badgeKey(record)) {
        const fresh = card(record);
        node.replaceWith(fresh);
        node = fresh;
      }
    } else {
      node = card(record);
    }

    const shouldFollow = prev ? prev.nextElementSibling : grid.firstElementChild;
    if (shouldFollow !== node) {
      grid.insertBefore(node, prev ? prev.nextElementSibling : grid.firstElementChild);
    }
    prev = node;
  }

  applyLayout();
  updateSelectionUI();

  // Load-more button lives outside the grid; refresh it separately.
  const oldMore = el.content.querySelector('.load-more-wrap');
  if (oldMore) oldMore.remove();
  if (state.offset < state.total) {
    const wrap = document.createElement('div');
    wrap.className = 'load-more-wrap';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = `Load more (${state.total - state.offset} left)`;
    btn.addEventListener('click', () => load());
    wrap.appendChild(btn);
    el.content.appendChild(wrap);
  }

  el.countPill.textContent = `${state.total} image${state.total === 1 ? '' : 's'}`;
}

/**
 * Whether an image should be covered in the gallery.
 *
 * The manual mark is the user's answer and beats the classifier's guess;
 * the master setting beats both, so turning it off really does mean
 * nothing is flagged.
 */
function isNSFW(record) {
  if (!state.settings.flagNsfw) return false;
  return record.nsfwManual !== undefined && record.nsfwManual !== null
    ? !!record.nsfwManual
    : !!record.nsfwAuto;
}

/**
 * Everything about a card that, if it changes, means the card has to be
 * rebuilt. This has to be one function: it was written out twice, and the
 * two copies drifted the moment NSFW covers were added - the builder
 * stamped a flag the reconciler didn't know to look for, so flagged cards
 * were rebuilt on every refresh and never updated when the flag changed.
 */
function badgeKey(record) {
  return [
    record.pinned ? 'p' : '',
    record.favorite ? 'f' : '',
    record.color || '',
    isNSFW(record) ? 'n' : '',
    state.revealed.has(record.id) ? 'r' : '',
  ].join('');
}

const ICONS = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"></path><path d="M12 15v5"></path></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"></path></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9.5 7V5h5v2"></path><path d="M6.5 7l1 12.5h9L17.5 7"></path><path d="M10.5 10.5v6M13.5 10.5v6"></path></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>',
};

function cardActionBtn(kind, title, onClick, active) {
  const b = document.createElement('button');
  b.className = `card-action ${kind}${active ? ' active' : ''}`;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = ICONS[kind === 'delete' ? 'trash' : kind];
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  });
  return b;
}

function card(record) {
  const div = document.createElement('div');
  div.className = 'card';
  div.dataset.id = record.id;
  div.dataset.badges = badgeKey(record);
  div.draggable = true;

  const nsfw = isNSFW(record) && !state.revealed.has(record.id);
  div.classList.toggle('nsfw', nsfw);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.draggable = false; // the card owns the drag, not the bare image
  // The grid loads a cached thumbnail, not the original. The full PNG is
  // 1-3 MB and 1024px+; drawing thousands of those at 190px wide is what
  // makes a large library crawl. The server falls back to the original if
  // a thumbnail can't be made, so this is never a broken image.
  img.src = `/api/images/${record.id}/thumb`;
  img.alt = nsfw ? 'Explicit image, hidden' : (record.meta?.prompt?.slice(0, 60) || '');
  div.appendChild(img);

  // Swapping the card for a freshly built one keeps every other piece of
  // its state - position, selection, drag wiring - in one place instead of
  // patching classes by hand on each toggle.
  const reswap = () => {
    const fresh = card(record);
    fresh.setAttribute('style', div.getAttribute('style') || '');
    fresh.classList.toggle('selected', state.selection.has(record.id));
    div.replaceWith(fresh);
  };

  if (nsfw) {
    const cover = document.createElement('div');
    cover.className = 'nsfw-cover';
    cover.innerHTML = `
      <span class="nsfw-tag">NSFW</span>
      <button class="nsfw-reveal">Reveal</button>`;
    cover.querySelector('.nsfw-reveal').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.revealed.add(record.id);
      reswap();
    });
    div.appendChild(cover);
  } else if (isNSFW(record)) {
    // Revealed, and still flagged: offer the way back. Revealing to check
    // one image shouldn't mean it stays uncovered for the rest of the
    // session with no way to put the cover back short of a reload.
    const hide = document.createElement('button');
    hide.className = 'nsfw-hide';
    hide.title = 'Hide this again';
    hide.setAttribute('aria-label', 'Hide this again');
    hide.innerHTML = `<svg viewBox="0 0 20 20" width="13" height="13" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3l14 14" />
      <path d="M8.2 4.4A7.4 7.4 0 0 1 10 4.2c4 0 6.7 3 7.4 4.3.2.3.2.7 0 1a12 12 0 0 1-2.3 2.7" />
      <path d="M13.3 13.3A7.7 7.7 0 0 1 10 14.2c-4 0-6.7-3-7.4-4.3a1 1 0 0 1 0-1 12.6 12.6 0 0 1 2.8-3.1" />
      <path d="M8.6 8.7a2 2 0 0 0 2.7 2.7" />
    </svg>`;
    hide.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.revealed.delete(record.id);
      reswap();
    });
    div.appendChild(hide);
  }

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';
  if (record.meta?.prompt) {
    const p = document.createElement('div');
    p.className = 'card-prompt';
    p.textContent = record.meta.prompt;
    overlay.appendChild(p);
  }
  div.appendChild(overlay);

  // Text column, only visible in list layout.
  const info = document.createElement('div');
  info.className = 'card-info';
  const infoPrompt = document.createElement('div');
  infoPrompt.className = 'card-info-prompt';
  infoPrompt.textContent = record.meta?.prompt || record.filename;
  const infoMeta = document.createElement('div');
  infoMeta.className = 'card-info-meta';
  const m = record.meta || {};
  infoMeta.textContent = [
    m.model,
    m.width && m.height ? `${m.width} × ${m.height}` : null,
    m.seed !== undefined && m.seed !== null && m.seed !== '' ? `seed ${m.seed}` : null,
    new Date(record.addedAt).toLocaleDateString(),
  ].filter(Boolean).join('  ·  ');
  info.appendChild(infoPrompt);
  info.appendChild(infoMeta);
  div.appendChild(info);

  if (record.color) {
    const dot = document.createElement('span');
    dot.className = 'card-color';
    dot.style.background = record.color;
    dot.title = colorLabelName(record.color);
    div.appendChild(dot);
  }

  if (record.favorite || record.pinned) {
    const badges = document.createElement('div');
    badges.className = 'card-badges';
    if (record.pinned) badges.appendChild(badge('pin', '📌'));
    if (record.favorite) badges.appendChild(badge('star', '★'));
    div.appendChild(badges);
  }

  // Hover actions. Kept out of the click path for the card itself so a
  // stray click never deletes something.
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.appendChild(cardActionBtn('pin', record.pinned ? 'Unpin' : 'Pin',
    () => setFlag(record, 'pinned', !record.pinned), record.pinned));
  actions.appendChild(cardActionBtn('star', record.favorite ? 'Remove from favorites' : 'Favorite',
    () => setFlag(record, 'favorite', !record.favorite), record.favorite));
  actions.appendChild(cardActionBtn('delete', 'Delete image', () => deleteImages([record.id])));
  div.appendChild(actions);

  const check = document.createElement('button');
  check.className = 'card-check';
  check.title = 'Select';
  check.setAttribute('aria-label', 'Select image');
  check.innerHTML = ICONS.check;
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectMode(true);
    toggleSelection(record.id, e.shiftKey);
  });
  div.appendChild(check);

  div.addEventListener('click', (e) => {
    // In select mode, or with a modifier held, clicking picks rather than opens.
    if (state.selectMode || e.ctrlKey || e.metaKey || e.shiftKey) {
      setSelectMode(true);
      toggleSelection(record.id, e.shiftKey);
      return;
    }
    selectRecord(record);
    openViewer(record);
  });

  div.addEventListener('dragstart', (e) => onCardDragStart(e, record));
  div.addEventListener('dragend', () => {
    document.querySelectorAll('.card.dragging').forEach((n) => n.classList.remove('dragging'));
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });

  return div;
}

function badge(kind, glyph) {
  const b = document.createElement('div');
  b.className = `card-badge ${kind}`;
  b.textContent = glyph;
  return b;
}

// ---------------------------------------------------------------- layout

const GAP = 14;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function aspectOf(record) {
  const w = record?.meta?.width;
  const h = record?.meta?.height;
  if (w > 0 && h > 0) return w / h;
  return 1;
}

/**
 * Justified and waterfall need real geometry, so they're measured in JS and
 * written as inline transforms. Cards keep their document order either way,
 * which is what lets the flicker-free reconciliation above stay simple.
 */
function applyLayout() {
  const grid = el.content.querySelector('.grid');
  if (!grid) return;

  const mode = state.settings.layout;
  grid.className = `grid layout-${mode}`;

  const cards = Array.from(grid.children).filter((n) => n.classList.contains('card'));
  if (mode === 'grid' || mode === 'list') {
    grid.style.height = '';
    cards.forEach((c) => c.removeAttribute('style'));
    return;
  }

  const width = grid.clientWidth;
  if (width <= 0 || cards.length === 0) return;

  const byId = new Map(state.items.map((r) => [r.id, r]));
  const target = state.settings.cardSize || 190;
  if (mode === 'justified') layoutJustified(grid, cards, byId, width, target);
  else layoutWaterfall(grid, cards, byId, width, target);
}

function place(node, x, y, w, h) {
  node.style.position = 'absolute';
  node.style.left = '0';
  node.style.top = '0';
  node.style.width = `${Math.round(w)}px`;
  node.style.height = `${Math.round(h)}px`;
  node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function layoutJustified(grid, cards, byId, width, target) {
  let row = [];
  let sum = 0;
  let y = 0;

  const flush = (isLast) => {
    if (!row.length) return;
    const gaps = GAP * (row.length - 1);
    let h = (width - gaps) / sum;
    // A last row holding one wide image would otherwise stretch to a
    // full-bleed banner; hold it near the chosen size instead.
    if (isLast && h > target * 1.45) h = target;
    let x = 0;
    row.forEach((entry, i) => {
      let w = entry.aspect * h;
      if (i === row.length - 1 && !isLast) w = width - x; // absorb rounding
      place(entry.node, x, y, w, h);
      x += w + GAP;
    });
    y += h + GAP;
    row = [];
    sum = 0;
  };

  for (const node of cards) {
    const aspect = clamp(aspectOf(byId.get(node.dataset.id)), 0.3, 4.5);
    row.push({ node, aspect });
    sum += aspect;
    if (sum * target + GAP * (row.length - 1) >= width) flush(false);
  }
  flush(true);

  grid.style.height = `${Math.max(0, Math.round(y - GAP))}px`;
}

function layoutWaterfall(grid, cards, byId, width, target) {
  const cols = Math.max(1, Math.round((width + GAP) / (target + GAP)));
  const colW = (width - GAP * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);

  for (const node of cards) {
    const aspect = clamp(aspectOf(byId.get(node.dataset.id)), 0.25, 5);
    const h = colW / aspect;
    // Shortest column wins, so the order stays roughly left-to-right
    // instead of the column-major order CSS columns would give.
    let c = 0;
    for (let i = 1; i < cols; i++) {
      if (heights[i] < heights[c] - 0.5) c = i;
    }
    place(node, c * (colW + GAP), heights[c], colW, h);
    heights[c] += h + GAP;
  }

  grid.style.height = `${Math.max(0, Math.round(Math.max(...heights) - GAP))}px`;
}

let layoutTimer;
function scheduleLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(applyLayout, 60);
}
new ResizeObserver(scheduleLayout).observe(el.content);

// ---------------------------------------------------------------- selection

function setSelectMode(on) {
  if (state.selectMode === on) return;
  state.selectMode = on;
  el.app.classList.toggle('select-mode', on);
  el.selectBtn.classList.toggle('active', on);
  if (!on) state.selection.clear();
  updateSelectionUI();
}

function toggleSelection(id, viaShift) {
  if (viaShift && state.anchorId) {
    const ids = state.items.map((r) => r.id);
    const a = ids.indexOf(state.anchorId);
    const b = ids.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) state.selection.add(ids[i]);
      updateSelectionUI();
      return;
    }
  }
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.anchorId = id;
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selection.size;
  el.content.querySelectorAll('.card').forEach((node) => {
    node.classList.toggle('selected', state.selection.has(node.dataset.id));
  });
  el.bulkbar.hidden = !state.selectMode && n === 0;
  el.bulkCount.textContent = n === 0
    ? 'Select images'
    : `${n} selected`;
  [el.bulkPin, el.bulkFav, el.bulkDelete, el.bulkFolderBtn].forEach((b) => { b.disabled = n === 0; });
  const allSelected = state.items.length > 0 && n >= state.items.length;
  el.bulkSelectAll.textContent = allSelected ? 'Select none' : 'Select all';
}

async function bulkRequest(body) {
  const res = await fetch('/api/images/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function selectedIds() {
  return Array.from(state.selection);
}

async function bulkFlag(field, value) {
  const ids = selectedIds();
  if (!ids.length) return;
  try {
    await bulkRequest({ action: 'update', ids, [field]: value });
  } catch (e) {
    return toast('Could not save that change');
  }
  ids.forEach((id) => {
    const rec = state.items.find((r) => r.id === id);
    if (rec) rec[field] = value;
  });
  render();
  refreshCounts();
  toast(`${ids.length} image${ids.length === 1 ? '' : 's'} ${
    field === 'pinned' ? (value ? 'pinned' : 'unpinned') : (value ? 'favorited' : 'unfavorited')}`);
}

async function moveToFolder(ids, folderId, folderName) {
  if (!ids.length) return;
  try {
    await bulkRequest({ action: 'update', ids, addFolders: [folderId] });
  } catch (e) {
    return toast('Could not move those images');
  }
  toast(`${ids.length} image${ids.length === 1 ? '' : 's'} added to ${folderName}`);
  load({ reset: true, silent: true });
}

// ---------------------------------------------------------------- deleting

async function deleteImages(ids, { skipConfirm } = {}) {
  if (!ids.length) return;
  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: ids.length === 1 ? 'Delete this image?' : `Delete ${ids.length} images?`,
      body: ids.length === 1
        ? 'The image file and its prompt metadata are removed from this gallery for good.'
        : `The ${ids.length} selected image files and their prompt metadata are removed from this gallery for good.`,
      confirmLabel: ids.length === 1 ? 'Delete image' : `Delete ${ids.length} images`,
    });
    if (!ok) return;
  }

  try {
    if (ids.length === 1) {
      const res = await fetch(`/api/images/${ids[0]}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else {
      await bulkRequest({ action: 'delete', ids });
    }
  } catch (e) {
    return toast('Could not delete');
  }

  const gone = new Set(ids);
  state.items = state.items.filter((r) => r.id !== undefined && !gone.has(r.id));
  ids.forEach((id) => state.selection.delete(id));
  state.total = Math.max(0, state.total - ids.length);
  state.offset = Math.max(0, state.offset - ids.length);
  if (state.current && gone.has(state.current.id)) closeViewer();
  if (state.selected && gone.has(state.selected.id)) { state.selected = null; renderInspector(); }

  render();
  refreshCounts();
  refreshUndoState();
  toast(ids.length === 1 ? 'Image deleted' : `${ids.length} images deleted`);
}

async function clearGallery() {
  let total = state.total;
  try {
    total = (await fetch('/api/images?limit=1').then((r) => r.json())).total;
  } catch (e) { /* fall back to what's on screen */ }

  if (!total) return toast('The gallery is already empty');

  const ok = await confirmDialog({
    title: 'Clear the whole gallery?',
    body: `All <strong>${total}</strong> image${total === 1 ? '' : 's'} and their prompt
           metadata are permanently deleted from this gallery. Your folders, themes and
           settings are kept, and any copies you saved elsewhere on your PC are untouched.
           <br><br>This cannot be undone.`,
    confirmLabel: `Delete all ${total} images`,
  });
  if (!ok) return;

  try {
    const res = await fetch('/api/images', { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    return toast('Could not clear the gallery');
  }

  state.selection.clear();
  setSelectMode(false);
  closeViewer();
  state.selected = null;
  renderInspector();
  el.settingsModal.hidden = true;
  await load({ reset: true });
  refreshCounts();
  toast('Gallery cleared');
}

/* ---------------------------------------------------------------- context menu

   One menu, built from whatever was right-clicked. Text inputs are left
   alone so the browser's own copy/paste menu still works where it's the
   useful one.
*/

let ctxOpen = false;

function closeContextMenu() {
  if (!ctxOpen) return;
  ctxOpen = false;
  el.ctxMenu.hidden = true;
  el.ctxMenu.innerHTML = '';
}

/**
 * items: [{ label, detail, danger, disabled, icon, action }] or 'sep'.
 * A `submenu` function returns a fresh item list, drilled into in place -
 * simpler and more reliable than a flyout, and it can't open off-screen.
 */
function openContextMenu(x, y, items, title) {
  el.ctxMenu.innerHTML = '';
  if (title) {
    const h = document.createElement('div');
    h.className = 'ctx-title';
    h.textContent = title;
    el.ctxMenu.appendChild(h);
  }

  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      el.ctxMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `ctx-item${item.danger ? ' danger' : ''}${item.back ? ' back' : ''}`;
    btn.disabled = !!item.disabled;
    btn.innerHTML = `
      <span class="ctx-icon">${item.icon || ''}</span>
      <span class="ctx-label">${esc(item.label)}</span>
      ${item.detail ? `<span class="ctx-detail">${esc(item.detail)}</span>` : ''}
      ${item.submenu ? '<span class="ctx-arrow">›</span>' : ''}`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (item.submenu) {
        const { items: sub, title: subTitle } = item.submenu();
        openContextMenu(x, y, sub, subTitle);
        return;
      }
      closeContextMenu();
      item.action?.();
    });
    el.ctxMenu.appendChild(btn);
  }

  // Show it before measuring, then keep it inside the window.
  el.ctxMenu.hidden = false;
  ctxOpen = true;
  const rect = el.ctxMenu.getBoundingClientRect();
  const left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6));
  el.ctxMenu.style.left = `${Math.round(left)}px`;
  el.ctxMenu.style.top = `${Math.round(top)}px`;
}

const CTX_ICONS = {
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><circle cx="8.5" cy="9.5" r="1.6"></circle><path d="M21 15l-5-4.5L7 20"></path></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M8 12.5l2.8 2.8L16.5 9"></path></svg>',
  reuse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path></svg>',
  explorer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M12 15V9.5"></path><path d="M9.5 12L12 9.5l2.5 2.5"></path></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"></path><path d="M8 8l4-4 4 4"></path><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"></path></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"></path><circle cx="12" cy="12" r="2.6"></circle></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 2.64 6.36"></path><path d="M3 3v6h6"></path></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 0-2.64 6.36"></path><path d="M21 3v6h-6"></path></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"></path><path d="M14 6l4 4"></path></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"></path><circle cx="7.5" cy="7.5" r="1.4"></circle></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-1.8 0-1.6-1.6-1.8-1.6-3 0-1 .8-1.7 1.9-1.7H16a5 5 0 0 0 5-5c0-3.6-4-6.5-9-6.5z"></path><circle cx="8" cy="10" r="1.2"></circle><circle cx="12" cy="7.5" r="1.2"></circle></svg>',
  trash: ICONS.trash,
  star: ICONS.star,
  pin: ICONS.pin,
};

/** The folder list, as menu items that file the given images. */
function folderSubmenu(ids) {
  return () => {
    const items = [{ label: 'Back', back: true, icon: '‹', submenu: () => imageMenu(ids) }];
    if (state.folders.length === 0) {
      items.push({ label: 'No folders yet', disabled: true });
    } else {
      for (const f of state.folders) {
        items.push({
          label: f.name,
          icon: CTX_ICONS.folder,
          action: () => moveToFolder(ids, f.id, f.name),
        });
      }
    }
    items.push('sep', {
      label: 'New folder…',
      icon: '+',
      action: async () => {
        const folder = await createFolder();
        if (folder) moveToFolder(ids, folder.id, folder.name);
      },
    });
    return { items, title: ids.length === 1 ? 'Move to folder' : `Move ${ids.length} images to` };
  };
}

function imageMenu(ids) {
  const many = ids.length > 1;
  const record = state.items.find((r) => r.id === ids[0]);
  const noun = many ? `${ids.length} images` : 'image';

  const items = [];
  if (!many && record) {
    items.push({
      label: 'Open',
      icon: CTX_ICONS.open,
      action: () => { selectRecord(record); openViewer(record); },
    });
  }
  items.push({
    label: state.selection.has(ids[0]) && many ? 'Keep selection' : `Select ${many ? 'these' : 'this'}`,
    icon: CTX_ICONS.select,
    action: () => {
      setSelectMode(true);
      ids.forEach((id) => state.selection.add(id));
      updateSelectionUI();
    },
  });
  items.push('sep');
  items.push({
    label: `Move ${noun} to folder`,
    icon: CTX_ICONS.folder,
    submenu: folderSubmenu(ids),
  });

  const allPinned = ids.every((id) => state.items.find((r) => r.id === id)?.pinned);
  const allFav = ids.every((id) => state.items.find((r) => r.id === id)?.favorite);
  items.push({
    label: allPinned ? `Unpin ${noun}` : `Pin ${noun}`,
    icon: CTX_ICONS.pin,
    action: () => (many
      ? bulkFlag('pinned', !allPinned)
      : setFlag(record, 'pinned', !record.pinned)),
  });
  items.push({
    label: allFav ? `Remove ${noun} from favorites` : `Favorite ${noun}`,
    icon: CTX_ICONS.star,
    action: () => (many
      ? bulkFlag('favorite', !allFav)
      : setFlag(record, 'favorite', !record.favorite)),
  });

  if (!many && record) {
    items.push('sep');
    items.push({
      label: 'Reuse prompt in NovelAI',
      icon: CTX_ICONS.reuse,
      action: () => {
        selectRecord(record);
        openViewer(record);
        setTimeout(() => el.detailsBody.querySelector('#reuseBtn')?.click(), 150);
      },
    });
    // The other destination for the same prompt: this app's own Generate
    // tab rather than the website. Both stay available.
    items.push({
      label: 'Edit in Generate',
      detail: 'load into the Generate tab',
      icon: CTX_ICONS.reuse,
      action: () => genLoadFrom(record),
    });
    items.push({
      label: 'Copy prompt',
      icon: CTX_ICONS.copy,
      disabled: !record.meta?.prompt,
      action: () => navigator.clipboard.writeText(record.meta?.prompt || '')
        .then(() => toast('Prompt copied')).catch(() => toast('Could not copy')),
    });
    items.push({
      label: 'Open in folder',
      icon: CTX_ICONS.explorer,
      action: () => revealImage(record),
    });
  }

  items.push({
    label: 'Colour label',
    icon: CTX_ICONS.palette,
    submenu: () => ({
      title: many ? `Colour ${ids.length} images` : 'Colour label',
      items: [
        { label: 'Back', back: true, icon: '‹', submenu: () => imageMenu(ids) },
        ...LABEL_COLORS.map(([hex]) => ({
          label: colorLabelName(hex),
          icon: `<span class="ctx-swatch" style="background:${hex}"></span>`,
          action: () => setColorLabel(ids, hex),
        })),
        { label: 'No colour', action: () => setColorLabel(ids, '') },
      ],
    }),
  });

  if (state.settings.flagNsfw) {
    const allFlagged = ids.every((id) => {
      const rec = state.items.find((r) => r.id === id);
      return rec && isNSFW(rec);
    });
    items.push('sep');
    items.push({
      label: allFlagged ? `Remove NSFW mark` : `Mark ${noun} as NSFW`,
      icon: CTX_ICONS.eye,
      action: () => setNSFW(ids, !allFlagged),
    });
    const anyManual = ids.some((id) => {
      const rec = state.items.find((r) => r.id === id);
      return rec && rec.nsfwManual !== undefined && rec.nsfwManual !== null;
    });
    if (anyManual && !many) {
      items.push({
        label: 'Reset to automatic',
        icon: CTX_ICONS.refresh,
        action: () => setNSFW(ids, null),
      });
    }
  }

  items.push('sep');
  items.push({
    label: many ? `Delete ${ids.length} images` : 'Delete image',
    icon: CTX_ICONS.trash,
    danger: true,
    action: () => deleteImages(ids),
  });
  return items;
}

function folderRowMenu(folder) {
  return [
    { label: 'Open folder', icon: CTX_ICONS.folder, action: () => selectView('folder', folder.id) },
    'sep',
    { label: 'Rename…', icon: CTX_ICONS.rename, action: () => renameFolder(folder) },
    {
      label: 'New subfolder…',
      icon: CTX_ICONS.folder,
      action: () => createFolder(folder.id, folder.name),
    },
    { label: 'Tags…', detail: (folder.tags || []).join(', ') || 'none', icon: CTX_ICONS.tag,
      action: () => editFolderTags(folder) },
    'sep',
    {
      label: 'Move to top level',
      icon: CTX_ICONS.folder,
      disabled: !folder.parentId,
      action: () => moveFolder(folder.id, '', -1),
    },
    'sep',
    {
      label: 'Delete folder',
      detail: 'images are kept',
      icon: CTX_ICONS.trash,
      danger: true,
      action: async () => {
        const kids = state.folders.filter((f) => f.parentId === folder.id).length;
        const ok = await confirmDialog({
          title: `Delete the folder “${folder.name}”?`,
          body: `The folder${kids ? ` and its ${kids} subfolder${kids === 1 ? '' : 's'}` : ''} is removed and
                 its images stop being filed under it. The images themselves are not deleted,
                 and this can be undone.`,
          confirmLabel: 'Delete folder',
        });
        if (!ok) return;
        const res = await fetch(`/api/folders/${folder.id}`, { method: 'DELETE' });
        if (!res.ok) return toast('Could not delete that folder');
        if (state.folderId === folder.id) selectView('all');
        else { loadFolders(); load({ reset: true, silent: true }); }
        refreshUndoState();
        toast('Folder deleted');
      },
    },
  ];
}

function galleryMenu() {
  return [
    {
      label: state.undo.canUndo ? `Undo ${state.undo.undoLabel.toLowerCase()}` : 'Undo',
      detail: 'Ctrl+Z',
      icon: CTX_ICONS.undo,
      disabled: !state.undo.canUndo,
      action: () => doUndo(false),
    },
    {
      label: state.undo.canRedo ? `Redo ${state.undo.redoLabel.toLowerCase()}` : 'Redo',
      detail: 'Ctrl+Y',
      icon: CTX_ICONS.redo,
      disabled: !state.undo.canRedo,
      action: () => doUndo(true),
    },
    'sep',
    { label: 'Import images…', icon: CTX_ICONS.import, action: () => el.importInput.click() },
    { label: 'Refresh', icon: CTX_ICONS.refresh, action: () => { load({ reset: true }); loadFolders(); } },
    'sep',
    {
      label: 'Select all',
      icon: CTX_ICONS.select,
      disabled: state.items.length === 0,
      action: () => {
        setSelectMode(true);
        state.items.forEach((r) => state.selection.add(r.id));
        updateSelectionUI();
      },
    },
    {
      label: 'New folder…',
      icon: CTX_ICONS.folder,
      action: () => createFolder(),
    },
  ];
}

document.addEventListener('contextmenu', (e) => {
  // Leave text alone: the browser's own menu is the useful one there.
  if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
  // Modals get the default menu too, rather than a gallery menu behind them.
  if (e.target.closest('.modal:not([hidden])')) return;

  const card = e.target.closest('.card');
  if (card) {
    e.preventDefault();
    const id = card.dataset.id;
    // Right-clicking inside a selection acts on the whole selection;
    // right-clicking outside one acts on just that image.
    const ids = state.selection.has(id) && state.selection.size > 1
      ? selectedIds()
      : [id];
    openContextMenu(e.clientX, e.clientY, imageMenu(ids),
      ids.length > 1 ? `${ids.length} images` : null);
    return;
  }

  const viewerImg = e.target.closest('#viewerImg, .inspector-thumb');
  if (viewerImg) {
    const record = state.current || state.selected;
    if (record) {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, imageMenu([record.id]));
    }
    return;
  }

  const folderRow = e.target.closest('#folderList .folder-row');
  if (folderRow) {
    const folder = state.folders.find((f) => f.id === folderRow.dataset.folderId);
    if (folder) {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, folderRowMenu(folder), folder.name);
    }
    return;
  }

  if (e.target.closest('.content')) {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, galleryMenu());
  }
});

document.addEventListener('click', closeContextMenu);
document.addEventListener('scroll', closeContextMenu, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); }, true);

// ---------------------------------------------------------------- drag to folder

const DRAG_TYPE = 'application/x-novelai-gallery-ids';

function onCardDragStart(e, record) {
  // Dragging a card that's part of the selection drags the whole selection;
  // dragging anything else drags just that image.
  const ids = state.selection.has(record.id) && state.selection.size > 0
    ? selectedIds()
    : [record.id];

  try {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.join(','));
  } catch (err) { /* nothing usable to drag */ }
  e.dataTransfer.effectAllowed = 'copy';

  el.app.classList.add('dragging-images');
  ids.forEach((id) => {
    const node = el.content.querySelector(`.card[data-id="${id}"]`);
    if (node) node.classList.add('dragging');
  });

  if (ids.length > 1) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = `${ids.length} images`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  }
}

document.addEventListener('dragend', () => el.app.classList.remove('dragging-images'));

/** Wire a sidebar row so images can be dropped onto it. */
function wireImageDropTarget(node, handler) {
  node.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove('drop-target');
    el.app.classList.remove('dragging-images');
    let ids = [];
    try {
      ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]');
    } catch (err) { /* malformed drag payload */ }
    if (ids.length) handler(ids);
  });
}

// ---------------------------------------------------------------- metadata rendering

function tagChip(tag, negative) {
  const weighted = window.PromptModel.isWeighted(tag);
  return `<button class="tag${weighted ? ' weighted' : ''}${negative ? ' negative' : ''}" data-tag="${esc(tag)}">${esc(tag)}</button>`;
}

/**
 * Sections start collapsed. An image can carry four of them and 100+ tags;
 * expanded by default that buries the generation settings under a wall of
 * chips you have to scroll past every time. The headers still show a count,
 * so nothing is hidden - it just isn't shouted.
 */
function isSectionCollapsed(id) {
  return state.collapsed[id] !== false;
}

function sectionHtml(section) {
  const collapsed = isSectionCollapsed(section.id) ? ' collapsed' : '';
  const negative = section.kind === 'negative';

  let count = 0;
  let body = '';

  count = section.tags.length + (section.negative?.tags.length || 0);
  body = section.tags.length
    ? `<div class="tags">${section.tags.map((t) => tagChip(t, negative)).join('')}</div>`
    : '';

  // A subject's own undesired content sits under it rather than in a list
  // of its own further down, so it is obvious which belongs to which.
  if (section.negative) {
    body += `
      <div class="uc-block">
        <div class="uc-label">UC</div>
        <div class="tags">${section.negative.tags.map((t) => tagChip(t, true)).join('')}</div>
      </div>`;
  }

  return `
    <div class="section${collapsed}" data-section="${section.id}">
      <button class="section-head">
        <svg class="section-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6"></path>
        </svg>
        <span class="section-name">${esc(section.name)}</span>
        <span class="section-tally">${count}</span>
      </button>
      <div class="section-body">
        ${body}
        <button class="raw-toggle" data-raw="${section.id}">Show raw text</button>
        <div class="raw-text" data-raw-for="${section.id}" hidden>${esc(section.raw)}</div>
      </div>
    </div>`;
}

/** The same collapsible shell the prompt sections use, for anything else. */
function collapsibleHtml(id, name, tally, body) {
  const collapsed = isSectionCollapsed(id) ? ' collapsed' : '';
  return `
    <div class="section${collapsed}" data-section="${id}">
      <button class="section-head">
        <svg class="section-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6"></path>
        </svg>
        <span class="section-name">${esc(name)}</span>
        ${tally ? `<span class="section-tally">${esc(tally)}</span>` : ''}
      </button>
      <div class="section-body">${body}</div>
    </div>`;
}

function specsHtml(m) {
  const specs = [
    ['Model', m.model], ['Sampler', m.sampler], ['Steps', m.steps], ['Guidance', m.scale],
    ['Seed', m.seed], ['Strength', m.strength], ['Noise', m.noise],
    ['Size', m.width && m.height ? `${m.width} × ${m.height}` : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!specs.length) return '';
  return collapsibleHtml('generation', 'Generation', specs.length, `
    <div class="spec-grid">
      ${specs.map(([k, v]) => `<div class="spec"><div class="spec-key">${esc(k)}</div><div class="spec-val">${esc(v)}</div></div>`).join('')}
    </div>`);
}

/**
 * The same sections as plain text in a box, for people who'd rather copy a
 * prompt straight out than read it as chips.
 */
function rawSectionHtml(section) {
  const box = (id, label, text, negative) => `
    <div class="raw-head">
      <span class="raw-name${negative ? ' negative' : ''}">${esc(label)}</span>
      <button class="raw-copy" data-copy="${id}">Copy</button>
    </div>
    <textarea class="raw-box" readonly spellcheck="false"
      data-raw-box="${id}">${esc(text)}</textarea>`;

  return `
    <div class="raw-section" data-section="${section.id}">
      ${section.raw ? box(section.id, section.name, section.raw, false) : ''}
      ${section.negative
        ? box(`${section.id}-uc`, `${section.name} — UC`, section.negative.raw, true)
        : ''}
    </div>`;
}

/** Renders the shared metadata body used by both the panel and the modal. */
function renderMetaInto(container, record, { showReuse } = {}) {
  const m = record.meta || {};
  const sections = window.PromptModel.buildSections(m);
  const raw = state.settings.metaView === 'raw';

  container.innerHTML = `
    ${showReuse ? `
      <div class="reuse-row">
        <button class="btn primary reuse-main" id="reuseBtn">Reuse prompt in NovelAI</button>
        <button class="btn reuse-side" id="editGenBtn" title="Load this prompt into Image Generation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v6M9 6l3-3 3 3"></path>
            <path d="M5 12h14v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"></path>
          </svg>
          <span>Generate</span>
        </button>
        <button class="btn reuse-side" id="revealBtn" title="Show this file in File Explorer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          </svg>
          <span>Folder</span>
        </button>
      </div>
      <div class="color-row">
        <span class="color-row-label">Colour tags</span>
        ${LABEL_COLORS.map(([hex]) => `
          <button class="color-pick${record.color === hex ? ' active' : ''}" data-color="${hex}"
            style="background:${hex}" title="${esc(colorLabelName(hex))}"></button>`).join('')}
        <button class="color-pick none${!record.color ? ' active' : ''}" data-color="" title="No colour"></button>
      </div>
      <label class="nsfw-row">
        <input type="checkbox" class="switch-input" id="nsfwToggle"${isNSFW(record) ? ' checked' : ''} />
        <span class="switch-track"><span class="switch-knob"></span></span>
        <span class="nsfw-row-text">
          Mark as NSFW
          <span class="nsfw-row-sub">${state.settings.flagNsfw
            ? (record.nsfwManual === undefined || record.nsfwManual === null
                ? 'Set automatically from the prompt'
                : 'Set by you')
            : 'Flagging is off in Settings'}</span>
        </span>
      </label>
      <div class="hint" id="reuseHint">Hands this image to an open NovelAI tab, the same as dragging the file in — NovelAI reads the prompt and settings back out of it.</div>` : ''}
    ${sections.map(raw ? rawSectionHtml : sectionHtml).join('')}
    ${specsHtml(m)}
    ${collapsibleHtml('file', 'File', '', `
      <div class="field">
        <div class="field-label">Added</div>
        <div class="spec-val">${esc(new Date(record.addedAt).toLocaleString())}</div>
      </div>
      ${imagePathOf(record) ? `
        <div class="field">
          <div class="field-label">On disk</div>
          <div class="file-path" id="filePath" title="${esc(imagePathOf(record))}">${esc(imagePathOf(record))}</div>
        </div>` : ''}`)}`;

  // Collapse / expand
  container.querySelectorAll('.section-head').forEach((head) => {
    head.addEventListener('click', () => {
      const sec = head.closest('.section');
      const id = sec.dataset.section;
      state.collapsed[id] = !isSectionCollapsed(id);
      sec.classList.toggle('collapsed', isSectionCollapsed(id));
    });
  });

  // Raw text reveal
  container.querySelectorAll('.raw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = container.querySelector(`[data-raw-for="${btn.dataset.raw}"]`);
      const nowHidden = !target.hidden;
      target.hidden = nowHidden;
      btn.textContent = nowHidden ? 'Show raw text' : 'Hide raw text';
    });
  });

  // Raw view: copy buttons, and boxes that grow to their content.
  // Grow to the text, but only so far: a long prompt should scroll inside
  // its box rather than pushing everything else off the panel. The box is
  // still resizable by hand.
  container.querySelectorAll('.raw-box').forEach((box) => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight + 2, 168)}px`;
    box.addEventListener('focus', () => box.select());
  });
  container.querySelectorAll('.raw-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = container.querySelector(`[data-raw-box="${btn.dataset.copy}"]`);
      if (!box) return;
      navigator.clipboard.writeText(box.value).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1300);
      }).catch(() => {
        box.select();
        toast('Press Ctrl+C to copy');
      });
    });
  });

  const reuseBtn = container.querySelector('#reuseBtn');
  if (reuseBtn) reuseBtn.addEventListener('click', () => reusePrompt(record, container));

  container.querySelectorAll('.color-pick').forEach((b) => {
    b.addEventListener('click', () => setColorLabel(record.id, b.dataset.color));
  });

  const nsfwToggle = container.querySelector('#nsfwToggle');
  if (nsfwToggle) {
    nsfwToggle.disabled = !state.settings.flagNsfw;
    nsfwToggle.addEventListener('change', () => setNSFW(record.id, nsfwToggle.checked));
  }

  const editGenBtn = container.querySelector('#editGenBtn');
  if (editGenBtn) editGenBtn.addEventListener('click', () => genLoadFrom(record));

  const revealBtn = container.querySelector('#revealBtn');
  if (revealBtn) revealBtn.addEventListener('click', () => revealImage(record, revealBtn));

  const pathEl = container.querySelector('#filePath');
  if (pathEl) {
    pathEl.addEventListener('click', () => {
      navigator.clipboard.writeText(pathEl.textContent).then(() => toast('Path copied')).catch(() => {});
    });
  }

  // Click a tag to search for it
  container.querySelectorAll('.tag').forEach((t) => {
    t.addEventListener('click', () => {
      el.search.value = t.dataset.tag;
      el.searchClear.classList.add('visible');
      state.query = t.dataset.tag;
      closeViewer();
      load({ reset: true });
    });
  });
}

/**
 * Ask the extension to hand this image to NovelAI.
 *
 * The gallery can't message the extension directly, so it posts the
 * request to the app, which the extension is long-polling. We then poll
 * for the outcome so the button can report what actually happened rather
 * than just claiming success.
 */
async function reusePrompt(record, container) {
  const btn = container.querySelector('#reuseBtn');
  const hint = container.querySelector('#reuseHint');
  if (!btn) return;

  const setHint = (text, kind) => {
    if (!hint) return;
    hint.textContent = text;
    hint.className = `hint${kind ? ' ' + kind : ''}`;
  };

  btn.disabled = true;
  btn.textContent = 'Sending…';
  setHint('Looking for an open NovelAI tab…');

  try {
    const res = await fetch('/api/reuse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: record.id }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    // Wait for the extension to report back. The drop routine deliberately
    // takes a moment - it has to let the page react to the drag before it
    // lets go - so this window is generous.
    const deadline = Date.now() + 25000;
    let final = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await fetch('/api/reuse/status').then((r) => r.json()).catch(() => null);
      if (st && st.id === record.id && st.state && st.state !== 'pending') {
        final = st;
        break;
      }
    }

    if (!final) {
      setHint(
        'No answer from the extension. Check it\'s installed and that a NovelAI tab is open.',
        'warn'
      );
      toast('No response from the extension');
    } else if (final.state === 'delivered') {
      setHint('Sent to NovelAI — switch to that tab.', 'ok');
      toast('Sent to NovelAI');
    } else if (final.state === 'no-tab') {
      setHint('No NovelAI tab is open. Open NovelAI, then try again.', 'warn');
      toast('No NovelAI tab open');
    } else {
      setHint(final.message || 'NovelAI did not accept the image.', 'warn');
      toast('Could not hand it to NovelAI');
    }
  } catch (err) {
    setHint('Could not send: ' + err.message, 'warn');
    toast('Reuse failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reuse prompt in NovelAI';
  }
}

// ---------------------------------------------------------------- inspector

function selectRecord(record) {
  state.selected = record;
  renderInspector();
}

function renderInspector() {
  const r = state.selected;
  if (!r) {
    el.inspectorBody.innerHTML = `<div class="empty-note">Select an image to see its prompt and settings here.</div>`;
    return;
  }
  el.inspectorBody.innerHTML = `<img class="inspector-thumb" id="inspectorThumb" src="/api/images/${r.id}/thumb" alt="" />
    <div id="inspectorMeta"></div>`;
  el.inspectorBody.querySelector('#inspectorThumb').addEventListener('click', () => openViewer(r));
  renderMetaInto(el.inspectorBody.querySelector('#inspectorMeta'), r, { showReuse: false });
}

function toggleInspector(force) {
  const open = force !== undefined ? force : !state.settings.inspectorOpen;
  saveSettings({ inspectorOpen: open });
  if (open) renderInspector();
}

/* ---------------------------------------------------------------- full size

   The large view is sized to fit alongside the metadata panel, which is
   the right default but no good for actually looking at detail. This is
   the whole window, the image at any zoom you like, and a way back.
*/

const zoom = {
  scale: 1,
  minScale: 0.05,
  maxScale: 8,
  x: 0,
  y: 0,
  fit: true,
  dragging: false,
  startX: 0,
  startY: 0,
};

function fitScale() {
  const c = el.zoomCanvas.getBoundingClientRect();
  const nw = el.zoomImg.naturalWidth;
  const nh = el.zoomImg.naturalHeight;
  if (!nw || !nh || !c.width || !c.height) return 1;
  // Never upscale to fill: "fit" means the whole picture, not a blown-up
  // version of a small one.
  return Math.min(1, Math.min((c.width - 48) / nw, (c.height - 48) / nh));
}

function applyZoom() {
  el.zoomImg.style.transform =
    `translate(calc(-50% + ${zoom.x}px), calc(-50% + ${zoom.y}px)) scale(${zoom.scale})`;
  el.zoomLevel.textContent = zoom.fit ? 'Fit' : `${Math.round(zoom.scale * 100)}%`;
  el.zoomCanvas.classList.toggle('grabbable', zoom.scale > fitScale() + 0.001);
}

function setZoom(scale, originX, originY) {
  const next = Math.min(zoom.maxScale, Math.max(zoom.minScale, scale));
  if (originX !== undefined) {
    // Keep whatever is under the cursor under the cursor.
    const c = el.zoomCanvas.getBoundingClientRect();
    const cx = originX - (c.left + c.width / 2);
    const cy = originY - (c.top + c.height / 2);
    const ratio = next / zoom.scale;
    zoom.x = cx - (cx - zoom.x) * ratio;
    zoom.y = cy - (cy - zoom.y) * ratio;
  }
  zoom.scale = next;
  zoom.fit = Math.abs(next - fitScale()) < 0.001;
  applyZoom();
}

function resetZoomToFit() {
  zoom.scale = fitScale();
  zoom.x = 0;
  zoom.y = 0;
  zoom.fit = true;
  applyZoom();
}

function openZoomView(record) {
  const r = record || state.current;
  if (!r) return;
  el.zoomName.textContent = r.meta?.prompt
    ? r.meta.prompt.slice(0, 90) + (r.meta.prompt.length > 90 ? '…' : '')
    : r.filename;
  el.zoomView.hidden = false;
  el.zoomHint.classList.remove('faded');
  clearTimeout(openZoomView.hintTimer);
  openZoomView.hintTimer = setTimeout(() => el.zoomHint.classList.add('faded'), 2600);

  const show = () => resetZoomToFit();
  if (el.zoomImg.dataset.id === r.id && el.zoomImg.complete) {
    show();
  } else {
    el.zoomImg.dataset.id = r.id;
    el.zoomImg.src = `/api/images/${r.id}/file`;
    if (el.zoomImg.complete) show();
    else el.zoomImg.addEventListener('load', show, { once: true });
  }
}

function closeZoomView() {
  el.zoomView.hidden = true;
}

el.expandBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openZoomView(state.current);
});
el.zoomBack.addEventListener('click', closeZoomView);
el.zoomIn.addEventListener('click', () => setZoom(zoom.scale * 1.25));
el.zoomOut.addEventListener('click', () => setZoom(zoom.scale / 1.25));
el.zoomLevel.addEventListener('click', () => {
  if (zoom.fit) setZoom(1);
  else resetZoomToFit();
});

el.zoomCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
  setZoom(zoom.scale * factor, e.clientX, e.clientY);
}, { passive: false });

el.zoomCanvas.addEventListener('dblclick', (e) => {
  if (zoom.fit) setZoom(1, e.clientX, e.clientY);
  else resetZoomToFit();
});

el.zoomCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  zoom.dragging = true;
  zoom.startX = e.clientX - zoom.x;
  zoom.startY = e.clientY - zoom.y;
  el.zoomCanvas.setPointerCapture(e.pointerId);
  el.zoomCanvas.classList.add('grabbing');
});
el.zoomCanvas.addEventListener('pointermove', (e) => {
  if (!zoom.dragging) return;
  zoom.x = e.clientX - zoom.startX;
  zoom.y = e.clientY - zoom.startY;
  zoom.fit = false;
  applyZoom();
});
const endDrag = () => {
  zoom.dragging = false;
  el.zoomCanvas.classList.remove('grabbing');
};
el.zoomCanvas.addEventListener('pointerup', endDrag);
el.zoomCanvas.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => { if (!el.zoomView.hidden && zoom.fit) resetZoomToFit(); });

// ---------------------------------------------------------------- lightbox

const DETAILS_W = 460;   // the fixed metadata column, matches --details-w
const VIEWER_PAD = 40;   // .viewer padding, both sides

/**
 * Size the large view to the picture.
 *
 * The image is never cropped or upscaled; this only trims the window round
 * it, so a tall image doesn't sit marooned in a wide black box and a wide
 * one doesn't get a letterbox it didn't need.
 */
function fitViewer() {
  const panel = el.lightbox.querySelector('.lightbox-panel');
  if (!panel || el.lightbox.hidden) return;

  panel.style.width = '';
  // Below this the panel stacks vertically and the width is the window's.
  if (window.innerWidth <= 1000) return;

  const nw = el.viewerImg.naturalWidth;
  const nh = el.viewerImg.naturalHeight;
  if (!nw || !nh) return;

  const maxPanelW = Math.min(1240, window.innerWidth - 56);
  const availH = panel.getBoundingClientRect().height - VIEWER_PAD;
  if (availH <= 0) return;

  // Width the image wants at full height, clamped so the details column
  // always fits and the viewer never collapses to a sliver.
  const wanted = (nw / nh) * availH;
  const viewerW = Math.min(Math.max(wanted, 320), maxPanelW - DETAILS_W - VIEWER_PAD);
  panel.style.width = `${Math.round(viewerW + VIEWER_PAD + DETAILS_W)}px`;
}

function openViewer(record) {
  state.current = record;
  el.viewerImg.src = `/api/images/${record.id}/file`;
  el.viewerImg.alt = record.meta?.prompt || '';
  el.lightbox.hidden = false;
  renderDetails();
  // Natural dimensions are known from the PNG header, so the window can be
  // sized before the pixels arrive - no visible resize once it decodes.
  const m = record.meta || {};
  if (m.width > 0 && m.height > 0) {
    const panel = el.lightbox.querySelector('.lightbox-panel');
    const maxPanelW = Math.min(1240, window.innerWidth - 56);
    const availH = panel.getBoundingClientRect().height - VIEWER_PAD;
    if (window.innerWidth > 1000 && availH > 0) {
      const viewerW = Math.min(
        Math.max((m.width / m.height) * availH, 320),
        maxPanelW - DETAILS_W - VIEWER_PAD
      );
      panel.style.width = `${Math.round(viewerW + VIEWER_PAD + DETAILS_W)}px`;
    }
  }
  if (el.viewerImg.complete) fitViewer();
}

el.viewerImg.addEventListener('load', fitViewer);
window.addEventListener('resize', () => { if (!el.lightbox.hidden) fitViewer(); });

function closeViewer() {
  closeZoomView();
  el.lightbox.hidden = true;
  el.viewerImg.src = '';
  const panel = el.lightbox.querySelector('.lightbox-panel');
  if (panel) panel.style.width = '';
  state.current = null;
}

function renderDetails() {
  const r = state.current;
  if (!r) return;
  el.favBtn.textContent = r.favorite ? '★ Favorited' : '☆ Favorite';
  el.favBtn.classList.toggle('active', !!r.favorite);
  el.pinBtn.textContent = r.pinned ? '📌 Pinned' : 'Pin';
  el.pinBtn.classList.toggle('active', !!r.pinned);
  renderMetaInto(el.detailsBody, r, { showReuse: true });
}

/**
 * Apply changed fields to every copy of a record the UI is holding.
 *
 * The same image can be referenced from three places at once: the list
 * behind the grid, the image open in the large view, and the one shown in
 * the details panel. A background refresh replaces the list with freshly
 * parsed objects, so after one has happened those references are no longer
 * the same object - patching only the list left the open image showing its
 * old state until it was closed and reopened.
 */
function patchRecord(id, patch) {
  const targets = [
    state.items.find((r) => r && r.id === id),
    state.current && state.current.id === id ? state.current : null,
    state.selected && state.selected.id === id ? state.selected : null,
  ];
  const seen = new Set();
  for (const rec of targets) {
    if (!rec || seen.has(rec)) continue;
    seen.add(rec);
    Object.assign(rec, patch);
  }
}

/**
 * Set or clear a manual NSFW mark. Passing null hands the image back to
 * the classifier, which is what "reset" in the menu does.
 */
async function setNSFW(ids, value) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return;

  // Show the change immediately rather than after the round trip. The
  // server is on this machine so the wait is short, but "short" is still
  // long enough to feel like the switch ignored the click - and the old
  // value being re-rendered in the meantime is what made it look stuck.
  // If the write fails the previous state is put back.
  const before = list.map((id) => {
    const r = state.items.find((x) => x && x.id === id)
      || (state.current && state.current.id === id ? state.current : null);
    return { id, nsfwManual: r ? r.nsfwManual : undefined };
  });
  list.forEach((id) => patchRecord(id, { nsfwManual: value }));
  if (value) list.forEach((id) => state.revealed.delete(id));
  render();
  if (state.current && list.includes(state.current.id)) renderDetails();

  try {
    if (list.length === 1) {
      const body = value === null ? { nsfwClear: true } : { nsfw: value };
      const res = await fetch(`/api/images/${list[0]}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      patchRecord(list[0], {
        nsfwManual: updated.nsfwManual,
        nsfwAuto: updated.nsfwAuto,
      });
    } else {
      await bulkRequest({ action: 'update', ids: list, nsfw: value });
      list.forEach((id) => patchRecord(id, { nsfwManual: value }));
    }
  } catch (e) {
    // Put back exactly what was there, so the switch never shows a state
    // the library does not actually have.
    before.forEach(({ id, nsfwManual }) => patchRecord(id, { nsfwManual }));
    render();
    if (state.current && list.includes(state.current.id)) renderDetails();
    return toast('Could not change that');
  }

  render();
  if (state.current && list.includes(state.current.id)) renderDetails();
  toast(value === null
    ? 'Back to automatic'
    : (value ? 'Marked as NSFW' : 'No longer marked as NSFW'));
}

async function setFlag(record, fieldName, value) {
  const r = record;
  if (!r) return;
  const res = await fetch(`/api/images/${r.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [fieldName]: value }),
  });
  if (!res.ok) return toast('Could not save that change');
  const updated = await res.json();
  r[fieldName] = updated[fieldName];

  const idx = state.items.findIndex((x) => x.id === r.id);
  if (idx !== -1) state.items[idx] = r;

  if (state.current && state.current.id === r.id) renderDetails();
  refreshCounts();

  const node = el.content.querySelector(`.card[data-id="${r.id}"]`);
  if (node) {
    const fresh = card(r);
    // Keep the geometry the layout engine already computed, so swapping a
    // single card never shifts the rest of the gallery.
    fresh.setAttribute('style', node.getAttribute('style') || '');
    fresh.classList.toggle('selected', state.selection.has(r.id));
    node.replaceWith(fresh);
  }

  toast(fieldName === 'favorite'
    ? (r.favorite ? 'Added to favorites' : 'Removed from favorites')
    : (r.pinned ? 'Pinned' : 'Unpinned'));
}

function toggle(fieldName) {
  const r = state.current || state.selected;
  if (!r) return;
  return setFlag(r, fieldName, !r[fieldName]);
}

// ---------------------------------------------------------------- manual import

/**
 * Import PNGs the user picks or drags in. Goes through exactly the same
 * ingest path as the extension, so embedded prompt metadata is read the
 * same way; non-PNG or metadata-less files are reported rather than
 * silently dropped.
 */
async function importFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.png$/i.test(f.name) || f.type === 'image/png');
  if (files.length === 0) {
    toast('Only PNG files can be imported');
    return;
  }

  let added = 0;
  let duplicate = 0;
  let failed = 0;

  toast(`Importing ${files.length} file${files.length === 1 ? '' : 's'}…`);

  for (const file of files) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('source', JSON.stringify({ url: 'manual-import', capturedBy: 'manual-import' }));
    try {
      const res = await fetch('/api/images', { method: 'POST', body: form });
      if (!res.ok) { failed++; continue; }
      const body = await res.json();
      if (body.deduped) duplicate++;
      else added++;
    } catch (e) {
      failed++;
    }
  }

  const parts = [];
  if (added) parts.push(`${added} imported`);
  if (duplicate) parts.push(`${duplicate} already in the gallery`);
  if (failed) parts.push(`${failed} failed`);
  toast(parts.join(' · ') || 'Nothing imported');
  load({ reset: true });
}

el.importBtn.addEventListener('click', () => el.importInput.click());
el.importInput.addEventListener('change', () => {
  importFiles(el.importInput.files);
  el.importInput.value = ''; // let the same file be picked again later
});

// Whole-window drag and drop.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
  dragDepth++;
  el.dropzone.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.dropzone.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  el.dropzone.hidden = true;
  importFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- folders

/* ---------------------------------------------------------------- undo

   The stack lives in the app, not here, so every window and every route
   into a change shares one history. The UI only needs to ask what the next
   step would be, so it can label the menu item honestly rather than
   offering "Undo" for nothing.
*/

async function refreshUndoState() {
  try {
    state.undo = await fetch('/api/undo').then((r) => r.json());
  } catch (e) {
    state.undo = { canUndo: false, canRedo: false };
  }
}

async function doUndo(redo = false) {
  try {
    const res = await fetch(redo ? '/api/redo' : '/api/undo', { method: 'POST' });
    const body = await res.json();
    if (!body.ok) {
      toast(redo ? 'Nothing to redo' : 'Nothing to undo');
      return;
    }
    state.undo = body.state;
    state.revealed.clear();
    await Promise.all([load({ reset: true, silent: true }), loadFolders()]);
    refreshCounts();
    if (state.current && !state.items.some((r) => r.id === state.current.id)) closeViewer();
    toast(`${redo ? 'Redone' : 'Undone'}: ${body.label}`);
  } catch (e) {
    toast('Could not do that');
  }
}

/* ---------------------------------------------------------------- folders

   Folders are a tree now: each one knows its parent, so the sidebar is a
   depth-first walk with indentation. Rows are drop targets twice over -
   images can be filed into them, and folders themselves can be dragged
   onto or between them - so the drag handling checks what is being carried
   before it lights anything up.
*/

const FOLDER_DRAG = 'application/x-novelai-gallery-folder';

function folderIcon(open, hasKids) {
  if (!hasKids) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
  }
  return `<svg class="folder-twisty${open ? ' open' : ''}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 6l6 6-6 6"></path></svg>`;
}

function isFolderOpen(id) {
  return !state.folderClosed.has(id);
}

/** Folders hidden because an ancestor is collapsed. */
function hiddenByCollapse(node, byId) {
  let cur = node.parentId;
  while (cur) {
    if (!isFolderOpen(cur)) return true;
    cur = byId.get(cur)?.parentId || '';
  }
  return false;
}

async function loadFolders() {
  try {
    const folders = await fetch('/api/folders').then((r) => r.json());
    state.folders = folders;
    renderFolders();
  } catch (e) { /* non-critical */ }
}

function renderFolders() {
  const folders = state.folders || [];
  el.folderList.innerHTML = '';

  if (folders.length === 0) {
    el.folderList.innerHTML =
      '<div class="empty-note">No folders yet. Make one, then drag images onto it.</div>';
    return;
  }

  const byId = new Map(folders.map((f) => [f.id, f]));
  const hasKids = new Set(folders.map((f) => f.parentId).filter(Boolean));

  folders.forEach((f) => {
    if (hiddenByCollapse(f, byId)) return;

    const row = document.createElement('div');
    row.className = `nav-item folder-row${state.folderId === f.id ? ' active' : ''}`;
    row.dataset.folderId = f.id;
    row.draggable = true;
    row.style.paddingLeft = `${10 + f.depth * 14}px`;

    const kids = hasKids.has(f.id);
    row.innerHTML = `
      <span class="nav-icon folder-icon${kids ? ' twisty' : ''}">${folderIcon(isFolderOpen(f.id), kids)}</span>
      <span class="nav-label">${esc(f.name)}</span>
      ${(f.tags || []).length ? '<span class="tag-mark" title="' + esc((f.tags || []).join(', ')) + '">#</span>' : ''}
      <span class="nav-count">${f.count || ''}</span>`;

    row.addEventListener('click', (e) => {
      // The twisty expands; anything else opens the folder.
      if (kids && e.target.closest('.folder-icon')) {
        if (isFolderOpen(f.id)) state.folderClosed.add(f.id);
        else state.folderClosed.delete(f.id);
        renderFolders();
        return;
      }
      selectView('folder', f.id);
    });

    // Double-click to rename, the way every file manager does it. The
    // single clicks that precede it just open the folder first, which is
    // where you'd want to be anyway.
    row.addEventListener('dblclick', (e) => {
      if (kids && e.target.closest('.folder-icon')) return; // that's the twisty
      e.preventDefault();
      renameFolder(f);
    });

    // Images dropped here get filed; folders dropped here get re-parented.
    wireImageDropTarget(row, (ids) => moveToFolder(ids, f.id, f.name));
    wireFolderDrag(row, f);
    el.folderList.appendChild(row);
  });
}

/** Dragging a folder: pick it up, and accept other folders being dropped. */
function wireFolderDrag(row, folder) {
  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    try {
      e.dataTransfer.setData(FOLDER_DRAG, folder.id);
      e.dataTransfer.setData('text/plain', folder.name);
    } catch (err) { /* nothing to carry */ }
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    el.app.classList.add('dragging-folder');
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    el.app.classList.remove('dragging-folder');
    document.querySelectorAll('.drop-into, .drop-above, .drop-below')
      .forEach((n) => n.classList.remove('drop-into', 'drop-above', 'drop-below'));
  });

  // Where in the row the pointer is decides what the drop means: the top
  // and bottom edges reorder, the middle nests. Same convention as every
  // file tree, and it avoids needing separate hairline drop zones.
  const zoneOf = (e) => {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (y < 0.28) return 'above';
    if (y > 0.72) return 'below';
    return 'into';
  };

  row.addEventListener('dragover', (e) => {
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes(FOLDER_DRAG)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    row.classList.remove('drop-into', 'drop-above', 'drop-below');
    row.classList.add(`drop-${zoneOf(e)}`);
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-into', 'drop-above', 'drop-below');
  });

  row.addEventListener('drop', async (e) => {
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes(FOLDER_DRAG)) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = zoneOf(e);
    row.classList.remove('drop-into', 'drop-above', 'drop-below');

    const dragged = e.dataTransfer.getData(FOLDER_DRAG);
    if (!dragged || dragged === folder.id) return;

    let parentId = folder.id;
    let index = 0;
    if (zone !== 'into') {
      parentId = folder.parentId || '';
      const siblings = state.folders.filter((f) => (f.parentId || '') === parentId);
      index = siblings.findIndex((f) => f.id === folder.id);
      if (zone === 'below') index += 1;
    }
    await moveFolder(dragged, parentId, index);
  });
}

async function moveFolder(id, parentId, index) {
  try {
    const res = await fetch(`/api/folders/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId, index }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not move that');
    state.folders = await res.json();
    renderFolders();
    refreshUndoState();
  } catch (e) {
    toast(e.message);
  }
}

/**
 * Ask for a name and make the folder. `parent` empty means top level.
 *
 * The dialog stays open if the server refuses the name - a duplicate among
 * siblings is the usual reason - so the message lands next to the box that
 * needs changing instead of in a toast after the typing is gone.
 *
 * Returns the new folder, or null if it was cancelled.
 */
async function createFolder(parent = '', parentName = '') {
  let made = null;
  await askText({
    title: parent ? 'New subfolder' : 'New folder',
    sub: parent ? `Inside ${parentName}` : '',
    placeholder: 'Folder name',
    okLabel: 'Create',
    submit: async (name) => {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: parent }),
      });
      if (!res.ok) {
        return (await res.json().catch(() => ({}))).error || 'Could not create that folder';
      }
      made = await res.json();
      return null;
    },
  });
  if (!made) return null;

  // A new subfolder is no use hidden inside a collapsed parent.
  if (parent) state.folderClosed.delete(parent);
  await loadFolders();
  refreshUndoState();
  toast(parent ? 'Subfolder created' : 'Folder created');
  return made;
}

async function renameFolder(folder) {
  await askText({
    title: 'Rename folder',
    value: folder.name,
    placeholder: 'Folder name',
    okLabel: 'Rename',
    submit: async (name) => {
      if (name === folder.name) return null;
      const res = await fetch(`/api/folders/${folder.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return (await res.json().catch(() => ({}))).error || 'Could not rename that';
      state.folders = await res.json();
      return null;
    },
  });
  renderFolders();
  refreshUndoState();
  load({ reset: true, silent: true });
}

async function editFolderTags(folder) {
  await askText({
    title: 'Folder tags',
    sub: 'Separate with commas. Tags are searchable, and so are the images inside.',
    value: (folder.tags || []).join(', '),
    placeholder: 'commissions, wip, reference',
    // Save, not Create: an empty box is a real answer here - it clears the
    // tags - so it must not be treated as "you haven't typed anything yet".
    okLabel: 'Save',
    submit: async (text) => {
      const tags = text.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await fetch(`/api/folders/${folder.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) return 'Could not save those tags';
      state.folders = await res.json();
      toast(tags.length ? `Tagged: ${tags.join(', ')}` : 'Tags cleared');
      return null;
    },
  });
  renderFolders();
  refreshUndoState();
}

// --- colour labels and the view menu -----------------------------------

async function loadColorLabels() {
  try {
    const body = await fetch('/api/colors').then((r) => r.json());
    state.colorNames = body.names || {};
    state.colorCounts = body.counts || {};
  } catch (e) {
    state.colorNames = {};
    state.colorCounts = {};
  }
}

/**
 * Sort order and colour filter in one popover.
 *
 * They belong together: both answer "which of my images am I looking at,
 * and in what order". A bare <select> couldn't show colour swatches, and a
 * second control in the toolbar for eight small squares would be noise.
 */
function renderViewMenu() {
  const sortLabel = (SORTS.find(([id]) => id === state.settings.sort) || SORTS[0])[1];
  el.viewMenuLabel.textContent = sortLabel;
  el.viewMenuDot.hidden = !state.color;
  el.viewMenuClear.hidden = !state.color;
  if (state.color) el.viewMenuDot.style.background = state.color;
  el.viewMenuBtn.classList.toggle('filtering', !!state.color);

  const used = LABEL_COLORS.filter(([hex]) => (state.colorCounts[hex.toLowerCase()] || 0) > 0);

  el.viewMenu.innerHTML = `
    <div class="viewmenu-title">Sort by</div>
    ${SORTS.map(([id, label]) => `
      <button class="viewmenu-item${state.settings.sort === id ? ' active' : ''}" data-sort="${id}">
        <span class="viewmenu-check">${state.settings.sort === id ? '✓' : ''}</span>
        <span>${esc(label)}</span>
      </button>`).join('')}

    <div class="viewmenu-sep"></div>
    <div class="viewmenu-title">Colour label</div>
    ${used.length === 0 ? `
      <div class="viewmenu-empty">
        No colour labels yet. Right-click an image to give it one.
      </div>` : `
      <!-- "No filter" is a labelled row, not a swatch. As a swatch it just
           read as a grey colour label sitting among the real ones. -->
      <button class="viewmenu-item${!state.color ? ' active' : ''}" data-color="">
        <span class="viewmenu-check">${!state.color ? '✓' : ''}</span>
        <span>Any colour</span>
      </button>
      <div class="viewmenu-colors">
        ${used.map(([hex]) => `
          <button class="viewmenu-color${state.color === hex ? ' active' : ''}"
            data-color="${hex}" style="background:${hex}"
            title="${esc(colorLabelName(hex))} — ${state.colorCounts[hex.toLowerCase()]} image${
              state.colorCounts[hex.toLowerCase()] === 1 ? '' : 's'}"></button>`).join('')}
      </div>`}`;

  el.viewMenu.querySelectorAll('[data-sort]').forEach((b) => {
    b.addEventListener('click', () => {
      saveSettings({ sort: b.dataset.sort });
      closeViewMenu();
      renderViewMenu();
      load({ reset: true });
    });
  });
  el.viewMenu.querySelectorAll('[data-color]').forEach((b) => {
    b.addEventListener('click', () => {
      state.color = b.dataset.color || null;
      renderViewMenu();
      load({ reset: true });
    });
  });
}

function closeViewMenu() {
  el.viewMenu.hidden = true;
  el.viewMenuBtn.setAttribute('aria-expanded', 'false');
}

el.viewMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!el.viewMenu.hidden) return closeViewMenu();
  renderViewMenu();
  el.viewMenu.hidden = false;
  el.viewMenuBtn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => {
  if (!el.viewMenu.hidden && !e.target.closest('.viewmenu-wrap')) closeViewMenu();
});

/** Set or clear the colour label on one or many images. */
async function setColorLabel(ids, color) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return;
  try {
    if (list.length === 1) {
      const res = await fetch(`/api/images/${list[0]}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      patchRecord(list[0], { color: updated.color || '' });
    } else {
      await bulkRequest({ action: 'update', ids: list, color });
      list.forEach((id) => patchRecord(id, { color }));
    }
  } catch (e) {
    return toast('Could not set that colour');
  }
  await loadColorLabels();
  render();
  renderViewMenu();
  refreshUndoState();
  if (state.current && list.includes(state.current.id)) renderDetails();
  toast(color ? `Labelled ${colorLabelName(color).toLowerCase()}` : 'Colour label removed');
}

el.addFolderBtn.addEventListener('click', () => createFolder());

// Favorites and Pinned accept drops too, so dragging is one gesture for
// filing, favouriting and pinning alike.
document.querySelectorAll('.nav-item[data-view="favorites"]').forEach((n) =>
  wireImageDropTarget(n, async (ids) => {
    try { await bulkRequest({ action: 'update', ids, favorite: true }); } catch (e) { return toast('Could not favorite those'); }
    toast(`${ids.length} image${ids.length === 1 ? '' : 's'} favorited`);
    load({ reset: true, silent: true });
  }));
document.querySelectorAll('.nav-item[data-view="pinned"]').forEach((n) =>
  wireImageDropTarget(n, async (ids) => {
    try { await bulkRequest({ action: 'update', ids, pinned: true }); } catch (e) { return toast('Could not pin those'); }
    toast(`${ids.length} image${ids.length === 1 ? '' : 's'} pinned`);
    load({ reset: true, silent: true });
  }));

// ---------------------------------------------------------------- nav

function selectView(view, folderId = null) {
  state.view = view;
  state.folderId = folderId;
  document.querySelectorAll('.sidebar .nav-item').forEach((n) => n.classList.remove('active'));
  if (view !== 'folder') {
    const node = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (node) node.classList.add('active');
  }
  loadFolders();
  load({ reset: true });
}

document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => selectView(btn.dataset.view));
});

// ---------------------------------------------------------------- events

let searchTimer;
el.search.addEventListener('input', () => {
  el.searchClear.classList.toggle('visible', el.search.value.length > 0);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value.trim();
    load({ reset: true });
  }, 220);
});

el.searchClear.addEventListener('click', () => {
  el.search.value = '';
  el.searchClear.classList.remove('visible');
  state.query = '';
  load({ reset: true });
  el.search.focus();
});

el.zoom.addEventListener('input', () => {
  saveSettings({ cardSize: Number(el.zoom.value) });
  applyLayout();
});

el.layoutSwitch.querySelectorAll('.layout-btn').forEach((b) => {
  b.addEventListener('click', () => {
    saveSettings({ layout: b.dataset.layout });
    // Inline geometry from the previous layout has to go before the next
    // one measures anything.
    el.content.querySelectorAll('.card').forEach((c) => c.removeAttribute('style'));
    applyLayout();
    toast(`${b.title} layout`);
  });
});

// --- multi-select ---------------------------------------------------------

el.selectBtn.addEventListener('click', () => setSelectMode(!state.selectMode));
el.bulkClose.addEventListener('click', () => setSelectMode(false));

el.bulkSelectAll.addEventListener('click', () => {
  if (state.selection.size >= state.items.length) state.selection.clear();
  else state.items.forEach((r) => state.selection.add(r.id));
  updateSelectionUI();
});

el.bulkPin.addEventListener('click', () => bulkFlag('pinned', true));
el.bulkFav.addEventListener('click', () => bulkFlag('favorite', true));
el.bulkDelete.addEventListener('click', () => deleteImages(selectedIds()));

el.bulkFolderBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!el.bulkFolderMenu.hidden) { el.bulkFolderMenu.hidden = true; return; }

  const rows = state.folders.map((f) =>
    `<button class="bulk-menu-item" data-folder="${esc(f.id)}">${esc(f.name)}</button>`).join('');
  el.bulkFolderMenu.innerHTML = `
    ${rows || '<div class="bulk-menu-empty">No folders yet</div>'}
    <button class="bulk-menu-item new">+ New folder…</button>`;
  el.bulkFolderMenu.hidden = false;

  el.bulkFolderMenu.querySelectorAll('[data-folder]').forEach((b) => {
    b.addEventListener('click', () => {
      el.bulkFolderMenu.hidden = true;
      const f = state.folders.find((x) => x.id === b.dataset.folder);
      moveToFolder(selectedIds(), f.id, f.name);
    });
  });
  const newBtn = el.bulkFolderMenu.querySelector('.new');
  if (newBtn) {
    newBtn.addEventListener('click', async () => {
      el.bulkFolderMenu.hidden = true;
      const folder = await createFolder();
      if (folder) moveToFolder(selectedIds(), folder.id, folder.name);
    });
  }
});
document.addEventListener('click', () => { el.bulkFolderMenu.hidden = true; });

el.clearGalleryBtn.addEventListener('click', clearGallery);
el.deleteBtn.addEventListener('click', () => {
  if (state.current) deleteImages([state.current.id]);
});

el.refreshBtn.addEventListener('click', () => { load({ reset: true }); loadFolders(); });
el.inspectorToggle.addEventListener('click', () => toggleInspector());
el.inspectorClose.addEventListener('click', () => toggleInspector(false));

/* Opening settings, optionally on a particular tab, so a button elsewhere
   can land someone exactly where the thing they need is rather than on
   whichever tab happened to be open last. */
async function openSettingsAt(tab) {
  renderSettings();
  refreshExtStatus();
  el.settingsModal.hidden = false;
  if (tab) {
    document.querySelector(`.settings-tab[data-tab="${tab}"]`)?.click();
  }
  try {
    const { total } = await fetch('/api/images?limit=1').then((r) => r.json());
    el.clearCount.textContent = `this gallery (${total} image${total === 1 ? '' : 's'})`;
  } catch (e) {
    el.clearCount.textContent = 'this gallery';
  }
}

el.toolsSettingsBtn?.addEventListener('click', () => openSettingsAt());
el.setupExtBtn?.addEventListener('click', () => { el.settingsModal.hidden = true; openExtensionSetup(); });
el.onboardNext.addEventListener('click', onboardNext);
el.onboardBack.addEventListener('click', onboardBack);
el.onboardSkip.addEventListener('click', finishOnboarding);
el.extClose.addEventListener('click', () => { el.extModal.hidden = true; load({ reset: true }); });
el.extModal.addEventListener('click', (e) => { if (e.target === el.extModal) { el.extModal.hidden = true; load({ reset: true }); } });
el.settingsClose.addEventListener('click', () => { el.settingsModal.hidden = true; load({ reset: true }); });
el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) el.settingsModal.hidden = true; });

el.favBtn.addEventListener('click', () => toggle('favorite'));
el.pinBtn.addEventListener('click', () => toggle('pinned'));
el.closeBtn.addEventListener('click', closeViewer);
el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox) closeViewer(); });

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if (!el.zoomView.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); return closeZoomView(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); return setZoom(zoom.scale * 1.25); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); return setZoom(zoom.scale / 1.25); }
    if (e.key === '0') { e.preventDefault(); return resetZoomToFit(); }
    if (e.key === '1') { e.preventDefault(); return setZoom(1); }
    return;
  }

  if ((e.key === 'f' || e.key === 'F') && !typing && !el.lightbox.hidden) {
    e.preventDefault();
    return openZoomView(state.current);
  }

  if (e.key === 'Escape') {
    if (!el.confirmModal.hidden) return;
    // These run their own key handling while open and have already dealt
    // with the key; falling through would close the window behind them too.
    if (!el.askModal.hidden) return;
    // Popovers first: Escape should dismiss the smallest thing that is
    // open, not jump past it to close the window behind it.
    if (!el.viewMenu.hidden) return closeViewMenu();
    if (!el.bulkFolderMenu.hidden) return (el.bulkFolderMenu.hidden = true);
    if (!el.welcomeModal.hidden) return (el.welcomeModal.hidden = true);
    if (!el.updateToast.hidden) return hideUpdateToast();
    if (!el.extModal.hidden) return (el.extModal.hidden = true);
    if (!el.onboardModal.hidden) return finishOnboarding();
    if (!el.settingsModal.hidden) return (el.settingsModal.hidden = true);
    if (!el.lightbox.hidden) return closeViewer();
    if (state.selectMode) return setSelectMode(false);
  }
  if (e.key === 'Enter' && !el.onboardModal.hidden && !typing) {
    e.preventDefault();
    return onboardNext();
  }
  if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    return doUndo(e.shiftKey);
  }
  if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    return doUndo(true);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault(); el.search.focus(); el.search.select();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !typing && el.lightbox.hidden) {
    e.preventDefault();
    setSelectMode(true);
    state.items.forEach((r) => state.selection.add(r.id));
    updateSelectionUI();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && el.confirmModal.hidden) {
    if (state.selection.size) { e.preventDefault(); deleteImages(selectedIds()); return; }
    if (state.current) { e.preventDefault(); deleteImages([state.current.id]); return; }
  }
  if (el.lightbox.hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const i = state.items.findIndex((x) => x.id === state.current?.id);
    if (i === -1) return;
    const next = e.key === 'ArrowRight' ? i + 1 : i - 1;
    if (next >= 0 && next < state.items.length) {
      selectRecord(state.items[next]);
      openViewer(state.items[next]);
    }
  }
});

// Pick up newly captured images without the user hitting refresh.
// Pick up newly captured images without the user hitting refresh.
//
// This deliberately keeps running while the Settings / setup / extension
// modals are open: those are exactly the windows you have open while
// setting the extension up, and suppressing refresh there meant captures
// could land while the grid sat stale behind the dialog. Only the lightbox
// pauses it, since re-rendering underneath the image you're looking at is
// pointless churn.
setInterval(() => {
  if (!el.lightbox.hidden || state.loading) return;
  if (state.offset > state.limit) return;          // user paged past the first screen
  if (state.selectMode || state.selection.size) return; // don't shuffle a live selection
  if (!el.confirmModal.hidden) return;
  load({ reset: true, silent: true });
}, 5000);

// Exposed on purpose: it makes the gallery inspectable from the WebView's
// devtools console when a layout or selection problem needs diagnosing.
window.gallery = { state, load, render, applyLayout, updateSelectionUI, setSelectMode };

// Dropping a folder here pulls it out to the top level - the one move
// that has no row to aim at.
wireFolderRootDrop();
function wireFolderRootDrop() {
  const zone = el.folderRootDrop;
  zone.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes(FOLDER_DRAG)) return;
    e.preventDefault();
    zone.classList.add('active');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('active'));
  zone.addEventListener('drop', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes(FOLDER_DRAG)) return;
    e.preventDefault();
    zone.classList.remove('active');
    const id = e.dataTransfer.getData(FOLDER_DRAG);
    if (id) moveFolder(id, '', -1);
  });
}

/* The sidebar is draggable-wide. The width is a CSS variable so the grid
   and the JS-measured layouts both follow it without special cases. */
(function wireSidebarResize() {
  let startX = 0;
  let startW = 0;
  let width = 0;
  let dragging = false;

  const apply = (w) => {
    width = Math.round(Math.max(170, Math.min(460, w)));
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
    return width;
  };

  el.sidebarResizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = el.app.querySelector('.sidebar').getBoundingClientRect().width;
    width = Math.round(startW);
    try {
      el.sidebarResizer.setPointerCapture(e.pointerId);
    } catch (err) { /* synthetic pointers have nothing to capture */ }
    el.sidebarResizer.classList.add('dragging');
    // The grid animates its columns, which is right when the panel is
    // toggled and wrong while dragging - the sidebar would trail the
    // pointer, and the width read on release would be a frame of the
    // animation rather than where the pointer actually is.
    el.app.classList.add('resizing');
    e.preventDefault();
  });

  el.sidebarResizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(startW + (e.clientX - startX));
    scheduleLayout();
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    el.sidebarResizer.classList.remove('dragging');
    el.app.classList.remove('resizing');
    // Save what was asked for, not what the layout has caught up to.
    saveSettings({ sidebarWidth: width });
    applyLayout();
  };
  el.sidebarResizer.addEventListener('pointerup', stop);
  el.sidebarResizer.addEventListener('pointercancel', stop);

  // Double-click resets it.
  el.sidebarResizer.addEventListener('dblclick', () => {
    apply(232);
    width = 232;
    saveSettings({ sidebarWidth: 232 });
    applyLayout();
  });
})();

/* ------------------------------------------------------------------ updates

   The app checks GitHub's releases page for this project - there is no
   server of ours in the picture - and, on the first open of the day, says
   so in the corner rather than in the middle of the screen. Agreeing
   downloads the same installer people get by hand and runs it silently;
   the installer closes the app, replaces it, and starts it again. What's
   new is then shown once, from the release notes of the build that landed.

   Nothing about this is required: it can be ignored, dismissed, or left
   turned off, and the app works exactly the same either way. */

const UPDATE_POLL_MS = 600;
let updatePollTimer = null;
let updateOverlayOpen = false;
let latestRelease = null;

async function updateState() {
  try {
    return await fetch('/api/update/state').then((r) => r.json());
  } catch (e) {
    return null;
  }
}

function bytesLabel(n) {
  if (!n || n < 0) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* Release notes are markdown on GitHub. This renders the small part of it
   that changelogs actually use - headings, bullets, bold, code, links -
   after escaping, so a release body can never inject markup. */
function renderNotes(md) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const out = [];
  let list = null;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (bullet) {
      if (!list) { list = []; }
      list.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (heading) {
      out.push(`<h4>${inline(heading[2])}</h4>`);
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('') || '<p class="muted">No notes were published with this release.</p>';
}

// --- the corner prompt --------------------------------------------------

function showUpdateToast(rel) {
  latestRelease = rel;
  el.updateToastTitle.textContent = `Build ${rel.version} is available`;
  el.updateToastBody.innerHTML = `
    <div class="update-toast-note">You're on Build ${esc(state.appVersion || '')}.</div>
    ${rel.assetSize ? `<div class="update-toast-size">${bytesLabel(rel.assetSize)} download</div>` : ''}`;
  el.updateToast.hidden = false;
  // Animate in on the next frame so the transition has a start state.
  requestAnimationFrame(() => el.updateToast.classList.add('in'));
}

function hideUpdateToast() {
  el.updateToast.classList.remove('in');
  setTimeout(() => { el.updateToast.hidden = true; }, 200);
}

// --- the installing overlay --------------------------------------------

function openUpdateOverlay() {
  updateOverlayOpen = true;
  el.updateModal.hidden = false;
}

function closeUpdateOverlay() {
  updateOverlayOpen = false;
  el.updateModal.hidden = true;
}

function paintUpdateProgress(p) {
  if (!p) return;
  const pct = Math.max(0, Math.min(100, p.percent || 0));
  el.updateBarFill.style.width = `${pct}%`;
  el.updateStage.dataset.state = p.state;

  if (p.state === 'downloading') {
    // A release published as a zip has the installer taken out of it as a
    // step of its own. A bar sitting at 100% with nothing said is how a
    // working update looks stuck.
    const unpacking = /unpack/i.test(p.message || '');
    el.updateHeadline.textContent = unpacking
      ? 'Unpacking the installer…'
      : `Downloading Build ${p.release?.version || ''}`.trim();
    el.updateSub.textContent = unpacking
      ? 'That release is a zip; the installer is being taken out of it.'
      : (p.total
        ? `${bytesLabel(p.downloaded)} of ${bytesLabel(p.total)}`
        : bytesLabel(p.downloaded));
  } else if (p.state === 'installing') {
    el.updateHeadline.textContent = 'Installing…';
    el.updateSub.textContent = 'The app will close and reopen in a moment.';
    el.updateBarFill.style.width = '100%';
    el.updateActions.hidden = true;
  } else if (p.state === 'ready') {
    el.updateHeadline.textContent = 'Ready to install';
    el.updateSub.textContent = '';
  } else if (p.state === 'error') {
    el.updateHeadline.textContent = 'That didn’t work';
    el.updateSub.textContent = p.message || '';
  }
}

/* One poll loop drives both the About tab and the overlay, so there is
   never a second timer disagreeing with the first about what is happening. */
function startUpdatePolling() {
  if (updatePollTimer) return;
  updatePollTimer = setInterval(async () => {
    const st = await updateState();
    const p = st?.progress;
    if (!p) return;

    if (el.settingsModal && !el.settingsModal.hidden) paintUpdateStatus(p);
    if (updateOverlayOpen) paintUpdateProgress(p);

    if (p.state === 'downloading' || p.state === 'checking' || p.state === 'installing') return;

    clearInterval(updatePollTimer);
    updatePollTimer = null;

    // A manual check that finds something should offer it, not just change
    // a label in a tab the user may have already closed.
    if (p.state === 'available' && p.release?.newer && p.release?.assetUrl
        && el.updateToast.hidden && !updateOverlayOpen) {
      showUpdateToast(p.release);
    }

    if (p.state === 'ready') {
      if (updateOverlayOpen) {
        installUpdate();
      } else {
        // They put the overlay away while it downloaded. Restarting the
        // app out from under them at that point would be rude, so it waits
        // to be asked again.
        toast(`Build ${p.release?.version || ''} is downloaded — open Settings ▸ About to install.`);
      }
    }
  }, UPDATE_POLL_MS);
}

async function beginUpdate() {
  hideUpdateToast();
  openUpdateOverlay();
  el.updateActions.hidden = false;
  el.updateHeadline.textContent = 'Starting download…';
  el.updateSub.textContent = '';
  el.updateBarFill.style.width = '0%';
  await fetch('/api/update/download', { method: 'POST' }).catch(() => {});
  startUpdatePolling();
}

async function installUpdate() {
  openUpdateOverlay();
  el.updateActions.hidden = true;
  el.updateHeadline.textContent = 'Installing…';
  el.updateSub.textContent = 'The app will close and reopen in a moment.';
  el.updateBarFill.style.width = '100%';
  try {
    const res = await fetch('/api/update/install', { method: 'POST' });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      el.updateHeadline.textContent = 'That didn’t work';
      el.updateSub.textContent = error || 'The installer could not be started.';
      el.updateActions.hidden = false;
    }
  } catch (e) {
    // The app exiting mid-request looks exactly like this, and that is the
    // successful case, so it is not reported as a failure.
  }
}

// --- Settings ▸ About ---------------------------------------------------

function paintUpdateStatus(p) {
  if (!el.updateStatus) return;
  const map = {
    checking: 'Checking…',
    uptodate: p.message || 'You’re on the latest build',
    available: `Build ${p.release?.version} is available`,
    downloading: /unpack/i.test(p.message || '')
      ? 'Unpacking…' : `Downloading… ${Math.round(p.percent || 0)}%`,
    ready: 'Downloaded — ready to install',
    installing: 'Installing…',
    error: p.message || 'Something went wrong',
    idle: '',
  };
  el.updateStatus.textContent = map[p.state] ?? '';
  el.updateStatus.dataset.state = p.state;

  // Two buttons rather than one that changes its mind. A button whose
  // label rewrites itself is easy to miss entirely - which is exactly what
  // happened - so checking stays checking, and installing gets its own
  // button that appears only when there is genuinely something to install.
  const busy = p.state === 'checking' || p.state === 'downloading' || p.state === 'installing';
  el.checkUpdateBtn.textContent = 'Check for updates';
  el.checkUpdateBtn.disabled = busy;
  if (el.installLatestBtn) el.installLatestBtn.disabled = busy;

  const canInstall = (p.state === 'available' && p.release?.newer && p.release?.assetUrl)
    || p.state === 'ready';
  el.installUpdateBtn.hidden = !canInstall;
  el.installUpdateBtn.disabled = busy;
  if (canInstall) {
    el.installUpdateBtn.textContent = p.state === 'ready'
      ? 'Install now'
      : `Install Build ${p.release.version}`;
    el.installUpdateBtn.dataset.action = p.state === 'ready' ? 'install' : 'download';
  }
}

function renderAbout() {
  if (!el.aboutVersion) return;
  el.aboutVersion.textContent = `Build ${state.appVersion || '—'}`;

  el.autoUpdateSwitch.innerHTML = `
    <label class="switch-row">
      <input type="checkbox" class="switch-input"${state.settings.autoUpdate ? ' checked' : ''} />
      <span class="switch-track"><span class="switch-knob"></span></span>
      <span class="switch-text">
        <span class="switch-title">Install updates automatically</span>
        <span class="switch-desc">
          Once a day, check for a new build and install it without asking.
          With this off you'll still be told when one is available, and
          nothing is downloaded until you say so.
        </span>
      </span>
    </label>`;
  const auto = el.autoUpdateSwitch.querySelector('.switch-input');
  auto.addEventListener('change', () => {
    saveSettings({ autoUpdate: auto.checked });
    toast(auto.checked
      ? 'Updates will install automatically.'
      : 'You’ll be asked before any update is installed.');
  });

  updateState().then((st) => {
    if (!st) return;
    if (st.progress) paintUpdateStatus(st.progress);
    if (st.repo && el.aboutRepo) el.aboutRepo.href = st.repo + '/releases';
  });
}

el.checkUpdateBtn?.addEventListener('click', async () => {
  el.updateStatus.textContent = 'Checking…';
  el.checkUpdateBtn.disabled = true;
  await fetch('/api/update/check', { method: 'POST' }).catch(() => {});
  startUpdatePolling();
});

el.installUpdateBtn?.addEventListener('click', () => {
  el.settingsModal.hidden = true;
  if (el.installUpdateBtn.dataset.action === 'install') installUpdate();
  else beginUpdate();
});

/* "Install Latest".
 *
 * "Check for updates" only offers something when the published build is
 * newer than this one, which is right nearly always and useless in the one
 * case people actually ask about: reinstalling the current release after a
 * bad install, or picking up a release that was re-cut under the same
 * number. This takes whatever GitHub is publishing now and installs it,
 * newer or not. */
async function waitForCheck(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const st = await updateState();
    const p = st?.progress;
    if (p && p.state !== 'checking') {
      return p.state === 'error' ? { error: p.message } : { release: p.release || null };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { error: 'GitHub did not answer in time' };
}

async function installLatestBuild() {
  hideUpdateToast();
  openUpdateOverlay();
  el.updateActions.hidden = false;
  el.updateHeadline.textContent = 'Finding the latest build…';
  el.updateSub.textContent = 'Asking GitHub what the newest release is.';
  el.updateBarFill.style.width = '0%';

  await fetch('/api/update/check', { method: 'POST' }).catch(() => {});
  const { release, error } = await waitForCheck();

  if (error || !release) {
    el.updateHeadline.textContent = 'Nothing to install';
    el.updateSub.textContent = error || 'GitHub has no published release yet.';
    return;
  }
  if (!release.assetUrl) {
    el.updateHeadline.textContent = `Build ${release.version} has no installer`;
    el.updateSub.textContent =
      'That release does not include a setup .exe, so there is nothing to run.';
    return;
  }

  el.updateHeadline.textContent = `Downloading Build ${release.version}…`;
  el.updateSub.textContent = release.version === state.appVersion
    ? 'Same build you are on — reinstalling it.'
    : '';
  await fetch('/api/update/download', { method: 'POST' }).catch(() => {});
  // The poller installs it once the download reports ready, because the
  // overlay is open.
  startUpdatePolling();
}

el.installLatestBtn?.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Install the latest build',
    body: `This downloads the newest release from GitHub and installs it, even
           if it is the same build you are already on. The app will close and
           reopen. Your gallery, folders and settings are left alone.`,
    confirmLabel: 'Install latest',
  });
  if (!ok) return;
  el.settingsModal.hidden = true;
  installLatestBuild();
});

function clearColorFilter(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!state.color) return;
  state.color = null;
  renderViewMenu();
  load({ reset: true });
  toast('Colour filter cleared');
}
el.viewMenuClear?.addEventListener('click', clearColorFilter);
el.viewMenuClear?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') clearColorFilter(e);
});

el.updateToastGo?.addEventListener('click', beginUpdate);
el.updateToastLater?.addEventListener('click', hideUpdateToast);
el.updateToastClose?.addEventListener('click', hideUpdateToast);
// "Cancel" leaves the download running rather than pretending to stop it -
// there is nothing to stop it with - so it says what it really does.
el.updateCancel?.addEventListener('click', closeUpdateOverlay);

// --- what's new, after an update ---------------------------------------

async function showWelcomeIfUpdated() {
  let rel = null;
  try {
    ({ release: rel } = await fetch('/api/update/welcome').then((r) => r.json()));
  } catch (e) { return; }
  if (!rel) return;

  el.welcomeTitle.textContent = rel.name || `Build ${rel.version}`;
  el.welcomeSub.textContent = 'Updated and ready to go.';
  el.welcomeBody.innerHTML = renderNotes(rel.notes);
  if (rel.url) {
    el.welcomeLink.href = rel.url;
    el.welcomeLink.hidden = false;
  } else {
    el.welcomeLink.hidden = true;
  }
  el.welcomeModal.hidden = false;
}

el.welcomeDone?.addEventListener('click', () => { el.welcomeModal.hidden = true; });

/* The daily check. The server decides whether today's has already
   happened, so reopening the window five times does not mean five
   prompts. */
async function maybeCheckDaily() {
  // Not during first-run setup. Someone who has owned the app for ninety
  // seconds does not need to be told there is a newer one, and the prompt
  // would land on top of the setup steps.
  if (!state.settings.onboarded) return;

  let res;
  try {
    res = await fetch('/api/update/daily', { method: 'POST' }).then((r) => r.json());
  } catch (e) { return; }
  if (!res?.first) return;

  if (res.autoUpdate) {
    // The server is already downloading. Show what's happening rather than
    // closing the app out of nowhere.
    openUpdateOverlay();
    el.updateActions.hidden = false;
    el.updateHeadline.textContent = 'Checking for updates…';
    startUpdatePolling();
    return;
  }

  // Wait for the check the server kicked off, then prompt only if there is
  // genuinely something newer with an installer attached.
  for (let i = 0; i < 40; i++) {
    const st = await updateState();
    const p = st?.progress;
    if (p && p.state !== 'checking' && p.state !== 'idle') {
      if (p.state === 'available' && p.release?.newer && p.release?.assetUrl) {
        showUpdateToast(p.release);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/* ------------------------------------------------------------------ tools

   The gallery is one tool among several. Switching hides the gallery's
   whole grid rather than unmounting it, so coming back is instant and no
   scroll position, selection or open image is lost on the way. */

function selectTool(name) {
  document.querySelectorAll('.tool-tab').forEach((b) => {
    const on = b.dataset.tool === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  el.app.hidden = name !== 'gallery';
  el.toolPrompt.hidden = name !== 'prompt';
  el.toolGenerate.hidden = name !== 'generate';
  // The gallery's layouts are measured in JS, so anything that happened to
  // the window while it was hidden has to be re-measured on the way back.
  if (name === 'gallery') scheduleLayout();
  // Built on first visit, so opening the app costs nothing if you never
  // use it.
  if (name === 'prompt' && typeof pgInit === 'function') pgInit();
  if (name === 'generate' && typeof genInit === 'function') genInit();
}

el.toolTabs?.addEventListener('click', (e) => {
  const tab = e.target.closest('.tool-tab');
  if (tab) selectTool(tab.dataset.tool);
});

(async () => {
  await loadSettings();
  loadStorageInfo();
  refreshUndoState();
  await loadColorLabels();
  renderInspector();
  loadFolders();
  await load({ reset: true });
  maybeStartOnboarding();
  // Both of these are deliberately last: the gallery should be on screen
  // before anything talks about versions.
  showWelcomeIfUpdated();
  maybeCheckDaily();
})();

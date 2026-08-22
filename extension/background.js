/**
 * Background service worker (Manifest V3). Owns all actual network calls
 * to the local gallery server - per Chrome's extension model, requests
 * made from here are exempt from CORS as long as host_permissions cover
 * the target origin, which is why capture data flows content.js ->
 * background.js -> server rather than being fetched directly from the
 * content script.
 *
 * Image bytes arrive here as base64 (see content.js for why - plain
 * ArrayBuffer does not survive chrome.runtime.sendMessage reliably) and
 * are decoded back to an ArrayBuffer/Blob for the actual upload.
 */

const BASE_PORT = 8756;
const PORT_RANGE = 8;

const DEFAULTS = {
  serverUrl: '', // empty = auto-discover; user can override in Settings
  networkCaptureEnabled: true,
  domCaptureEnabled: true,
  // Master start/stop for automatic saving, toggled from the popup.
  autoEnabled: true,
};

const MAX_QUEUE = 50;

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

/**
 * Find the desktop app's local address. The app binds the first free port
 * in a small range (a fixed single port is a real failure mode - something
 * else on the machine may already own it), so we probe that same range and
 * remember whichever answers. Cached in memory and re-probed only when the
 * cached one stops responding, so the steady state is a single request.
 */
let cachedBase = null;

/**
 * The gallery app always runs on this machine, so the only addresses that
 * can ever be valid are loopback ones. Anything else is a mistake - most
 * easily a NovelAI URL pasted into the "Gallery app address" box - and
 * following it would send your captured images to a remote server. So a
 * non-loopback override is rejected outright rather than trusted.
 */
function isLoopbackUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return (
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.hostname === '[::1]' ||
      u.hostname === '::1'
    );
  } catch (e) {
    return false;
  }
}

async function probe(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    // Confirm it's actually our app answering, not just anything on the port.
    const body = await res.json().catch(() => null);
    return !!(body && body.ok === true);
  } catch (e) {
    return false;
  }
}

async function resolveBase({ force } = {}) {
  const { serverUrl } = await getSettings();
  if (serverUrl) {
    if (isLoopbackUrl(serverUrl)) {
      return serverUrl.replace(/\/$/, ''); // explicit override wins
    }
    // Drop the bad value so it stops being retried on every capture, and
    // fall through to auto-discovery.
    console.warn(
      '[novelai-gallery] Ignoring non-local gallery address:',
      serverUrl,
      '- the gallery app runs on your own PC, so only 127.0.0.1/localhost is accepted. Clearing it.'
    );
    await chrome.storage.local.set({ serverUrl: '', serverUrlRejected: serverUrl });
  }

  if (cachedBase && !force && (await probe(cachedBase))) return cachedBase;

  for (let i = 0; i < PORT_RANGE; i++) {
    const base = `http://127.0.0.1:${BASE_PORT + i}`;
    if (await probe(base)) {
      cachedBase = base;
      return base;
    }
  }
  cachedBase = null;
  throw new Error('NovelAI Gallery app is not running');
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function uploadImage({ bufferB64, capturedBy, pageUrl }) {
  const base = await resolveBase();
  const buffer = base64ToBuffer(bufferB64);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'capture.png');
  form.append('source', JSON.stringify({ url: pageUrl, capturedBy }));

  const res = await fetch(`${base}/api/images`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`App responded ${res.status}`);
  }
  return res.json();
}

async function enqueueForRetry(item) {
  const { pendingUploads = [] } = await chrome.storage.local.get('pendingUploads');
  pendingUploads.push({ ...item, queuedAt: Date.now() });
  while (pendingUploads.length > MAX_QUEUE) pendingUploads.shift();
  await chrome.storage.local.set({ pendingUploads });
  chrome.alarms.create('retry-uploads', { delayInMinutes: 0.5 });
}

async function flushQueue() {
  const { pendingUploads = [] } = await chrome.storage.local.get('pendingUploads');
  if (pendingUploads.length === 0) return;

  const stillPending = [];
  for (const item of pendingUploads) {
    try {
      await uploadImage(item);
      setBadge('ok');
    } catch (e) {
      stillPending.push(item);
    }
  }
  await chrome.storage.local.set({ pendingUploads: stillPending });
  if (stillPending.length > 0) {
    chrome.alarms.create('retry-uploads', { delayInMinutes: 0.5 });
  }
}

function setBadge(state) {
  const map = {
    ok: { text: '', color: '#2ecc71' },
    error: { text: '!', color: '#e74c3c' },
    saving: { text: '…', color: '#7c9cff' },
    paused: { text: '||', color: '#9aa0ad' },
  };
  const cfg = map[state] || map.ok;
  chrome.action.setBadgeText({ text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

/**
 * The capture mode is owned by the desktop app (set in its Settings), so
 * there is only one switch rather than the same option in two places.
 * Cached here and refreshed on the same alarm that checks health, so a
 * change in the app takes effect within about a minute.
 */
let captureMode = 'generated';

// When on, saving an image on NovelAI files it here instead of writing a
// file. Owned by the app's Settings, same as the capture mode.
let interceptDownloads = false;

async function refreshCaptureMode() {
  try {
    const base = await resolveBase();
    const s = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    let changed = false;
    if (s && typeof s.captureMode === 'string' && s.captureMode !== captureMode) {
      captureMode = s.captureMode;
      changed = true;
    }
    if (s && typeof s.interceptDownloads === 'boolean' && s.interceptDownloads !== interceptDownloads) {
      interceptDownloads = s.interceptDownloads;
      changed = true;
    }
    // The page script does the suppressing, so it needs to hear about a
    // change rather than waiting for the next navigation.
    if (changed) broadcastMode();
  } catch (e) {
    /* keep whatever we had; the app may just not be running yet */
  }
}

/** Which capture strategies are allowed to save under the current mode. */
function modeAllows(capturedBy) {
  // Explicit user actions always work: right-click save, saving from the
  // page, and the "Import NovelAI history now" button.
  if (capturedBy === 'manual' || /manual/.test(capturedBy)) return true;
  if (/^download/.test(capturedBy || '')) return true;

  if (captureMode === 'download') return false; // only the intercept above
  // 'generated' and 'all' both accept live capture; the difference is
  // whether the existing backlog gets imported, which is decided in the
  // page script by baselining rather than here.
  return true;
}

// Rolling diagnostics so a capture failure can be read off the popup
// instead of guessed at. Kept in memory + mirrored to storage, since the
// service worker can be torn down at any time.
let lastDiag = null;
let contentAliveAt = 0;
let contentPageUrl = '';
let lastUploadError = '';
let lastCaptureBy = '';

// Bytes already sent to the app this session. The app dedupes properly by
// SHA-256; this only avoids uploading the same image twice over.
const uploadedFingerprints = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'novelai-content-alive') {
    contentAliveAt = Date.now();
    contentPageUrl = message.pageUrl || '';
    chrome.storage.local.set({ contentAliveAt, contentPageUrl });
    return false;
  }

  if (message?.type === 'novelai-diag') {
    lastDiag = message.diag;
    contentAliveAt = Date.now();
    contentPageUrl = message.pageUrl || contentPageUrl;
    chrome.storage.local.set({ lastDiag, contentAliveAt, contentPageUrl });
    return false;
  }

  if (message?.type === 'novelai-scan-result') {
    chrome.storage.local.set({ lastScanFound: message.found, lastScanAt: Date.now() });
    return false;
  }

  if (message?.type === 'novelai-image-candidate') {
    (async () => {
      const settings = await getSettings();
      const manual = /manual/.test(message.capturedBy || '');

      // The start/stop switch is enforced here as well as in the page
      // script. The page copy can go stale if the broadcast doesn't reach a
      // tab (one that was never loaded with the content script, say), and a
      // stopped switch must actually mean stopped.
      if (settings.autoEnabled === false && !manual) return;

      if (!modeAllows(message.capturedBy)) return;
      if (message.capturedBy?.startsWith('network') && !settings.networkCaptureEnabled) return;
      if (message.capturedBy === 'dom-scan' && !settings.domCaptureEnabled) return;

      // Duplicate suppression belongs *after* the mode checks. Doing it in
      // the content script meant a capture the mode rejected still marked
      // those bytes as seen, so the same image arriving by a route the mode
      // does allow was dropped - which is how "only save when I download"
      // ended up saving nothing at all.
      if (message.fingerprint) {
        if (uploadedFingerprints.has(message.fingerprint)) return;
        uploadedFingerprints.add(message.fingerprint);
        if (uploadedFingerprints.size > 400) {
          uploadedFingerprints.delete(uploadedFingerprints.values().next().value);
        }
      }

      setBadge('saving');
      try {
        const result = await uploadImage({
          bufferB64: message.bufferB64,
          capturedBy: message.capturedBy,
          pageUrl: message.pageUrl,
        });
        setBadge('ok');
        lastUploadError = '';
        lastCaptureBy = message.capturedBy || '';
        const { captureCount = 0 } = await chrome.storage.local.get('captureCount');
        if (!result.deduped) {
          await chrome.storage.local.set({
            captureCount: captureCount + 1,
            lastCaptureAt: Date.now(),
            lastCaptureBy,
          });
        }
        await chrome.storage.local.set({ lastUploadError: '' });
      } catch (err) {
        console.warn('[novelai-gallery] upload failed, queuing for retry:', err.message);
        setBadge('error');
        lastUploadError = err.message;
        await chrome.storage.local.set({ lastUploadError: err.message });
        await enqueueForRetry({
          bufferB64: message.bufferB64,
          capturedBy: message.capturedBy,
          pageUrl: message.pageUrl,
        });
      }
    })();
    // No async sendResponse needed; content script doesn't wait on this.
    return false;
  }
  if (message?.type === 'get-status') {
    (async () => {
      let reachable = false;
      let base = null;
      let galleryTotal = null;
      try {
        base = await resolveBase({ force: true });
        reachable = true;
        // The app's own count is the honest number: images that dedupe
        // (already in the library) don't bump the local counter, so
        // reporting only that would read as "nothing worked".
        const r = await fetch(`${base}/api/images?limit=1`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) galleryTotal = (await r.json()).total;
      } catch (e) {
        /* leave reachable/galleryTotal as-is */
      }
      const stored = await chrome.storage.local.get([
        'captureCount', 'lastCaptureAt', 'lastCaptureBy', 'pendingUploads',
        'lastDiag', 'contentAliveAt', 'contentPageUrl', 'lastUploadError',
        'lastScanFound', 'lastScanAt', 'autoEnabled',
      ]);
      sendResponse({
        reachable,
        appUrl: base,
        galleryTotal,
        captureCount: stored.captureCount || 0,
        lastCaptureAt: stored.lastCaptureAt,
        lastCaptureBy: stored.lastCaptureBy || '',
        pendingCount: (stored.pendingUploads || []).length,
        diag: stored.lastDiag || lastDiag,
        contentAliveAt: stored.contentAliveAt || contentAliveAt,
        contentPageUrl: stored.contentPageUrl || contentPageUrl,
        uploadError: stored.lastUploadError || lastUploadError || '',
        lastScanFound: stored.lastScanFound,
        lastScanAt: stored.lastScanAt,
        captureMode,
        autoEnabled: stored.autoEnabled !== false,
        lastDownload: lastDownloadSeen,
      });
    })();
    return true; // keep the message channel open for the async sendResponse
  }

  // Ask every open NovelAI tab to sweep its stored history right now.
  if (message?.type === 'scan-all-tabs') {
    (async () => {
      let asked = 0;
      try {
        const tabs = await chrome.tabs.query({
          url: ['https://novelai.net/*', 'https://*.novelai.net/*', 'https://*.novelai.workers.dev/*'],
        });
        for (const tab of tabs) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'scan-now' });
            asked++;
          } catch (e) {
            /* content script not in this tab */
          }
        }
      } catch (e) {
        /* tabs permission or query failure */
      }
      sendResponse({ tabsAsked: asked });
    })();
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'retry-uploads') flushQueue();
  if (alarm.name === 'health-check') {
    updateBadgeFromHealth();
    refreshCaptureMode();
  }
});

// Content scripts ask for the current mode on page load so the
// download-intercept hook knows whether to suppress the file download.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'get-capture-mode') {
    (async () => {
      await refreshCaptureMode();
      const { autoEnabled } = await getSettings();
      sendResponse({ captureMode, autoEnabled, interceptDownloads });
    })();
    return true;
  }

  // Start/stop automatic saving.
  if (message?.type === 'set-auto-enabled') {
    (async () => {
      await chrome.storage.local.set({ autoEnabled: !!message.enabled });
      await broadcastMode();
      setBadge(message.enabled ? 'ok' : 'paused');
      sendResponse({ autoEnabled: !!message.enabled });
    })();
    return true;
  }
  return false;
});

async function updateBadgeFromHealth() {
  try {
    await resolveBase({ force: true });
    setBadge('ok');
  } catch (e) {
    setBadge('error');
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-to-novelai-gallery',
    title: 'Save image to NovelAI Gallery',
    contexts: ['image'],
    documentUrlPatterns: ['https://novelai.net/*', 'https://*.novelai.net/*'],
  });
  chrome.alarms.create('health-check', { periodInMinutes: 1 });
  updateBadgeFromHealth();
  refreshCaptureMode();
  flushQueue();
});

// A service worker can be torn down and restarted at any time, so re-read
// the mode on startup rather than only on install.
refreshCaptureMode();

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'save-to-novelai-gallery' || !info.srcUrl) return;
  try {
    setBadge('saving');
    const buffer = await fetch(info.srcUrl).then((r) => r.arrayBuffer());
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    await uploadImage({ bufferB64: btoa(binary), capturedBy: 'manual', pageUrl: info.pageUrl });
    setBadge('ok');
  } catch (err) {
    console.warn('[novelai-gallery] manual save failed:', err.message);
    setBadge('error');
  }
});

// =====================================================================
// "Reuse prompt in NovelAI"
// =====================================================================
//
// The gallery UI can't message the extension directly, so the app acts as
// the rendezvous: we hold a long-poll open against it, and a Reuse click
// completes that request immediately. On wake-up we fetch the PNG, find a
// NovelAI tab, and hand the bytes to the page so it can be dropped in as
// if you'd dragged the file onto the window - which is how NovelAI reads
// the prompt back out of the image's embedded metadata.

const NOVELAI_TAB_PATTERNS = [
  'https://novelai.net/*',
  'https://*.novelai.net/*',
  'https://*.novelai.workers.dev/*',
];

// =====================================================================
// Downloads: "save image as", and the site's own save button
// =====================================================================
//
// A right-click "Save image as" is a browser action, not a page one - no
// click handler, no anchor, nothing a content script can observe. The only
// place it is visible is the downloads list, so that is where it's caught.
// This covers the page's own save button as well, since that ends up in
// the same list.
//
// Scope is deliberately narrow: the download has to come from NovelAI, by
// its own URL, its referrer, or the origin baked into a blob: URL. Nothing
// else the browser downloads is touched.

const NOVELAI_HOST = /(^|\.)novelai\.net$|(^|\.)novelai\.workers\.dev$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function downloadIsFromNovelAI(item) {
  const url = item.finalUrl || item.url || '';
  if (NOVELAI_HOST.test(hostOf(item.referrer || ''))) return true;
  // blob:https://novelai.net/<uuid> carries its origin after the scheme.
  if (url.startsWith('blob:')) return NOVELAI_HOST.test(hostOf(url.slice(5)));
  return NOVELAI_HOST.test(hostOf(url));
}

function downloadLooksLikeImage(item) {
  const name = (item.filename || '').toLowerCase();
  const url = (item.finalUrl || item.url || '').toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name)) return true;
  if (/^image\//.test(item.mime || '')) return true;
  return url.startsWith('blob:') || url.startsWith('data:image');
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isPngBase64(b64) {
  // "iVBORw0KGgo" is the base64 of the 8-byte PNG signature.
  return typeof b64 === 'string' && b64.startsWith('iVBORw0KGgo');
}

/**
 * Get the bytes behind a download. A blob: URL belongs to the page that
 * made it and can't be fetched from here, so the page is asked for it.
 */
async function resolveDownloadBytes(item) {
  const url = item.finalUrl || item.url || '';

  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma === -1 || !/;base64/i.test(url.slice(0, comma))) return null;
    return url.slice(comma + 1);
  }

  if (url.startsWith('blob:')) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: NOVELAI_TAB_PATTERNS });
    } catch (e) {
      return null;
    }
    // The blob belongs to exactly one of these tabs; ask each until one
    // can read it.
    for (const tab of tabs) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'resolve-blob', url }, { frameId: 0 });
        if (resp && resp.ok && resp.bufferB64) return resp.bufferB64;
      } catch (e) {
        /* that tab can't see it; try the next */
      }
    }
    return null;
  }

  if (/^https?:/.test(url)) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    return bufferToBase64(buf);
  }
  return null;
}

let lastDownloadSeen = null;
const handledDownloads = new Set();

/**
 * Undo a download the gallery has already taken care of.
 *
 * A download can't be blocked before it starts - onDeterminingFilename can
 * rename a file but not stop one - so this cancels it and clears it out of
 * the downloads list. Whichever of cancel/removeFile applies depends on
 * how far the download got, so both are attempted and both may fail
 * harmlessly.
 */
async function discardDownload(item) {
  try {
    await chrome.downloads.cancel(item.id);
  } catch (e) {
    // Already finished: delete the file it wrote instead.
    try {
      await chrome.downloads.removeFile(item.id);
    } catch (e2) {
      lastDownloadSeen.result += ' (file left in Downloads)';
      return;
    }
  }
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch (e) {
    /* the entry stays in the list; the file is what matters */
  }
  lastDownloadSeen.result += ', download discarded';
}

async function handleDownload(item) {
  if (!item || handledDownloads.has(item.id)) return;
  if (!downloadIsFromNovelAI(item) || !downloadLooksLikeImage(item)) return;

  handledDownloads.add(item.id);
  if (handledDownloads.size > 200) {
    handledDownloads.delete(handledDownloads.values().next().value);
  }

  const settings = await getSettings();
  // Saving is an explicit action, so every capture mode allows it - but a
  // stopped switch still means stopped.
  if (settings.autoEnabled === false) return;

  lastDownloadSeen = {
    at: Date.now(),
    url: (item.finalUrl || item.url || '').slice(0, 120),
    filename: item.filename || '',
  };

  let bufferB64 = null;
  try {
    bufferB64 = await resolveDownloadBytes(item);
  } catch (e) {
    lastUploadError = 'Could not read the downloaded image: ' + e.message;
  }
  if (!bufferB64) {
    lastDownloadSeen.result = 'could not read the bytes';
    return;
  }
  if (!isPngBase64(bufferB64)) {
    // The gallery stores PNGs, because that's where NovelAI's prompt
    // metadata lives. Anything else is left alone rather than half-saved.
    lastDownloadSeen.result = 'not a PNG, left alone';
    return;
  }

  setBadge('saving');
  try {
    const result = await uploadImage({
      bufferB64,
      capturedBy: 'download-save',
      pageUrl: item.referrer || item.finalUrl || item.url,
    });
    setBadge('ok');
    lastUploadError = '';
    lastCaptureBy = 'download-save';
    lastDownloadSeen.result = result.deduped ? 'already in the gallery' : 'saved';

    // Only now that the image is definitely stored is it safe to take the
    // browser's copy away - otherwise a failure here would leave the user
    // with neither.
    if (interceptDownloads) await discardDownload(item);
    if (!result.deduped) {
      const { captureCount = 0 } = await chrome.storage.local.get('captureCount');
      await chrome.storage.local.set({
        captureCount: captureCount + 1,
        lastCaptureAt: Date.now(),
        lastCaptureBy,
      });
    }
  } catch (e) {
    setBadge('error');
    lastUploadError = e.message;
    lastDownloadSeen.result = 'upload failed: ' + e.message;
    await enqueueForRetry({ bufferB64, capturedBy: 'download-save', pageUrl: item.referrer || '' });
  }
}

if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    handleDownload(item).catch((e) => {
      lastUploadError = 'download capture failed: ' + e.message;
    });
  });
}

async function reportReuse(state, message, id) {
  try {
    const base = await resolveBase();
    await fetch(`${base}/api/reuse/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, message, id }),
    });
  } catch (e) {
    /* the app may have closed; nothing useful to do */
  }
}

async function deliverReuse(id, url) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: NOVELAI_TAB_PATTERNS });
  } catch (e) {
    await reportReuse('error', 'Could not look up browser tabs: ' + e.message, id);
    return;
  }

  if (tabs.length === 0) {
    await reportReuse('no-tab', 'No NovelAI tab is open. Open NovelAI and try again.', id);
    return;
  }

  let buffer;
  try {
    buffer = await fetch(url).then((r) => r.arrayBuffer());
  } catch (e) {
    await reportReuse('error', 'Could not read the image: ' + e.message, id);
    return;
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const bufferB64 = btoa(binary);

  // Prefer the active tab if one of the NovelAI tabs is already focused.
  const target = tabs.find((t) => t.active) || tabs[0];
  const payload = {
    type: 'reuse-image',
    bufferB64,
    filename: `novelai-gallery-${id}.png`,
  };

  // Bring the tab forward *before* dropping. A background tab may not have
  // laid out the elements the drop has to land on, and the user is about to
  // be looking at it anyway.
  try {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    await new Promise((r) => setTimeout(r, 250));
  } catch (e) {
    /* focusing is a nicety, not a requirement */
  }

  // The top frame first, explicitly. Without a frameId the message goes to
  // every frame at once and whichever answers first wins the response -
  // on a page carrying any third-party iframe that's a coin toss, and a
  // stray "no" from an ad frame would be reported as the outcome.
  let resp = null;
  let lastError = '';
  try {
    resp = await chrome.tabs.sendMessage(target.id, payload, { frameId: 0 });
  } catch (e) {
    lastError = e.message || String(e);
  }

  // If the top frame couldn't take it, the app may itself be in a frame.
  if (!(resp && resp.dropped)) {
    try {
      const alt = await chrome.tabs.sendMessage(target.id, payload);
      if (alt && (alt.dropped || !resp)) resp = alt;
    } catch (e) {
      if (!lastError) lastError = e.message || String(e);
    }
  }

  if (resp && resp.dropped) {
    await reportReuse(
      'delivered',
      resp.reason ? `Dropped into NovelAI (${resp.reason}).` : 'Dropped into NovelAI.',
      id
    );
    return;
  }

  if (!resp) {
    await reportReuse(
      'error',
      'The NovelAI tab is not ready - reload it once, then try again.' +
        (lastError ? ` (${lastError})` : ''),
      id
    );
    return;
  }

  await reportReuse('error', 'NovelAI did not accept the image. ' + (resp.reason || ''), id);
}

let reuseLoopRunning = false;
async function reuseLoop() {
  if (reuseLoopRunning) return;
  reuseLoopRunning = true;
  try {
    for (;;) {
      let base;
      try {
        base = await resolveBase();
      } catch (e) {
        // App not running; back off and retry.
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      try {
        const res = await fetch(`${base}/api/reuse/wait`, { signal: AbortSignal.timeout(30000) });
        if (res.status === 200) {
          const { id, url } = await res.json();
          if (id) await deliverReuse(id, url);
        }
        // 204 = nothing pending within the window; loop straight back.
      } catch (e) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  } finally {
    reuseLoopRunning = false;
  }
}

reuseLoop();

/**
 * Push the current mode and on/off state to every open NovelAI tab, so a
 * change in the popup takes effect immediately rather than on next reload.
 */
async function broadcastMode() {
  const { autoEnabled } = await getSettings();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: NOVELAI_TAB_PATTERNS });
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'push-mode',
        captureMode,
        autoEnabled,
        interceptDownloads,
      });
    } catch (e) {
      /* tab without the content script; ignore */
    }
  }
}

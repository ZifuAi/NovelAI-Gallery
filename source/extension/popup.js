const $ = (id) => document.getElementById(id);
let lastStatus = null;

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function render(status) {
  lastStatus = status;
  if (!status) return;

  // --- is the desktop app reachable? ---
  $('appDot').className = `dot ${status.reachable ? 'ok' : 'error'}`;
  $('appText').textContent = status.reachable
    ? 'Connected to the gallery app'
    : 'Gallery app not running — open NovelAI Gallery';

  // --- is the extension actually live on a NovelAI page? ---
  const aliveRecently = status.contentAliveAt && Date.now() - status.contentAliveAt < 5 * 60 * 1000;
  if (aliveRecently) {
    $('pageDot').className = 'dot ok';
    $('pageText').textContent = 'Running on your NovelAI tab';
    $('pageSub').textContent = status.contentPageUrl || '';
  } else {
    $('pageDot').className = 'dot warn';
    $('pageText').textContent = 'Not detected on a NovelAI tab';
    $('pageSub').textContent =
      'Open novelai.net and reload the tab once after installing the extension.';
  }

  // Prefer the app's real library total; fall back to the local counter
  // when the app isn't reachable.
  // Start/stop button reflects the current state.
  const on = status.autoEnabled !== false;
  const tb = $('toggleBtn');
  tb.textContent = on ? 'Stop automatic saving' : 'Start automatic saving';
  tb.className = 'btn ' + (on ? 'stop' : 'startup');

  $('captureCount').textContent =
    status.galleryTotal !== null && status.galleryTotal !== undefined
      ? status.galleryTotal
      : status.captureCount || 0;

  // --- diagnostics blob ---
  const d = status.diag || {};
  const lines = [
    `app reachable   : ${status.reachable} ${status.appUrl || ''}`,
    `capture mode    : ${status.captureMode || '?'}`,
    `auto saving     : ${status.autoEnabled === false ? 'STOPPED' : 'running'}`,
    `in gallery      : ${status.galleryTotal ?? '?'}`,
    `new this session: ${status.captureCount || 0} (last ${ago(status.lastCaptureAt)}${status.lastCaptureBy ? ', via ' + status.lastCaptureBy : ''})`,
    `queued          : ${status.pendingCount || 0}`,
    `upload error    : ${status.uploadError || 'none'}`,
    '',
    `content script  : ${aliveRecently ? 'alive' : 'NOT SEEN'} (${ago(status.contentAliveAt)})`,
    `page            : ${status.contentPageUrl || '-'}`,
    '',
    `fetch responses : ${d.fetchSeen ?? '-'}`,
    `xhr responses   : ${d.xhrSeen ?? '-'}`,
    `<img> examined  : ${d.imagesSeen ?? '-'}`,
    `idb records read: ${d.idbScanned ?? '-'}`,
    `idb databases   : ${(d.idbDatabases || []).join(', ') || '-'}`,
    `strategies hit  : ${JSON.stringify(d.strategies || {})}`,
    `last page error : ${d.lastError || 'none'}`,
  ];
  if (status.lastScanAt) {
    lines.push('', `manual scan     : found ${status.lastScanFound ?? 0} (${ago(status.lastScanAt)})`);
  }
  if (status.lastDownload) {
    const dl = status.lastDownload;
    lines.push(
      '',
      `last download   : ${dl.result || 'seen'} (${ago(dl.at)})`,
      `  file          : ${dl.filename || '-'}`,
      `  from          : ${dl.url || '-'}`
    );
  }
  $('diag').textContent = lines.join('\n');

  if (status.appUrl) {
    $('openGallery').href = status.appUrl;
    $('openGallery').style.display = '';
  } else {
    $('openGallery').style.display = 'none';
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'get-status' }, (status) => {
    if (chrome.runtime.lastError) return;
    render(status);
  });
}

$('scanBtn').addEventListener('click', () => {
  const btn = $('scanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  chrome.runtime.sendMessage({ type: 'scan-all-tabs' }, (resp) => {
    const asked = resp?.tabsAsked || 0;
    if (asked === 0) {
      btn.textContent = 'No NovelAI tab open';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Import NovelAI history now';
      }, 2200);
      return;
    }
    btn.textContent = `Scanning ${asked} tab${asked === 1 ? '' : 's'}…`;
    // The sweep is asynchronous in the page; poll for the result.
    setTimeout(() => {
      refresh();
      btn.disabled = false;
      btn.textContent = 'Import NovelAI history now';
    }, 6000);
  });
});

$('toggleBtn').addEventListener('click', () => {
  const next = !(lastStatus && lastStatus.autoEnabled !== false);
  const tb = $('toggleBtn');
  tb.disabled = true;
  chrome.runtime.sendMessage({ type: 'set-auto-enabled', enabled: next }, () => {
    tb.disabled = false;
    refresh();
  });
});

$('copyDiag').addEventListener('click', () => {
  navigator.clipboard.writeText($('diag').textContent).then(() => {
    $('copyDiag').textContent = 'Copied';
    setTimeout(() => ($('copyDiag').textContent = 'Copy diagnostics'), 1500);
  });
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 2500);

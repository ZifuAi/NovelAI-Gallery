const DEFAULTS = {
  serverUrl: '', // blank = auto-discover
  networkCaptureEnabled: true,
  domCaptureEnabled: true,
};

/**
 * The gallery app runs on this machine, so only loopback addresses can be
 * valid. Anything else - most easily a NovelAI URL pasted in by mistake -
 * would mean trying to send captured images to a remote server, so it's
 * refused here rather than saved.
 */
function isLoopbackUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch (e) {
    return false;
  }
}

function showError(msg) {
  const box = document.getElementById('urlError');
  box.textContent = msg || '';
  box.style.display = msg ? 'block' : 'none';
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get([...Object.keys(DEFAULTS), 'serverUrlRejected'])) };
  document.getElementById('serverUrl').value = s.serverUrl;
  document.getElementById('networkCaptureEnabled').checked = s.networkCaptureEnabled;
  document.getElementById('domCaptureEnabled').checked = s.domCaptureEnabled;

  if (s.serverUrlRejected) {
    showError(
      `A non-local address (${s.serverUrlRejected}) was previously set here and has been cleared. ` +
      `This box is only for the gallery app on your own PC — leave it blank unless you know you need it.`
    );
    chrome.storage.local.remove('serverUrlRejected');
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const raw = document.getElementById('serverUrl').value.trim();

  if (raw && !isLoopbackUrl(raw)) {
    showError(
      'That address points somewhere other than this computer. The gallery app is local, ' +
      'so this must be a 127.0.0.1 or localhost address (for example http://127.0.0.1:8756) — ' +
      'or just leave it blank so the extension finds the app on its own.'
    );
    return;
  }
  showError('');

  await chrome.storage.local.set({
    serverUrl: raw,
    networkCaptureEnabled: document.getElementById('networkCaptureEnabled').checked,
    domCaptureEnabled: document.getElementById('domCaptureEnabled').checked,
  });

  const msg = document.getElementById('savedMsg');
  msg.classList.add('show');
  setTimeout(() => msg.classList.remove('show'), 1600);
});

load();

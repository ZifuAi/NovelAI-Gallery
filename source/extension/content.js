/**
 * Isolated-world relay between inject.js (page world, sees NovelAI's fetch,
 * DOM and IndexedDB) and background.js (service worker, allowed to talk to
 * the local app).
 *
 * Image bytes are base64-encoded before crossing into extension messaging:
 * chrome.runtime.sendMessage does NOT reliably preserve ArrayBuffer on this
 * hop - it silently degrades to a plain indexed object with no .byteLength,
 * rather than throwing - even though window.postMessage from the page world
 * transfers it fine.
 */
(() => {
  const MSG_SOURCE = 'novelai-gallery-inject-v1';

  const recentFingerprints = new Set();

  /**
   * Identify an image so the same one isn't uploaded twice in a row.
   *
   * This used to sample 32 bytes spread across the buffer, which is fast
   * but wrong: two images of the same size differing only in a region the
   * sampler happened to skip got the same fingerprint, and the second one
   * was silently dropped as a duplicate. A full FNV-1a pass costs a few
   * milliseconds on a several-megabyte PNG and can't do that.
   *
   * The app dedupes properly by SHA-256 anyway; this only exists to avoid
   * uploading the same bytes twice within a session.
   */
  function fingerprint(buffer) {
    const bytes = new Uint8Array(buffer);
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      // hash *= 16777619, kept in 32-bit range without overflowing to float
      hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
    return `${bytes.length}:${hash.toString(16)}`;
  }

  function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* extension reloading; the page keeps working regardless */
    }
  }

  // Push the current capture mode into the page world so the download hook
  // knows whether to suppress the browser download.
  function syncMode() {
    try {
      chrome.runtime.sendMessage({ type: 'get-capture-mode' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        window.postMessage(
          {
            source: 'novelai-gallery-cmd',
            type: 'mode',
            captureMode: resp.captureMode,
            autoEnabled: resp.autoEnabled,
            interceptDownloads: resp.interceptDownloads,
          },
          location.origin
        );
      });
    } catch (e) {
      /* ignore */
    }
  }
  syncMode();
  window.addEventListener('focus', syncMode);

  // The app can ask for an immediate sweep of NovelAI's stored history,
  // or for an image to be handed to the page as a dropped file.
  let reuseSeq = 0;
  const pendingReuse = new Map();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'push-mode') {
      window.postMessage(
        {
          source: 'novelai-gallery-cmd',
          type: 'mode',
          captureMode: message.captureMode,
          autoEnabled: message.autoEnabled,
          interceptDownloads: message.interceptDownloads,
        },
        location.origin
      );
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'scan-now') {
      window.postMessage({ source: 'novelai-gallery-cmd', type: 'scan-now' }, location.origin);
      sendResponse({ started: true });
      return true;
    }

    // The service worker saw a download start in this tab and needs the
    // bytes behind a blob: URL, which only the page's own origin can read.
    if (message?.type === 'resolve-blob') {
      const token = ++reuseSeq;
      pendingReuse.set(token, sendResponse);
      window.postMessage(
        { source: 'novelai-gallery-cmd', type: 'resolve-blob', token, url: message.url },
        location.origin
      );
      setTimeout(() => {
        if (pendingReuse.has(token)) {
          pendingReuse.get(token)({ ok: false, reason: 'timeout' });
          pendingReuse.delete(token);
        }
      }, 6000);
      return true;
    }

    if (message?.type === 'reuse-image') {
      const token = ++reuseSeq;
      pendingReuse.set(token, sendResponse);
      // The File and DataTransfer have to be built in the page's own world,
      // otherwise the site's handlers see objects from the isolated world
      // and the drop is ignored.
      window.postMessage(
        {
          source: 'novelai-gallery-cmd',
          type: 'reuse-image',
          token,
          bufferB64: message.bufferB64,
          filename: message.filename,
        },
        location.origin
      );
      // Don't leave the channel open forever if the page never answers.
      // The drop routine deliberately spends a few frames announcing the
      // drag before it drops, so this has to outlast that.
      setTimeout(() => {
        if (pendingReuse.has(token)) {
          pendingReuse.get(token)({ dropped: false, reason: 'the page never answered' });
          pendingReuse.delete(token);
        }
      }, 20000);
      return true; // async response
    }
    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE) return;

    if (data.type === 'diag') {
      send({ type: 'novelai-diag', diag: data.diag, pageUrl: location.href });
      return;
    }

    if (data.type === 'scan-result') {
      send({ type: 'novelai-scan-result', found: data.found });
      return;
    }

    if (data.type === 'blob-result') {
      const cb = pendingReuse.get(data.token);
      if (cb) {
        cb({ ok: !!data.ok, bufferB64: data.bufferB64, reason: data.reason });
        pendingReuse.delete(data.token);
      }
      return;
    }

    if (data.type === 'reuse-result') {
      const cb = pendingReuse.get(data.token);
      if (cb) {
        cb({ dropped: !!data.dropped, reason: data.reason });
        pendingReuse.delete(data.token);
      }
      return;
    }

    if (data.type !== 'candidate-image') return;
    if (!(data.buffer instanceof ArrayBuffer)) return;

    // Only the same route repeating itself is filtered here. Deciding
    // that an image is a duplicate outright has to happen in the service
    // worker, which is the side that knows the capture mode: the page
    // fetches an image (caught, then rejected by the mode), you press
    // save a moment later, and that second capture must not be thrown
    // away as "already seen" when the first one was never used.
    const fp = fingerprint(data.buffer);
    const routeKey = `${data.capturedBy}:${fp}`;
    if (recentFingerprints.has(routeKey)) return;
    recentFingerprints.add(routeKey);
    if (recentFingerprints.size > 500) {
      recentFingerprints.delete(recentFingerprints.values().next().value);
    }

    send({
      type: 'novelai-image-candidate',
      capturedBy: data.capturedBy,
      pageUrl: data.pageUrl,
      fingerprint: fp,
      bufferB64: bufferToBase64(data.buffer),
    });
  });

  // Let the service worker know a NovelAI page actually has the content
  // script running - the popup uses this to distinguish "extension isn't
  // loaded on this page" from "loaded but nothing captured yet".
  send({ type: 'novelai-content-alive', pageUrl: location.href });
})();

/**
 * Page-world capture script (MAIN world, document_start).
 *
 * Runs in NovelAI's own JS context so it can see the site's real fetch/XHR
 * and its IndexedDB. Five independent strategies, because any one of them
 * can be defeated by a site change:
 *
 *   1. fetch interception      - catches the generation response
 *   2. XHR interception        - same, for XMLHttpRequest-based calls
 *   3. IndexedDB history scan  - reads the site's stored history directly.
 *                                This is the sturdy one: it depends on no
 *                                endpoint path or DOM structure, only on
 *                                the images being in browser storage at all.
 *   4. DOM scan                - <img> elements holding image data
 *   5. download interception   - when you hit save/download
 *
 * Everything found is handed to content.js via postMessage, which relays
 * it to the service worker for upload. This file never talks to the local
 * app directly and doesn't know its address.
 */
(() => {
  const MSG_SOURCE = 'novelai-gallery-inject-v1';
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

  // Rolling diagnostics, surfaced in the extension popup. Without a live
  // NovelAI account to test against, this is how a failure gets diagnosed
  // rather than guessed at.
  const diag = {
    mode: 'generated',
    autoEnabled: true,
    baselined: false,
    strategies: {},
    lastError: '',
    idbDatabases: [],
    idbScanned: 0,
    fetchSeen: 0,
    xhrSeen: 0,
    imagesSeen: 0,
  };

  function note(strategy) {
    diag.strategies[strategy] = (diag.strategies[strategy] || 0) + 1;
    pushDiag();
  }

  let diagTimer = null;
  function pushDiag() {
    if (diagTimer) return;
    diagTimer = setTimeout(() => {
      diagTimer = null;
      try {
        window.postMessage(
          { source: MSG_SOURCE, type: 'diag', diag: JSON.parse(JSON.stringify(diag)) },
          location.origin
        );
      } catch (e) {
        /* diagnostics must never break capture */
      }
    }, 400);
  }

  function looksLikePng(bytes) {
    return (
      bytes &&
      bytes.length >= 4 &&
      bytes[0] === PNG_SIG[0] &&
      bytes[1] === PNG_SIG[1] &&
      bytes[2] === PNG_SIG[2] &&
      bytes[3] === PNG_SIG[3]
    );
  }

  function postCandidate(buffer, capturedBy) {
    // Manual actions (explicit history import, right-click save, reuse)
    // bypass the automatic on/off switch - the user asked for those
    // directly.
    const manual = /manual/.test(capturedBy);
    if (!autoEnabled && !manual) return false;
    if (!buffer || buffer.byteLength < 512) return false;
    const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    if (!looksLikePng(head)) return false;
    note(capturedBy);
    window.postMessage(
      {
        source: MSG_SOURCE,
        type: 'candidate-image',
        capturedBy,
        pageUrl: location.href,
        buffer,
      },
      location.origin,
      [buffer]
    );
    return true;
  }

  // =====================================================================
  // Shared: pull PNG bytes out of whatever container we're handed
  // =====================================================================

  async function toArrayBuffer(value) {
    try {
      if (value instanceof ArrayBuffer) return value;
      if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      }
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return await value.arrayBuffer();
      }
    } catch (e) {
      /* fall through */
    }
    return null;
  }

  /**
   * Walk an arbitrary value looking for PNG bytes. NovelAI's stored history
   * records are objects with the image somewhere inside, and the exact
   * field name is not something I can rely on, so this searches structurally
   * instead of by key name. Depth-limited so a cyclic or huge object can't
   * stall the page.
   */
  async function harvest(value, capturedBy, depth = 0, seen = new Set()) {
    if (value == null || depth > 4) return 0;

    const buf = await toArrayBuffer(value);
    if (buf) {
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (looksLikePng(head)) {
        return postCandidate(buf, capturedBy) ? 1 : 0;
      }
      return 0;
    }

    if (typeof value === 'string') {
      // data:image/png;base64,... stored as a string
      const m = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (m) {
        try {
          const bin = atob(m[1]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return postCandidate(bytes.buffer, capturedBy) ? 1 : 0;
        } catch (e) {
          return 0;
        }
      }
      return 0;
    }

    if (typeof value !== 'object') return 0;
    if (seen.has(value)) return 0;
    seen.add(value);

    let found = 0;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) {
        found += await harvest(item, capturedBy, depth + 1, seen);
      }
      return found;
    }
    for (const key of Object.keys(value).slice(0, 60)) {
      found += await harvest(value[key], capturedBy, depth + 1, seen);
    }
    return found;
  }

  // =====================================================================
  // Strategy 3: IndexedDB history scan
  // =====================================================================

  const scannedKeys = new Set();
  // In generation-only mode the first sweep records what NovelAI already
  // has WITHOUT importing it, so the gallery fills with new generations
  // rather than the entire backlog. The popup's explicit "Import history"
  // button bypasses this.
  let baselined = false;

  function openDatabase(name) {
    return new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(name); // no version = open as-is, never upgrades
      } catch (e) {
        return resolve(null);
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      // A DB the site holds open can hang: don't wait forever.
      setTimeout(() => resolve(null), 4000);
    });
  }

  function readAll(store, limit) {
    return new Promise((resolve) => {
      const out = [];
      let req;
      try {
        req = store.openCursor();
      } catch (e) {
        return resolve(out);
      }
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || out.length >= limit) return resolve(out);
        out.push({ key: String(cursor.key), value: cursor.value });
        cursor.continue();
      };
      req.onerror = () => resolve(out);
      setTimeout(() => resolve(out), 6000);
    });
  }

  async function scanIndexedDB(capturedBy = 'idb-history', full = false) {
    const baselineOnly = !full && interceptMode !== 'all' && !baselined;
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') {
      diag.lastError = 'indexedDB.databases() unavailable in this browser';
      pushDiag();
      return 0;
    }

    let dbs = [];
    try {
      dbs = await indexedDB.databases();
    } catch (e) {
      diag.lastError = 'indexedDB.databases() failed: ' + e.message;
      pushDiag();
      return 0;
    }

    diag.idbDatabases = dbs.map((d) => d.name).filter(Boolean);
    pushDiag();

    let total = 0;
    for (const info of dbs) {
      if (!info.name) continue;
      const db = await openDatabase(info.name);
      if (!db) continue;

      try {
        for (const storeName of Array.from(db.objectStoreNames)) {
          let entries = [];
          try {
            const tx = db.transaction(storeName, 'readonly');
            entries = await readAll(tx.objectStore(storeName), 400);
          } catch (e) {
            continue;
          }

          for (const { key, value } of entries) {
            const tag = `${info.name}/${storeName}/${key}`;
            if (scannedKeys.has(tag)) continue;
            scannedKeys.add(tag);
            diag.idbScanned++;
            // Baseline pass: remember it exists, don't import it.
            if (baselineOnly) continue;
            total += await harvest(value, capturedBy);
          }
        }
      } finally {
        try {
          db.close();
        } catch (e) {
          /* ignore */
        }
      }
    }
    if (baselineOnly) {
      baselined = true;
      diag.baselined = true;
    }
    pushDiag();
    return total;
  }

  // =====================================================================
  // Strategy 1 + 2: network interception
  // =====================================================================

  // Broad on purpose: rather than trying to name NovelAI's generation
  // endpoint exactly (which I can't verify), treat any response that
  // actually contains PNG bytes as a candidate. The PNG signature check is
  // the real filter.
  const IGNORE_PATH = /\/(api\/settings|api\/health)$/;

  async function tryHandleZip(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    const out = [];
    while (offset + 30 <= bytes.length) {
      if (view.getUint32(offset, true) !== 0x04034b50) break;
      const compression = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const dataStart = offset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > bytes.length) break;
      const chunk = buffer.slice(dataStart, dataEnd);

      if (compression === 0) {
        out.push(chunk);
      } else if (compression === 8 && typeof DecompressionStream !== 'undefined') {
        try {
          const stream = new Blob([chunk]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          out.push(await new Response(stream).arrayBuffer());
        } catch (e) {
          /* skip this entry */
        }
      }
      offset = dataEnd;
    }
    return out;
  }

  async function inspectBuffer(buffer, capturedBy) {
    if (!buffer || buffer.byteLength < 512) return;
    const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));

    if (looksLikePng(head)) {
      postCandidate(buffer, capturedBy);
      return;
    }
    // ZIP ("PK\x03\x04") - NovelAI returns batches this way.
    if (head[0] === 0x50 && head[1] === 0x4b) {
      const pngs = await tryHandleZip(buffer);
      pngs.forEach((p) => postCandidate(p, capturedBy + '-zip'));
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (response.ok && !IGNORE_PATH.test(new URL(url, location.href).pathname)) {
        diag.fetchSeen++;
        const ct = response.headers.get('content-type') || '';
        // Only clone bodies that could plausibly be image payloads, so we
        // don't buffer every JSON/HTML response the app makes.
        if (/(image|octet-stream|zip|binary)/i.test(ct)) {
          response
            .clone()
            .arrayBuffer()
            .then((b) => inspectBuffer(b, 'network-fetch'))
            .catch(() => {});
        }
      }
    } catch (e) {
      diag.lastError = 'fetch hook: ' + e.message;
    }
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__nagUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener('load', () => {
        try {
          diag.xhrSeen++;
          const ct = this.getResponseHeader && this.getResponseHeader('content-type');
          if (ct && !/(image|octet-stream|zip|binary)/i.test(ct)) return;
          const res = this.response;
          if (res instanceof ArrayBuffer) {
            inspectBuffer(res, 'network-xhr');
          } else if (typeof Blob !== 'undefined' && res instanceof Blob) {
            res.arrayBuffer().then((b) => inspectBuffer(b, 'network-xhr')).catch(() => {});
          }
        } catch (e) {
          diag.lastError = 'xhr hook: ' + e.message;
        }
      });
    } catch (e) {
      /* never break the page's request */
    }
    return origSend.apply(this, args);
  };

  // =====================================================================
  // Strategy 5: download / save interception
  // =====================================================================

  // 'generated' (default) - only images from a NEW generation
  // 'all'                  - also imports the existing history backlog
  // 'download'             - only when you save/download an image
  let interceptMode = 'generated';
  // Mirrors the app's "keep saved images here instead of downloading them"
  // setting; pushed in by the service worker.
  let suppressDownloads = false;
  // Master on/off for automatic saving, toggled from the extension popup.
  let autoEnabled = true;

  let lastAppliedMode = null;

  /**
   * Only react when the capture MODE actually changes.
   *
   * This used to run on every mode push, and the popup pushes on each
   * start/stop toggle - which re-armed the baseline pass, so the next sweep
   * marked genuinely new images as "already seen" and silently dropped
   * them. Toggling the switch must not re-baseline.
   */
  function applyMode() {
    if (interceptMode === lastAppliedMode) return;
    const first = lastAppliedMode === null;
    lastAppliedMode = interceptMode;
    if (first) return; // start() handles the initial baseline

    // Entering 'all' should import the backlog on the next sweep; leaving
    // it should treat whatever is there now as already seen.
    baselined = interceptMode === 'all' ? false : true;
    diag.baselined = baselined;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'novelai-gallery-cmd') return;
    if (e.data.type === 'mode') {
      interceptMode = e.data.captureMode || 'generated';
      if (typeof e.data.autoEnabled === 'boolean') autoEnabled = e.data.autoEnabled;
      if (typeof e.data.interceptDownloads === 'boolean') {
        suppressDownloads = e.data.interceptDownloads;
        diag.suppressDownloads = suppressDownloads;
      }
      diag.mode = interceptMode;
      diag.autoEnabled = autoEnabled;
      applyMode();
      pushDiag();
    }
    if (e.data.type === 'scan-now') {
      // An explicit user action, so it always imports the full history
      // regardless of the capture mode.
      Promise.all([scanIndexedDB('idb-manual', true), scanDom('dom-manual')]).then(([a, b]) => {
        window.postMessage(
          { source: MSG_SOURCE, type: 'scan-result', found: a + b },
          location.origin
        );
      });
    }
    if (e.data.type === 'resolve-blob') {
      const reply = (extra) => window.postMessage(
        { source: MSG_SOURCE, type: 'blob-result', token: e.data.token, ...extra },
        location.origin
      );
      resolveBlobUrl(e.data.url)
        .then((bufferB64) => reply({ ok: true, bufferB64 }))
        .catch((err) => reply({ ok: false, reason: err.message }));
    }
    if (e.data.type === 'reuse-image') {
      dropImageIntoPage(e.data.bufferB64, e.data.filename)
        .then((result) => {
          window.postMessage(
            { source: MSG_SOURCE, type: 'reuse-result', token: e.data.token, ...result },
            location.origin
          );
        })
        .catch((err) => {
          window.postMessage(
            {
              source: MSG_SOURCE,
              type: 'reuse-result',
              token: e.data.token,
              dropped: false,
              reason: err.message,
            },
            location.origin
          );
        });
    }
  });

  // =====================================================================
  // Reuse: hand NovelAI the PNG as a dropped file
  // =====================================================================
  //
  // NovelAI reads generation settings back out of a PNG's embedded
  // metadata when you drag the file onto the page. Rather than trying to
  // drive its React state (which I can't see), this reproduces that drag:
  // a real File in a DataTransfer, delivered through the normal
  // dragenter/dragover/drop sequence. Built here in the page world, since
  // objects created in the extension's isolated world are not accepted by
  // the site's own handlers.

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function makeTransfer(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    dt.effectAllowed = 'all';
    dt.dropEffect = 'copy';
    return dt;
  }

  function dragEvent(type, dt, x, y) {
    return new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      dataTransfer: dt,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      buttons: 1,
    });
  }

  /**
   * The deepest element under a point, following open shadow roots.
   *
   * Aiming at the deepest node matters: the event then bubbles up through
   * every ancestor, so a handler anywhere on that path sees it. Aiming at a
   * container instead would miss handlers attached further in.
   */
  function deepestAt(x, y) {
    let node = document.elementFromPoint(x, y);
    let guard = 0;
    while (node && node.shadowRoot && guard++ < 12) {
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }
    return node || document.body;
  }

  function describe(node) {
    if (!node) return 'nothing';
    if (node === window) return 'window';
    if (node === document) return 'document';
    const tag = (node.tagName || '').toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof node.className === 'string' && node.className
      ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return `${tag}${id}${cls}` || 'node';
  }

  /** Every file input on the page, shadow roots included. */
  function fileInputs() {
    const found = [];
    const visit = (root, depth) => {
      if (!root || depth > 6) return;
      root.querySelectorAll('input[type="file"]').forEach((i) => found.push(i));
      root.querySelectorAll('*').forEach((node) => {
        if (node.shadowRoot) visit(node.shadowRoot, depth + 1);
      });
    };
    visit(document, 0);
    return found;
  }

  /**
   * Hand the page a file as if it had been dragged in from the desktop.
   *
   * The naive version - dispatch dragenter/dragover/drop back to back on a
   * container - works on the live site but not on the newer build, and the
   * reason is timing rather than aim. Sites of this kind mount their import
   * overlay *in response to* the drag starting; a drop fired in the same
   * tick lands before that overlay exists, so nothing is listening yet.
   *
   * So: announce the drag first, give the page real frames to react in,
   * then re-aim at whatever is now under the cursor and drop there. Only a
   * preventDefault on the drop itself counts as acceptance - a page that
   * merely blocks the browser's default "open the file" behaviour on
   * dragover is not the same as one that took the file.
   */
  async function dropImageIntoPage(bufferB64, filename) {
    if (!bufferB64) return { dropped: false, reason: 'no image data' };

    const bytes = base64ToBytes(bufferB64);
    const file = new File([bytes], filename || 'image.png', { type: 'image/png' });

    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    const attempts = [];

    // --- 1. announce the drag, then drop where the page put its target ---
    try {
      const dt = makeTransfer(file);
      let entered = null;
      for (let i = 0; i < 5; i++) {
        const node = deepestAt(x, y);
        if (node !== entered) {
          node.dispatchEvent(dragEvent('dragenter', dt, x, y));
          entered = node;
        }
        node.dispatchEvent(dragEvent('dragover', dt, x, y));
        await nextFrame();
        await sleep(70);
      }

      const target = deepestAt(x, y);
      const drop = dragEvent('drop', dt, x, y);
      target.dispatchEvent(drop);
      attempts.push(`drag@${describe(target)}${drop.defaultPrevented ? ' ok' : ''}`);
      if (drop.defaultPrevented) {
        note('reuse-dropped');
        return { dropped: true, reason: `dropped on ${describe(target)}` };
      }
    } catch (e) {
      attempts.push('drag failed: ' + e.message);
    }

    // --- 2. named containers, in case the drop zone is off-centre ---
    const selectors = [
      '[data-drop-target]',
      '[class*="dropzone" i]',
      '[class*="drop-zone" i]',
      '[class*="droparea" i]',
      'main',
      '#__next',
      '#app',
      '#root',
    ];
    const seen = new Set();
    for (const sel of selectors) {
      let node = null;
      try {
        node = document.querySelector(sel);
      } catch (e) { /* invalid selector on an old engine */ }
      if (!node || seen.has(node)) continue;
      seen.add(node);
      try {
        const dt = makeTransfer(file);
        const rect = node.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width / 2) || x;
        const cy = Math.round(rect.top + rect.height / 2) || y;
        node.dispatchEvent(dragEvent('dragenter', dt, cx, cy));
        node.dispatchEvent(dragEvent('dragover', dt, cx, cy));
        await nextFrame();
        const drop = dragEvent('drop', dt, cx, cy);
        node.dispatchEvent(drop);
        if (drop.defaultPrevented) {
          note('reuse-dropped');
          return { dropped: true, reason: `dropped on ${sel}` };
        }
      } catch (e) { /* try the next one */ }
    }
    attempts.push(`containers(${seen.size}) no`);

    // --- 3. a file input, which some importers use instead of a drop zone ---
    for (const input of fileInputs()) {
      try {
        const dt = makeTransfer(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        note('reuse-dropped');
        return { dropped: true, reason: 'handed to a file input' };
      } catch (e) { /* read-only in some engines; try the next */ }
    }
    attempts.push('file-input no');

    // --- 4. paste, which many editors accept as an image import ---
    try {
      const dt = makeTransfer(file);
      const target = deepestAt(x, y) || document.body;
      const paste = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt,
      });
      target.dispatchEvent(paste);
      if (paste.defaultPrevented) {
        note('reuse-dropped');
        return { dropped: true, reason: 'accepted as a paste' };
      }
      attempts.push('paste no');
    } catch (e) {
      attempts.push('paste failed');
    }

    note('reuse-rejected');
    diag.lastError = 'reuse: ' + attempts.join(' | ');
    return {
      dropped: false,
      reason: 'the page did not accept the image (' + attempts.join('; ') + ')',
    };
  }

  async function captureFromHref(href, capturedBy) {
    if (!href) return false;
    try {
      const buf = await fetch(href).then((r) => r.arrayBuffer());
      return postCandidate(buf, capturedBy);
    } catch (e) {
      return false;
    }
  }

  function isImageDownload(anchor) {
    if (!anchor || !anchor.hasAttribute('download')) return false;
    const href = anchor.getAttribute('href') || '';
    const name = anchor.getAttribute('download') || '';
    return /\.png(\?|$)/i.test(name) || href.startsWith('blob:') || href.startsWith('data:image');
  }

  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target?.closest?.('a[download]');
      if (!isImageDownload(anchor)) return;
      const href = anchor.getAttribute('href');
      // By default the download is left alone - you pressed save because
      // you wanted the file, and the gallery just keeps a copy. With
      // "keep saved images here" on, the click is stopped before the
      // browser ever starts a download, so there's no file and no dialog.
      if (suppressDownloads) {
        event.preventDefault();
        event.stopPropagation();
      }
      captureFromHref(href, 'download-intercept');
    },
    true
  );

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick(...args) {
    try {
      if (isImageDownload(this)) {
        captureFromHref(this.getAttribute('href'), 'download-intercept');
        if (suppressDownloads) return;
      }
    } catch (e) {
      /* never break the page */
    }
    return origAnchorClick.apply(this, args);
  };

  // ---------------------------------------------------------------------
  // Saving through the File System Access API
  // ---------------------------------------------------------------------
  //
  // A "save" button doesn't have to be an <a download> - a modern app can
  // call showSaveFilePicker() and stream the bytes to the handle, which
  // creates no download item and no anchor click. Tee the bytes as they go
  // past; the page's own save is untouched either way.
  if (typeof window.showSaveFilePicker === 'function') {
    const origPicker = window.showSaveFilePicker;
    window.showSaveFilePicker = async function patchedPicker(...args) {
      const handle = await origPicker.apply(this, args);
      try {
        teeFileHandle(handle);
      } catch (e) {
        /* never break the page */
      }
      return handle;
    };
  }

  function teeFileHandle(handle) {
    if (!handle || typeof handle.createWritable !== 'function') return;
    const origCreate = handle.createWritable.bind(handle);
    handle.createWritable = async function patchedCreateWritable(...args) {
      const writer = await origCreate(...args);
      const chunks = [];
      const origWrite = writer.write.bind(writer);
      const origClose = writer.close.bind(writer);

      writer.write = async function patchedWrite(data) {
        try {
          // write() takes either the data itself or a {type, data} command.
          const payload = data && data.type !== undefined ? data.data : data;
          if (payload) chunks.push(payload);
        } catch (e) { /* ignore */ }
        return origWrite(data);
      };
      writer.close = async function patchedClose() {
        const result = await origClose();
        try {
          if (chunks.length) {
            const buf = await new Blob(chunks).arrayBuffer();
            postCandidate(buf, 'download-save-picker');
          }
        } catch (e) { /* ignore */ }
        return result;
      };
      return writer;
    };
  }

  // ---------------------------------------------------------------------
  // Blob registry
  // ---------------------------------------------------------------------
  //
  // Right-click -> "Save image as" is a browser action: no page event fires
  // at all, so the service worker watches the downloads list instead. What
  // it sees for a generated image is usually a blob: URL, which only this
  // page's origin can read - and which the page often revokes immediately.
  // Keeping the last few blobs alive here means that lookup still resolves.
  const blobRegistry = new Map();
  const MAX_BLOBS = 40;

  if (typeof URL.createObjectURL === 'function') {
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function patchedCreateObjectURL(obj) {
      const url = origCreateObjectURL(obj);
      try {
        if (obj instanceof Blob && (!obj.type || /image|octet-stream/i.test(obj.type))) {
          blobRegistry.set(url, obj);
          while (blobRegistry.size > MAX_BLOBS) {
            blobRegistry.delete(blobRegistry.keys().next().value);
          }
        }
      } catch (e) { /* ignore */ }
      return url;
    };
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function resolveBlobUrl(url) {
    const known = blobRegistry.get(url);
    const blob = known || (await fetch(url).then((r) => r.blob()));
    const buf = await blob.arrayBuffer();
    return bytesToBase64(buf);
  }

  // =====================================================================
  // Strategy 4: DOM scan
  // =====================================================================

  const seenSrc = new Set();
  const MIN_DIMENSION = 128;

  async function captureImgElement(img, capturedBy) {
    const src = img.currentSrc || img.src;
    if (!src) return 0;
    // Accept anything the page is actually displaying as an image, not
    // just blob: URLs - the previous version missed data: and same-origin
    // http(s) images entirely.
    if (!/^(blob:|data:image\/png)/.test(src) && !/^https?:/.test(src)) return 0;
    if (seenSrc.has(src)) return 0;

    if (!img.complete) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    }
    if (img.naturalWidth < MIN_DIMENSION && img.naturalHeight < MIN_DIMENSION) return 0;

    seenSrc.add(src);
    if (seenSrc.size > 800) seenSrc.delete(seenSrc.values().next().value);

    // Baseline pass: note that it exists, don't import it.
    if (capturedBy === 'dom-baseline') return 0;

    diag.imagesSeen++;
    try {
      const buf = await fetch(src).then((r) => r.arrayBuffer());
      return postCandidate(buf, capturedBy) ? 1 : 0;
    } catch (e) {
      return 0;
    }
  }

  async function scanDom(capturedBy = 'dom-scan') {
    const imgs = Array.from(document.querySelectorAll('img'));
    let found = 0;
    for (const img of imgs) {
      found += await captureImgElement(img, capturedBy);
    }
    return found;
  }

  // The history strip renders right after load; treating those as new
  // captures would import the backlog. So in generation-only mode the DOM
  // watcher stays disarmed until the page has settled, and images present
  // during that window are recorded as already-seen.
  let domArmed = false;

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const tag = interceptMode === 'all' || domArmed ? 'dom-scan' : 'dom-baseline';
        if (node.tagName === 'IMG') captureImgElement(node, tag);
        else node.querySelectorAll?.('img').forEach((i) => captureImgElement(i, tag));
      });
    }
  });

  function start() {
    // In generation-only mode this records what's already on screen instead
    // of importing it.
    scanDom(interceptMode === 'all' ? 'dom-scan' : 'dom-baseline');
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Give the page a few seconds to render its existing history before
    // treating newly-inserted images as fresh generations.
    setTimeout(() => {
      domArmed = true;
    }, 6000);

    // First sweep baselines the stored history (generation-only mode) or
    // imports it (all mode); later sweeps pick up new generations.
    setTimeout(() => scanIndexedDB(), 2500);
    setInterval(() => scanIndexedDB(), 15000);
    pushDiag();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

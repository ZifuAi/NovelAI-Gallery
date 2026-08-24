/* Generate — NovelAI's image API, from inside the app.
 *
 * The second way images get into the library. The browser extension still
 * works exactly as before; both paths end at the same store, so a generated
 * image is searchable, taggable and undoable like any captured one.
 *
 * The token never comes back to this page. The app reports only whether one
 * is saved, because a page that can read a token is a page that can leak it.
 */

const GEN = {
  // Confirmed spending Anlas this session. Asked once, not every time.
  warned: false,
  busy: false,
  // A picture to work from, and the mask over it. Both are data URLs here
  // and stripped to bare base64 on the way out, which is what NovelAI wants.
  refImage: null,
  refName: '',
  mask: null,
};

const genBare = (dataUrl) => String(dataUrl || '').replace(/^data:[^,]+,/, '');

// NovelAI's own sizes. Anything else is allowed by the API but these are
// the ones the models were trained around.
const GEN_SIZES = [
  ['Portrait  832 × 1216', 832, 1216],
  ['Landscape  1216 × 832', 1216, 832],
  ['Square  1024 × 1024', 1024, 1024],
  ['Portrait large  1024 × 1536', 1024, 1536],
  ['Landscape large  1536 × 1024', 1536, 1024],
  ['Square large  1472 × 1472', 1472, 1472],
  ['Portrait small  512 × 768', 512, 768],
  ['Landscape small  768 × 512', 768, 512],
];

const GEN_SAMPLERS = [
  'k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m', 'k_dpmpp_sde', 'ddim_v3',
];

/* The models NovelAI offers, newest first.
 *
 * The last entry is an escape hatch, not a cop-out: NovelAI ships models
 * faster than this app can, and without it "there's a new model" would mean
 * "wait for an update". Everything else is a plain choice. */
const GEN_MODELS = [
  ['NovelAI Diffusion V5 Full', 'nai-diffusion-5-full'],
  ['NovelAI Diffusion V5 Curated', 'nai-diffusion-5-curated'],
  ['NovelAI Diffusion V4.5 Full', 'nai-diffusion-4-5-full'],
  ['NovelAI Diffusion V4.5 Curated', 'nai-diffusion-4-5-curated'],
  ['Other…', ''],
];

// The newest model, and what anything unrecognised falls back to.
const GEN_DEFAULT_MODEL = 'nai-diffusion-5-full';

/* What is actually sent: the dropdown's value, or the identifier typed into
   Other. Never empty - an empty model would be filled in by the server, and
   the app would then be generating with something other than what the
   screen shows. */
function genModelId() {
  const chosen = gEl('genModel').value;
  if (chosen) return chosen;
  return gEl('genModelCustom').value.trim() || GEN_DEFAULT_MODEL;
}

const gEl = (id) => document.getElementById(id);

/* The token is entered in Settings, not here. It is a once-ever thing, and
   a field you fill in one time does not belong in the middle of a screen
   you use constantly. This is only the status and the way there. */
async function genRefreshToken() {
  let info = null;
  try {
    info = await fetch('/api/nai/token').then((r) => r.json());
  } catch (e) { /* shown as not set */ }

  const set = !!info?.present;
  if (gEl('genTokenState')) {
    gEl('genTokenState').textContent = set ? 'Saved' : 'Not set';
    gEl('genTokenState').dataset.on = set ? 'yes' : 'no';
  }
  if (gEl('genTokenNote')) {
    gEl('genTokenNote').textContent = set
      ? `Held on this PC, ${info.protection}. Sent only to NovelAI.`
      : 'Generating needs a NovelAI API token. Add one in Settings ▸ Capture.';
    // Once a token is saved there is nothing left to explain, so the block
    // shrinks to a single line and gives the space back to the prompt.
    gEl('genTokenCard').classList.toggle('compact', set);
  }
  gEl('genGo').disabled = !set;
  genUpdateCost();
  return set;
}

/* Roughly what a generation will cost.
 *
 * NovelAI does not publish the formula, and the one that circulated for V3
 * gives 20 Anlas for 1024x1024 at 28 steps where V5 actually charges 30 -
 * so this is calibrated from a known price rather than derived, and scales
 * with pixels and steps from there. It is an estimate and says so; the
 * number on NovelAI's own Generate button is the one that gets charged.
 *
 * Opus subscribers generate free under certain limits, which this does not
 * try to model - it would be guessing at a second thing on top of the
 * first. */
const GEN_ANLAS_REF = { anlas: 30, pixels: 1024 * 1024, steps: 28 };

function genAnlasEstimate(req) {
  const work = req.width * req.height * req.steps;
  const ref = GEN_ANLAS_REF.pixels * GEN_ANLAS_REF.steps;
  return Math.max(1, Math.round((work / ref) * GEN_ANLAS_REF.anlas)) * req.count;
}

function genUpdateCost() {
  const req = genRequest();
  const n = genAnlasEstimate(req);
  gEl('genGo').innerHTML =
    `<span>Generate ${req.count === 1 ? '1 image' : req.count + ' images'}</span>` +
    `<span class="gen-cost" title="Estimated — NovelAI's own button is authoritative">≈ ${n} Anlas</span>`;
}

function genRequest() {
  const [, w, h] = GEN_SIZES[gEl('genSize').selectedIndex] || GEN_SIZES[0];
  const seed = Number(gEl('genSeed').value);
  return {
    prompt: gEl('genPrompt').value.trim(),
    negative: gEl('genNegative').value.trim(),
    model: genModelId(),
    width: w,
    height: h,
    steps: Number(gEl('genSteps').value) || 28,
    scale: Number(gEl('genScale').value) || 5,
    cfgRescale: Number(gEl('genRescale').value) || 0,
    sampler: gEl('genSampler').value,
    seed: Number.isFinite(seed) && seed > 0 ? seed : 0,
    count: Number(gEl('genCount').value) || 1,
    characters: genChars.filter((c) => c.prompt.trim())
      .map((c) => ({ ...c, position: genPosMode === 'custom' })),
    image: GEN.refImage ? genBare(GEN.refImage) : '',
    mask: GEN.mask ? genBare(GEN.mask) : '',
    strength: Number(gEl('genStrength').value) || 0.7,
    noise: Number(gEl('genNoise').value) || 0,
  };
}

/* --- character prompts ------------------------------------------------

   V4 introduced a separate prompt per character because describing two
   people in one prompt makes the model blend them. Up to six, each with its
   own undesired content and an optional position. */

let genChars = [];

/* AI's Choice or Custom, for the whole scene rather than per character.
   NovelAI works the same way, and it matches how the setting actually
   behaves: use_coords is one flag on the request, not one per person. */
let genPosMode = 'auto';

function genRenderChars() {
  const host = gEl('genChars');
  gEl('genCharCount').textContent = genChars.length;

  // Nothing to position when there is nobody to position, so the control
  // appears with the first character and goes with the last.
  gEl('genPosRow').hidden = genChars.length === 0;
  if (!genChars.length) {
    if (genPosMode !== 'auto') genSetPosMode('auto');
    host.innerHTML = '<div class="gen-note">None — the prompt above describes the whole scene.</div>';
    return;
  }

  // Same shape as the main prompt: one big box with two tabs over it. A
  // character's prompt is written the same way the scene's is, so it should
  // be the same field rather than a cramped one-liner.
  host.innerHTML = genChars.map((c, i) => `
    <div class="gen-char" data-i="${i}">
      <div class="gen-char-head">
        <span class="gen-char-n">${i + 1}</span>
        <div class="gen-tabs gen-char-tabs">
          <button class="gen-tab${c.tab !== 'uc' ? ' active' : ''}" data-tab="prompt">Prompt</button>
          <button class="gen-tab${c.tab === 'uc' ? ' active' : ''}" data-tab="uc">UC</button>
        </div>
        <div class="topbar-spacer"></div>
        <button class="pg-icon" data-act="remove" title="Remove this character" aria-label="Remove">×</button>
      </div>
      <textarea class="pg-input mono gen-char-box" spellcheck="false"
        placeholder="${c.tab === 'uc'
          ? 'undesired content for this character (optional)'
          : '1girl, red hair, school uniform'}"
        >${esc(c.tab === 'uc' ? c.negative : c.prompt)}</textarea>
      ${genPosMode === 'custom' ? `
        <div class="gen-char-at">at ${Math.round(c.x * 100)}%, ${Math.round(c.y * 100)}%</div>` : ''}
    </div>`).join('');

  host.querySelectorAll('.gen-char').forEach((row) => {
    const c = genChars[Number(row.dataset.i)];
    const box = row.querySelector('.gen-char-box');

    box.addEventListener('input', () => {
      if (c.tab === 'uc') c.negative = box.value;
      else c.prompt = box.value;
    });
    // Whatever height you drag this to is kept when the tab flips, so
    // switching to undesired content doesn't collapse the box you sized.
    box.addEventListener('mouseup', () => { c.height = box.style.height || ''; });
    if (c.height) box.style.height = c.height;

    row.querySelectorAll('.gen-char-tabs .gen-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        // Save what is in the box before swapping what the box shows.
        if (c.tab === 'uc') c.negative = box.value;
        else c.prompt = box.value;
        c.tab = tab.dataset.tab;
        genRenderChars();
      });
    });

    row.querySelector('[data-act="remove"]').addEventListener('click', () => {
      genChars = genChars.filter((x) => x !== c);
      genRenderChars();
    });
  });
}

/* Per-character prompts out of an image's metadata.
 *
 * V4 and later write them into the PNG under v4_prompt, the same place the
 * gallery's own prompt view reads them from - so an image with two
 * characters comes back as two characters here rather than one merged
 * prompt. Undesired content sits in the matching slot of the negative half.
 */
function genCharsFromMeta(m) {
  const c = m?.comment;
  if (!c) return [];
  const caps = c.v4_prompt?.caption?.char_captions;
  if (!Array.isArray(caps) || !caps.length) return [];
  const negs = c.v4_negative_prompt?.caption?.char_captions || [];

  return caps.slice(0, 6).map((cap, i) => {
    const centers = cap?.centers;
    const at = Array.isArray(centers) && centers.length ? centers[0] : null;
    return {
      prompt: typeof cap === 'string' ? cap : (cap?.char_caption || ''),
      negative: negs[i]?.char_caption || '',
      tab: 'prompt', height: '',
      x: typeof at?.x === 'number' ? at.x : 0.5,
      y: typeof at?.y === 'number' ? at.y : 0.5,
    };
  }).filter((c2) => c2.prompt.trim());
}

/* --- working from an existing picture ---------------------------------

   Dropping a picture in, or bringing one over from the gallery, sets it as
   a reference. On its own that is img2img - the same picture again, changed
   as far as Strength allows. Painting a mask over part of it makes it
   inpainting, and the app swaps in the matching inpainting model rather
   than asking anyone to pick one. */

/* Setting a reference image.
 *
 * The size sent has to be the size of the picture being worked from.
 * NovelAI is generating over that image, and asking it for a 832x1216
 * result from a 1024x1536 source is a mismatch it refuses - which is what
 * made importing an image and pressing Generate fail. So the reference
 * decides the resolution, and the size control follows it rather than
 * silently disagreeing.
 */
/* Anything that is not already a data URL is fetched and turned into one.
 *
 * NovelAI wants the picture itself, as base64. A gallery image arrives here
 * as a path like /api/images/<id>/file, and passing that string straight
 * through is what made "Edit in Generate" then Generate fail: NovelAI was
 * handed the text "/api/images/…" where an image should have been. */
async function genAsDataUrl(src) {
  if (!src || src.startsWith('data:')) return src;
  const blob = await fetch(src).then((r) => r.blob());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* Takes a data URL, a path, or null. Anything that needs fetching is
   fetched first, so what is held is always the image itself. */
function genSetReference(src, name) {
  if (!src || src.startsWith('data:')) return genSetReferenceData(src, name);
  genAsDataUrl(src)
    .then((data) => genSetReferenceData(data, name))
    .catch(() => toast('Could not read that image'));
}

function genSetReferenceData(dataUrl, name) {
  GEN.refImage = dataUrl || null;
  GEN.refName = name || '';
  GEN.mask = null;
  GEN.refW = 0;
  GEN.refH = 0;

  if (!dataUrl) {
    genPaintReference();
    return;
  }

  const probe = new Image();
  probe.onload = () => {
    GEN.refW = probe.naturalWidth;
    GEN.refH = probe.naturalHeight;
    genMatchSizeToReference();
    genPaintReference();
  };
  probe.onerror = () => genPaintReference();
  probe.src = dataUrl;
}

/* Point the size control at the reference's own dimensions, adding an entry
   for them if the list has nothing that matches. */
function genMatchSizeToReference() {
  if (!GEN.refW || !GEN.refH) return;
  const sel = gEl('genSize');

  const i = GEN_SIZES.findIndex(([, w, h]) => w === GEN.refW && h === GEN.refH);
  if (i >= 0) {
    sel.selectedIndex = i;
    genUpdateCost();
    return;
  }

  // A size NovelAI's own list does not carry - a cropped image, or one from
  // somewhere else. It is still the size that has to be asked for, so it
  // joins the list rather than being quietly rounded to something near it.
  const label = `Reference  ${GEN.refW} × ${GEN.refH}`;
  const existing = GEN_SIZES.findIndex(([l]) => l.startsWith('Reference'));
  if (existing >= 0) GEN_SIZES.splice(existing, 1);
  GEN_SIZES.unshift([label, GEN.refW, GEN.refH]);

  sel.innerHTML = GEN_SIZES.map(([l]) => `<option>${esc(l)}</option>`).join('');
  sel.selectedIndex = 0;
  genUpdateCost();
}

function genPaintReference() {
  const has = !!GEN.refImage;
  // Either the list of things you could add, or the one you did.
  gEl('genRefEmpty').hidden = has;
  gEl('genRefActive').hidden = !has;
  if (!has) {
    gEl('genRefSliders').hidden = true;
    genUpdateCost();
    return;
  }
  gEl('genRefThumb').src = GEN.mask || GEN.refImage;
  gEl('genRefName').textContent = GEN.mask ? 'Inpainting' : 'Image2Image';
  gEl('genRefSize').textContent = GEN.refW
    ? `${GEN.refW} × ${GEN.refH} — the output matches this`
    : '';
  gEl('genInpaintBtn').textContent = GEN.mask ? 'Edit mask' : 'Inpaint';
  // The sliders only mean something once there is an area to apply them
  // to, so they stay out of the way until a mask has been saved.
  gEl('genRefSliders').hidden = !GEN.mask;
  genUpdateCost();
}

/* --- placing characters ------------------------------------------------

   A separate surface, because dragging a marker needs room the sidebar
   hasn't got. Coordinates are fractions of the frame, so they hold when the
   image size changes. */

let genSettingPos = false;
/* `opening` is only true when someone clicked Custom. Restoring the mode
   from an imported image must not throw the canvas open in their face -
   they asked to reuse a prompt, not to start placing people. */
function genSetPosMode(mode, opening) {
  if (genSettingPos) return;
  genSettingPos = true;
  genPosMode = mode;
  document.querySelectorAll('.gen-segbtn').forEach((b) =>
    b.classList.toggle('active', b.dataset.pos === mode));
  gEl('genOpenCanvas').disabled = mode !== 'custom';
  genRenderChars();
  genSettingPos = false;
  // Straight into the canvas, because that is what choosing Custom means.
  if (opening && mode === 'custom' && genChars.length) genOpenCanvas();
}

function genOpenCanvas() {
  const named = genChars.filter((c) => c.prompt.trim() || genChars.length === 1);
  if (!genChars.length) return toast('Add a character first');

  const frame = gEl('genPosFrame');
  // The frame stands in for the picture being generated, so it takes the
  // same shape - a marker two thirds across a square is somewhere else
  // entirely once the picture is a landscape.
  const [, w, h] = GEN_SIZES[gEl('genSize').selectedIndex] || GEN_SIZES[0];
  frame.style.aspectRatio = `${w} / ${h}`;
  gEl('genPosSize').textContent = `${w} × ${h}`;

  frame.querySelectorAll('.genpos-mark').forEach((n) => n.remove());
  genChars.forEach((c, i) => {
    const mark = document.createElement('button');
    mark.className = 'genpos-mark';
    mark.textContent = String(i + 1);
    mark.title = c.prompt || `Character ${i + 1}`;
    mark.style.left = `${c.x * 100}%`;
    mark.style.top = `${c.y * 100}%`;

    const move = (e) => {
      const r = frame.getBoundingClientRect();
      c.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      c.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      mark.style.left = `${c.x * 100}%`;
      mark.style.top = `${c.y * 100}%`;
    };
    mark.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      mark.setPointerCapture(e.pointerId);
      mark.classList.add('dragging');
    });
    mark.addEventListener('pointermove', (e) => {
      if (mark.hasPointerCapture(e.pointerId)) move(e);
    });
    const stop = () => { mark.classList.remove('dragging'); genRenderChars(); };
    mark.addEventListener('pointerup', stop);
    mark.addEventListener('pointercancel', stop);

    frame.appendChild(mark);
  });

  gEl('genCanvasModal').hidden = false;
}

/* --- the picture, and this session's history ------------------------- */

let genCurrent = null;   // the Pending shown in the middle
let genHistory = [];     // newest first, as the server returns it

function genShow(item) {
  genCurrent = item || null;
  const img = gEl('genPreview');
  const has = !!item;

  gEl('genPlaceholder').hidden = has;
  img.hidden = !has;
  gEl('genActions').hidden = !has;
  if (!has) return;

  img.src = `/api/nai/pending/${item.id}/file`;
  gEl('genMeta').textContent = [
    item.width && item.height ? `${item.width} × ${item.height}` : '',
    item.seed ? `seed ${item.seed}` : '',
    item.model || '',
  ].filter(Boolean).join('  ·  ');

  // Already in the library: say so rather than offering to add it twice.
  const keep = gEl('genKeep');
  keep.textContent = item.savedId ? 'Saved to gallery' : 'Save to gallery';
  keep.disabled = !!item.savedId;
  gEl('genReuseSeed').disabled = !item.seed;
  genRenderStrip();
}

function genRenderStrip() {
  const host = gEl('genStrip');
  if (!genHistory.length) {
    host.innerHTML = '<div class="gen-note">Nothing yet.</div>';
    return;
  }
  host.innerHTML = genHistory.map((it) => `
    <button class="gen-thumb${genCurrent && it.id === genCurrent.id ? ' current' : ''}"
      data-id="${esc(it.id)}" title="${it.savedId ? 'Saved to your gallery' : 'Not saved yet'}">
      <img src="/api/nai/pending/${esc(it.id)}/file" alt="" loading="lazy" />
      ${it.savedId ? '<span class="gen-kept" aria-label="Saved">✓</span>' : ''}
    </button>`).join('');

  host.querySelectorAll('.gen-thumb').forEach((b) => {
    b.addEventListener('click', () => {
      genShow(genHistory.find((x) => x.id === b.dataset.id));
    });
  });
}

async function genLoadHistory() {
  try {
    genHistory = await fetch('/api/nai/pending').then((r) => r.json()) || [];
  } catch (e) { genHistory = []; }
  genRenderStrip();
}

async function genKeep() {
  if (!genCurrent || genCurrent.savedId) return;
  const res = await fetch(`/api/nai/pending/${genCurrent.id}/keep`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || 'Could not save that');

  genCurrent.savedId = data.id;
  const inList = genHistory.find((x) => x.id === genCurrent.id);
  if (inList) inList.savedId = data.id;
  genShow(genCurrent);
  refreshCounts();
  toast('Saved to your gallery');
}

/* Inpaint the picture on the stage.
 *
 * Repainting part of what you just made is the commonest reason to inpaint
 * at all, and until now it meant saving the image, finding it in the
 * gallery, and importing it back. This makes the generation on screen the
 * reference and opens the painter on it in one move.
 *
 * The prompt is deliberately left exactly as it is: it is the prompt that
 * made this picture, and it is the one the repainted area should be
 * generated from. */
async function genInpaintCurrent() {
  if (!genCurrent) return;
  const btn = gEl('genInpaintCurrent');
  btn.disabled = true;
  try {
    const dataUrl = await genAsDataUrl(`/api/nai/pending/${genCurrent.id}/file`);
    if (!dataUrl) return toast('Could not read that image back');
    genSetReferenceData(dataUrl, `Generation ${String(genCurrent.id).slice(0, 6)}`);
    maskOpen(dataUrl, (png) => {
      GEN.mask = png;
      genPaintReference();
      toast('Mask saved — only that area will be replaced');
    });
  } catch (e) {
    toast('Could not read that image back');
  } finally {
    btn.disabled = false;
  }
}

async function genDiscard() {
  if (!genCurrent) return;
  const id = genCurrent.id;
  await fetch(`/api/nai/pending/${id}`, { method: 'DELETE' }).catch(() => {});
  genHistory = genHistory.filter((x) => x.id !== id);
  // Show the next one along rather than emptying the stage entirely.
  genShow(genHistory[0] || null);
  genRenderStrip();
}

async function genGenerate() {
  if (GEN.busy) return;
  const req = genRequest();
  if (!req.prompt) return toast('There is no prompt to generate from');

  // Asked once per session, because every generation spends Anlas and the
  // second one is not a surprise.
  if (!GEN.warned) {
    const ok = await confirmDialog({
      title: 'This spends Anlas',
      body: `Generating goes to NovelAI and costs Anlas at paid settings — this
             run asks for <strong>${req.count} image${req.count === 1 ? '' : 's'}</strong>,
             roughly <strong>${genAnlasEstimate(req)} Anlas</strong>.
             You won't be asked again until you restart the app.`,
      confirmLabel: 'Generate',
    });
    if (!ok) return;
    GEN.warned = true;
  }

  GEN.busy = true;
  gEl('genGo').disabled = true;
  gEl('genStatus').dataset.state = 'working';
  gEl('genStatus').textContent = req.count > 1
    ? `Generating ${req.count} images…` : 'Generating…';
  genStartProgress(req);

  try {
    const res = await fetch('/api/nai/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok && res.status !== 207) {
      // NovelAI's own words come through from the server; adding a guess
      // about the cause on top of them was worse than useless, since it
      // blamed a model that works.
      genShowError(data.error || `NovelAI answered ${res.status}`, data.request);
      return;
    }

    const images = data.images || [];
    if (res.status === 207) {
      // Some worked, some didn't. Both halves are worth saying: the ones
      // that arrived cost Anlas whatever happened to the rest.
      genShowError(`Made ${images.length}, then stopped: ${data.error}`, data.request);
    } else {
      gEl('genStatus').dataset.state = 'done';
      const auto = state.settings?.captureMode !== 'download';
      gEl('genStatus').textContent = auto
        ? (images.length === 1 ? 'Saved to your gallery.' : `${images.length} saved to your gallery.`)
        : (images.length === 1
            ? 'Done — save it if you want to keep it.'
            : `${images.length} made — save the ones you want to keep.`);
    }
    genHistory = [...images, ...genHistory];
    genShow(images[0] || null);

    // How a generated image reaches the library follows the same setting
    // that decides it for the extension. "Only save images I save or
    // download" means exactly that: nothing is filed away until the Save
    // button is pressed. The other two modes file it automatically, the way
    // they do for anything captured from the site.
    if (state.settings?.captureMode !== 'download') {
      for (const img of images) {
        try {
          const r = await fetch(`/api/nai/pending/${img.id}/keep`, { method: 'POST' });
          if (r.ok) {
            const saved = await r.json();
            img.savedId = saved.id;
          }
        } catch (e) { /* stays on the page, savable by hand */ }
      }
      genShow(genCurrent);
      refreshCounts();
    }
  } catch (e) {
    genShowError('Could not reach the app’s own server.');
  } finally {
    GEN.busy = false;
    gEl('genGo').disabled = false;
    genStopProgress();
    genRefreshAnlas();
  }
}

/* Showing a failure.
 *
 * NovelAI's own sentence goes on screen, and when a request was actually
 * sent, the exact payload is kept behind a button. A refusal with nothing
 * to inspect turns into guesswork, and guessing at this has already cost
 * more time than the button will ever cost to build. */
let genLastRequest = null;

function genShowError(message, request) {
  const box = gEl('genStatus');
  genLastRequest = request || null;
  box.dataset.state = 'error';
  box.textContent = message;

  if (genLastRequest) {
    const btn = document.createElement('button');
    btn.className = 'btn gen-copyreq';
    btn.textContent = 'Copy request';
    btn.title = 'Copy exactly what was sent to NovelAI';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(genLastRequest);
      toast('Request copied — paste it if you want me to look at it');
    });
    box.appendChild(document.createElement('br'));
    box.appendChild(btn);
  }
}

/* The progress bar.
 *
 * NovelAI reports nothing while it works - the request simply takes as long
 * as it takes - so a bar claiming a percentage would be inventing one. This
 * fills towards an estimate based on steps and how many images were asked
 * for, and deliberately never reaches the end on its own: it stops at 92%
 * and only completes when the images actually arrive. A bar that sits full
 * while nothing has happened is worse than no bar. */
let genProgressTimer = null;

function genStartProgress(req) {
  clearInterval(genProgressTimer);
  const bar = gEl('genProgressFill');
  gEl('genProgress').hidden = false;
  bar.style.width = '0%';

  // Very roughly a second per eight steps, per image. Wrong in either
  // direction is fine because it never claims to be finished.
  const expected = Math.max(3000, (req.steps / 8) * 1000 * req.count);
  const started = Date.now();
  genProgressTimer = setInterval(() => {
    const pct = Math.min(92, ((Date.now() - started) / expected) * 100);
    bar.style.width = `${pct}%`;
  }, 120);
}

function genStopProgress() {
  clearInterval(genProgressTimer);
  genProgressTimer = null;
  const bar = gEl('genProgressFill');
  bar.style.width = '100%';
  setTimeout(() => {
    gEl('genProgress').hidden = true;
    bar.style.width = '0%';
  }, 450);
}

/* --- what's left in the account -------------------------------------- */

async function genRefreshAnlas() {
  const box = gEl('genAnlas');
  if (!box) return;

  // Always shown, because it was asked for and a figure that vanishes when
  // it cannot be read is indistinguishable from one that is broken. What is
  // never shown is a made-up number: not knowing says so.
  const unknown = (why) => {
    box.hidden = false;
    box.dataset.known = 'no';
    box.textContent = 'Anlas —';
    box.title = why
      ? `Could not read your balance: ${why}`
      : 'Could not read your balance from NovelAI. Check the token in Settings.';
  };

  try {
    const b = await fetch('/api/nai/anlas').then((r) => r.json());
    if (!b?.known) return unknown(b?.reason);
    box.hidden = false;
    box.dataset.known = 'yes';
    // Zero is a real balance and is shown as one. Opus subscriptions sit
    // at zero fixed steps while the ordinary sizes are still free, so a
    // blank here read as a fault when nothing was wrong.
    box.textContent = `${Number(b.total || 0).toLocaleString()} Anlas`;
    box.title = `${Number(b.fixed || 0).toLocaleString()} from your subscription · `
      + `${Number(b.purchased || 0).toLocaleString()} bought`;
  } catch (e) {
    unknown();
  }
}

/* --- reading a prompt back out of a PNG -------------------------------

   NovelAI writes the prompt and settings into the images it makes, which is
   the same fact the whole gallery is built on. Dropping one here reads it
   back out and fills the form - the picture itself is not kept, because
   what was wanted was the recipe, not another copy. */

/* Deciding what a dropped picture is for.
 *
 * The same image can be wanted two ways - worked from, or read for its
 * recipe - and picking one silently was wrong: dropping an image in to see
 * its prompt also turned the next generation into img2img without saying
 * so. So it asks, the way NovelAI does.
 */
let genPendingImport = null;   // { dataUrl, name, meta }

// The quality tags NovelAI adds of its own accord. "Clean imports" leaves
// them out so an imported prompt is what was actually written rather than
// what was written plus boilerplate.
const GEN_QUALITY_NOISE = [
  'masterpiece', 'best quality', 'amazing quality', 'very aesthetic',
  'absurdres', 'highres', 'incredibly absurdres', 'newest', 'general',
  'no text', 'location',
];

function genClean(text) {
  return String(text || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !GEN_QUALITY_NOISE.includes(t.toLowerCase()))
    .join(', ');
}

function genOpenImportDialog(dataUrl, name, meta) {
  genPendingImport = { dataUrl, name, meta };
  gEl('genImportThumb').src = dataUrl;

  const hasMeta = !!(meta && (meta.prompt || meta.comment));
  gEl('genImportMeta').hidden = !hasMeta;
  gEl('genImportNoMeta').hidden = hasMeta;

  // Appending only means something when there is already someone here.
  gEl('impAppend').closest('.import-check').hidden = genChars.length === 0;
  gEl('genImportModal').hidden = false;
}

function genCloseImportDialog() {
  gEl('genImportModal').hidden = true;
  genPendingImport = null;
}

/* Import only what was ticked. Everything else is left exactly as it is,
   which is the point of asking. */
function genImportChosen() {
  const p = genPendingImport;
  if (!p) return;
  const m = p.meta || {};
  const clean = gEl('impClean').checked;

  if (gEl('impPrompt').checked && m.prompt) {
    gEl('genPrompt').value = clean ? genClean(m.prompt) : m.prompt;
  }
  if (gEl('impUC').checked && m.negativePrompt) {
    gEl('genNegative').value = clean ? genClean(m.negativePrompt) : m.negativePrompt;
  }

  if (gEl('impChars').checked) {
    const chars = genCharsFromMeta(m).map((c) => ({
      ...c, prompt: clean ? genClean(c.prompt) : c.prompt,
    }));
    // Replacing with nothing is still replacing. An image with no people
    // in it that leaves the last one's characters sitting in the form is
    // how you generate a picture you did not ask for.
    if (gEl('impAppend').checked) {
      if (chars.length) genChars = [...genChars, ...chars].slice(0, 6);
    } else {
      genChars = chars;
    }
    if (chars.length) {
      genSetPosMode(m.comment?.v4_prompt?.use_coords ? 'custom' : 'auto');
    } else if (!genChars.length) {
      genSetPosMode('auto');
    }
    genRenderChars();
  }

  if (gEl('impSettings').checked) {
    if (m.steps) gEl('genSteps').value = m.steps;
    if (m.scale) gEl('genScale').value = m.scale;
    if (m.sampler && GEN_SAMPLERS.includes(m.sampler)) gEl('genSampler').value = m.sampler;
    const known = m.model && GEN_MODELS.some(([, id]) => id === m.model);
    gEl('genModel').value = known ? m.model : GEN_DEFAULT_MODEL;
    gEl('genModelCustom').hidden = true;
    if (m.width && m.height) {
      const i = GEN_SIZES.findIndex(([, w, h]) => w === m.width && h === m.height);
      if (i >= 0) gEl('genSize').selectedIndex = i;
    }
  }

  // Off by default: importing a prompt usually means "something like this",
  // and the seed hands back the picture you already have. On when ticked,
  // because sometimes that is exactly what is wanted.
  gEl('genSeed').value = gEl('impSeed').checked && m.seed ? m.seed : '';

  genUpdateCost();
  genCloseImportDialog();
  toast('Metadata imported');
}

async function genImportFile(file) {
  if (!file || !/^image\//.test(file.type || '')) {
    return toast('That needs to be an image');
  }

  // Read the picture and its metadata, then ask what to do with them.
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  }).catch(() => null);
  if (!dataUrl) return toast('Could not read that image');

  let meta = null;
  if (/\.png$/i.test(file.name || '') || file.type === 'image/png') {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/nai/inspect', { method: 'POST', body: form });
      if (res.ok) meta = await res.json();
    } catch (e) { /* no metadata; still usable as a picture */ }
  }

  genOpenImportDialog(dataUrl, file.name, meta);
}

/* Shared by the drop target and by "Edit in Generate", so an image from the
   gallery and an image dragged in from the desktop behave identically. */
function genApplyMeta(m) {
  if (!m) return;
  gEl('genPrompt').value = m.prompt || '';
  if (m.negativePrompt) gEl('genNegative').value = m.negativePrompt;
  if (m.steps) gEl('genSteps').value = m.steps;
  if (m.scale) gEl('genScale').value = m.scale;
  if (m.sampler && GEN_SAMPLERS.includes(m.sampler)) gEl('genSampler').value = m.sampler;
  // A model this app does not list - an older one, or a name it does not
  // recognise - falls back to the newest rather than dropping into Other
  // with an identifier nobody chose and generating a failure.
  const known = m.model && GEN_MODELS.some(([, id]) => id === m.model);
  gEl('genModel').value = known ? m.model : GEN_DEFAULT_MODEL;
  // Clear it, not just hide it: a leftover identifier from an earlier
  // import would still be what got sent if Other were picked again.
  gEl('genModelCustom').value = '';
  gEl('genModelCustom').hidden = true;
  if (m.width && m.height) {
    const i = GEN_SIZES.findIndex(([, w, h]) => w === m.width && h === m.height);
    if (i >= 0) gEl('genSize').selectedIndex = i;
  }

  // Per-character prompts, if the image had them. This is the part that
  // makes importing worth having: a two-character picture comes back as two
  // characters rather than one merged prompt.
  const chars = genCharsFromMeta(m);
  if (chars.length) {
    genChars = chars;
    genRenderChars();
    // If the image was made with chosen positions, come back into Custom
    // so they are visible and adjustable rather than silently discarded.
    const used = m.comment?.v4_prompt?.use_coords;
    genSetPosMode(used ? 'custom' : 'auto');
  } else {
    genChars = [];
    genRenderChars();
  }
  // The seed is left alone on purpose: importing a prompt means "something
  // like this", and the seed would hand back the picture you already have.
  gEl('genSeed').value = '';
  genUpdateCost();
}

/* Loading an existing image's settings into the form. This is the second
   half of "reuse prompt": the extension path sends it back to the website,
   this one brings it here. */
async function genLoadFrom(record) {
  // Close the large view first, or the dialog opens behind it.
  if (typeof closeViewer === 'function' && !el.lightbox.hidden) closeViewer();
  selectTool('generate');
  if (typeof genInit === 'function') await genInit();

  // Same question as a dropped file: this is the same decision, and asking
  // in one place and guessing in the other would be the inconsistency.
  const dataUrl = await genAsDataUrl(`/api/images/${record.id}/file`).catch(() => null);
  if (!dataUrl) return toast('Could not read that image');
  genOpenImportDialog(dataUrl, record.filename || '', record.meta);
}

function genLoadFromLegacy(record) {
  genApplyMeta(record?.meta);
  if (record?.id) genSetReference(`/api/images/${record.id}/file`, record.filename || '');
  // Close the large view on the way out. Without this the lightbox stays
  // open on top of the tab it just sent you to, which looks like the tab
  // failed to switch.
  if (typeof closeViewer === 'function' && !el.lightbox.hidden) closeViewer();
  selectTool('generate');
  toast('Loaded into Image Generation');
}

let genReady = false;
async function genInit() {
  if (genReady) return;
  genReady = true;

  gEl('genModel').innerHTML = GEN_MODELS
    .map(([label, id]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
  gEl('genModel').value = GEN_DEFAULT_MODEL;
  gEl('genSize').innerHTML = GEN_SIZES.map(([label]) => `<option>${esc(label)}</option>`).join('');
  gEl('genSampler').innerHTML = GEN_SAMPLERS.map((s) => `<option>${esc(s)}</option>`).join('');
  gEl('genNegative').value =
    'lowres, worst quality, bad anatomy, bad hands, jpeg artifacts, watermark, signature';

  // Whether the structured prompt is sent follows the model, decided on the
  // server. It was a checkbox for a while and never needed to be: there is
  // one right answer per model and the app knows it.
  const followModel = () => {
    // "Other" reveals the box to type an identifier into.
    gEl('genModelCustom').hidden = gEl('genModel').value !== '';
  };
  gEl('genModel').addEventListener('change', followModel);
  gEl('genModelCustom').addEventListener('input', followModel);
  followModel();

  // Straight to where the token lives, on the right tab, rather than
  // "it's in settings somewhere".
  gEl('genTokenSettings').addEventListener('click', () => openSettingsAt('capture'));

  document.querySelectorAll('.gen-segbtn').forEach((b) => {
    b.addEventListener('click', () => genSetPosMode(b.dataset.pos, true));
  });
  gEl('genOpenCanvas').addEventListener('click', genOpenCanvas);
  gEl('genPosDone').addEventListener('click', () => {
    gEl('genCanvasModal').hidden = true;
    genRenderChars();
  });
  gEl('genPosReset').addEventListener('click', () => {
    genChars.forEach((c) => { c.x = 0.5; c.y = 0.5; });
    genOpenCanvas();
  });
  gEl('genCanvasModal').addEventListener('mousedown', (e) => {
    if (e.target === gEl('genCanvasModal')) gEl('genPosDone').click();
  });

  maskWire();
  gEl('genImportClose').addEventListener('click', genCloseImportDialog);
  gEl('genImportModal').addEventListener('mousedown', (e) => {
    if (e.target === gEl('genImportModal')) genCloseImportDialog();
  });
  gEl('genImportGo').addEventListener('click', genImportChosen);
  gEl('genImportI2I').addEventListener('click', () => {
    // Work from the picture, and leave every field alone.
    const p = genPendingImport;
    genCloseImportDialog();
    if (p) genSetReferenceData(p.dataUrl, p.name);
  });

  gEl('genInpaintBtn').addEventListener('click', () => {
    if (!GEN.refImage) return;
    maskOpen(GEN.refImage, (png) => {
      GEN.mask = png;
      genPaintReference();
      toast('Mask saved — only that area will be replaced');
    });
  });
  gEl('genRefClear').addEventListener('click', () => {
    // Back to the list of what could be added, rather than an empty card,
    // and the size list loses the entry the reference added to it.
    const ref = GEN_SIZES.findIndex(([l]) => l.startsWith('Reference'));
    if (ref >= 0) {
      GEN_SIZES.splice(ref, 1);
      gEl('genSize').innerHTML = GEN_SIZES.map(([l]) => `<option>${esc(l)}</option>`).join('');
      gEl('genSize').selectedIndex = 0;
    }
    genSetReference(null);
    toast('Reference image removed');
  });

  // Choosing a picture from disk. The pencil is the same thing followed by
  // the mask painter, since painting needs something to paint on.
  let paintAfterPick = false;
  gEl('genRefUpload').addEventListener('click', () => {
    paintAfterPick = false;
    gEl('genRefInput').click();
  });
  gEl('genRefPaint').addEventListener('click', () => {
    paintAfterPick = true;
    gEl('genRefInput').click();
  });
  gEl('genRefInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      genSetReference(reader.result, file.name);
      if (paintAfterPick) gEl('genInpaintBtn').click();
    };
    reader.readAsDataURL(file);
  });
  gEl('genStrength').addEventListener('input', (e) => {
    gEl('genStrengthVal').textContent = Number(e.target.value).toFixed(2);
  });
  gEl('genNoise').addEventListener('input', (e) => {
    gEl('genNoiseVal').textContent = Number(e.target.value).toFixed(2);
  });

  gEl('genAddChar').addEventListener('click', () => {
    if (genChars.length >= 6) return toast('NovelAI takes six characters at most');
    // Spread them across the frame rather than stacking every marker in
    // the middle, where they would be impossible to pick apart.
    const n = genChars.length;
    genChars.push({
      prompt: '', negative: '', tab: 'prompt', height: '',
      x: (n + 1) / (n + 2),
      y: 0.5,
    });
    genRenderChars();
  });

  // Folding sections away. The Generate button is deliberately outside all
  // of them: whatever you have collapsed, the thing you came to do stays
  // in front of you.
  document.querySelectorAll('.gen-block-head.foldable').forEach((head) => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('button:not(.gen-caret)')) return;
      const key = head.dataset.fold;
      const body = document.querySelector(`.gen-foldbody[data-body="${key}"]`);
      const folded = !body.hidden;
      body.hidden = folded;
      head.querySelector('.gen-caret').textContent = folded ? '▸' : '▾';
    });
  });

  gEl('genHistoryFold').addEventListener('click', () => {
    const pane = document.querySelector('.gen-history');
    const folded = pane.classList.toggle('folded');
    gEl('genHistoryFold').textContent = folded ? '‹' : '›';
    gEl('genHistoryFold').title = folded ? 'Show the history' : 'Hide the history';
  });

  gEl('genGo').addEventListener('click', genGenerate);
  // Any setting that changes the price updates it.
  ['genSize', 'genSteps', 'genCount'].forEach((id) => {
    gEl(id).addEventListener('input', genUpdateCost);
    gEl(id).addEventListener('change', genUpdateCost);
  });
  // Changing the size while the canvas is open must reshape it, or the
  // markers would be positioned against a frame that no longer applies.
  gEl('genSize').addEventListener('change', () => {
    if (!gEl('genCanvasModal').hidden) genOpenCanvas();
  });
  gEl('genKeep').addEventListener('click', genKeep);
  gEl('genInpaintCurrent').addEventListener('click', genInpaintCurrent);
  gEl('genDiscard').addEventListener('click', genDiscard);
  gEl('genReuseSeed').addEventListener('click', () => {
    if (genCurrent?.seed) {
      gEl('genSeed').value = genCurrent.seed;
      toast(`Seed ${genCurrent.seed} — generating again will repeat this picture`);
    }
  });
  gEl('genClearHistory').addEventListener('click', async () => {
    const unsaved = genHistory.filter((x) => !x.savedId).length;
    if (unsaved && !await confirmDialog({
      title: 'Clear the history?',
      body: `<strong>${unsaved}</strong> generation${unsaved === 1 ? '' : 's'} here
             ${unsaved === 1 ? 'has' : 'have'} not been saved to your gallery.
             Clearing throws ${unsaved === 1 ? 'it' : 'them'} away.`,
      confirmLabel: 'Clear',
    })) return;
    await fetch('/api/nai/pending', { method: 'DELETE' }).catch(() => {});
    genHistory = [];
    genShow(null);
    genRenderStrip();
  });

  // Prompt / Undesired content share one box, the way NovelAI's do.
  document.querySelectorAll('.gen-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.gen-tab').forEach((t) => t.classList.toggle('active', t === tab));
      gEl('genPrompt').hidden = tab.dataset.box !== 'prompt';
      gEl('genNegative').hidden = tab.dataset.box !== 'negative';
    });
  });

  gEl('genFromPrompt').addEventListener('click', () => {
    const built = document.getElementById('pgOut')?.textContent?.trim();
    if (!built) return toast('Roll something in the Prompt Generator first');
    gEl('genPrompt').value = built;
    const uc = document.getElementById('pgUC')?.value;
    if (uc) gEl('genNegative').value = uc;
    toast('Brought over from the Prompt Generator');
  });

  // Drag a NovelAI PNG anywhere onto this tab to read its prompt back out.
  const pane = gEl('toolGenerate');
  const veil = gEl('genDropVeil');
  let dragDepth = 0;
  pane.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    dragDepth++;
    veil.hidden = false;
  });
  pane.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  });
  pane.addEventListener('dragleave', () => {
    // dragleave fires for every child crossed, so it is counted rather than
    // trusted, or the overlay flickers away mid-drag.
    if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; }
  });
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (file) genImportFile(file);
  });

  genRenderChars();
  genPaintReference();
  genUpdateCost();
  await genRefreshToken();
  genRefreshAnlas();
  await genLoadHistory();
  genShow(genHistory[0] || null);
}

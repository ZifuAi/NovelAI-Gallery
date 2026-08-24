/* Painting a mask, for inpainting.
 *
 * The mask says which part of the picture NovelAI may repaint: white where
 * it should work, black where the original must be left alone.
 *
 * The important thing about a NovelAI mask, and the thing this used to get
 * wrong, is that it is not a full-resolution image. NovelAI reduces the
 * mask to an eighth of the picture's size before it uses it - the reference
 * implementations resize it to ceil(w/64)*8 by ceil(h/64)*8 with nearest
 * sampling, and V4-and-later blow that back up by eight again - so the
 * smallest thing a mask can express is an 8x8 block of the original. Paint
 * finer than that and it is not that the result is approximate: whole
 * strokes can disappear, because nearest sampling takes one pixel per block
 * and a thin line may not be the pixel it lands on.
 *
 * So the mask is painted into a grid of 8px cells and shown that way. What
 * you see on screen is exactly what NovelAI receives after its own
 * downscale, and the brush cannot be set smaller than one cell, because a
 * smaller brush would be a brush that does nothing.
 *
 * Undo keeps whole strokes rather than pixels. At an eighth of the size a
 * snapshot is tiny, so it can afford to keep plenty of them.
 */

// NovelAI's mask granularity: one mask cell covers this many image pixels
// on each axis.
const MASK_CELL = 8;

// The brush, in image pixels. The minimum is one cell - below that the
// brush would paint nothing that survives NovelAI's downscale. The maximum
// is not a documented NovelAI number; it is simply a size past which a
// brush stops being a brush.
const MASK_PEN_MIN = MASK_CELL;
const MASK_PEN_MAX = 512;
const MASK_PEN_STEP = MASK_CELL;

const MASK = {
  img: null,        // the source image element
  canvas: null,     // what is shown, at the image's own size
  ctx: null,
  grid: null,       // the real mask, one pixel per 8x8 cell
  gctx: null,
  cols: 0,
  rows: 0,
  pen: 64,
  square: false,
  mode: 'brush',
  drawing: false,
  strokes: [],      // snapshots taken before each stroke, for undo
  onSave: null,
  // Looking at the picture, as opposed to painting on it.
  zoom: 1,
  panX: 0,
  panY: 0,
  spaceDown: false,
};

const mEl = (id) => document.getElementById(id);

/* How many cells wide and tall the mask is.
 *
 * NovelAI rounds the picture up to a multiple of 64 before dividing by 8,
 * which for generated sizes changes nothing - they are already multiples of
 * 64 - but matters for an imported picture of an odd size. Rounding up
 * means the mask covers the whole image; a mask that stopped short would
 * leave a strip that could never be painted. */
function maskCells(px) {
  return Math.ceil(px / (MASK_CELL * 8)) * 8;
}

/* Open the painter over a picture. `src` is anything an <img> can load -
   a data URL, or one of the app's own image endpoints. */
function maskOpen(src, onSave) {
  MASK.onSave = onSave;
  MASK.strokes = [];
  MASK.mode = 'brush';
  mEl('maskBrush').classList.add('active');
  mEl('maskErase').classList.remove('active');

  const img = mEl('maskImg');
  const canvas = mEl('maskCanvas');
  MASK.img = img;
  MASK.canvas = canvas;

  const ready = () => {
    // The visible canvas is the image's real size; it is only ever a view
    // of the grid, which is the mask itself.
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    MASK.ctx = canvas.getContext('2d');

    MASK.cols = maskCells(img.naturalWidth);
    MASK.rows = maskCells(img.naturalHeight);
    MASK.grid = document.createElement('canvas');
    MASK.grid.width = MASK.cols;
    MASK.grid.height = MASK.rows;
    MASK.gctx = MASK.grid.getContext('2d', { willReadFrequently: true });
    MASK.gctx.clearRect(0, 0, MASK.cols, MASK.rows);

    mEl('genMaskModal').hidden = false;
    maskFit();
    // A new picture starts fitted to the window, not wherever the last one
    // was left zoomed to.
    maskResetView();
    maskPaintView();
    maskUpdateHint();
    maskShowPen();
  };

  img.onload = ready;
  img.src = src;
  if (img.complete && img.naturalWidth) ready();
}

/* Give the frame the picture's shape.
 *
 * The image and the mask are stacked on this one box, so a box of some
 * other shape pulls them apart and paint lands away from the pointer. CSS
 * does the fitting from there. */
function maskFit() {
  const frame = mEl('maskFrame');
  const img = MASK.img;
  if (!frame || !img?.naturalWidth) return;
  frame.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
  maskMoveCursor();
}

function maskHasAnything() {
  if (!MASK.gctx || !MASK.cols) return false;
  const d = MASK.gctx.getImageData(0, 0, MASK.cols, MASK.rows).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
  return false;
}

function maskUpdateHint() {
  const has = maskHasAnything();
  mEl('maskSave').disabled = !has;
  mEl('maskHint').textContent = has
    ? 'Saving keeps this area for replacement; the rest is left alone.'
    : 'Paint over what you want replaced.';
}

/* Draw the grid onto the visible canvas, blown back up with no smoothing.
 *
 * The blocky edge is not a shortcut - it is what the mask actually is.
 * Showing a smooth one would be showing something NovelAI never receives.
 * It is tinted rather than white so the picture underneath stays readable,
 * the way NovelAI's own blue mask does. */
function maskPaintView() {
  const ctx = MASK.ctx;
  if (!ctx) return;
  const w = MASK.canvas.width;
  const h = MASK.canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(MASK.grid, 0, 0, MASK.cols, MASK.rows,
    0, 0, MASK.cols * MASK_CELL, MASK.rows * MASK_CELL);

  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#3d8bff';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

let maskViewPending = false;
function maskPaintViewSoon() {
  if (maskViewPending) return;
  maskViewPending = true;
  requestAnimationFrame(() => { maskViewPending = false; maskPaintView(); });
}

/* Where the pointer is, in the image's own pixels. */
function maskPoint(e) {
  const r = MASK.canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * MASK.canvas.width,
    y: ((e.clientY - r.top) / r.height) * MASK.canvas.height,
  };
}

/* Lay the brush down at one point, in whole cells.
 *
 * A cell is either masked or it is not; there is no half. The cell under
 * the pointer always goes in, so the smallest brush still draws a
 * continuous line rather than dropping out whenever the pointer passes
 * near a cell's edge instead of its middle. */
function maskStamp(p) {
  const g = MASK.gctx;
  if (!g) return;
  g.globalCompositeOperation = MASK.mode === 'erase' ? 'destination-out' : 'source-over';
  g.fillStyle = '#fff';

  const rPx = MASK.pen / 2;
  const c0 = Math.max(0, Math.floor((p.x - rPx) / MASK_CELL));
  const c1 = Math.min(MASK.cols - 1, Math.floor((p.x + rPx) / MASK_CELL));
  const r0 = Math.max(0, Math.floor((p.y - rPx) / MASK_CELL));
  const r1 = Math.min(MASK.rows - 1, Math.floor((p.y + rPx) / MASK_CELL));

  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (!MASK.square) {
        const dx = (col + 0.5) * MASK_CELL - p.x;
        const dy = (row + 0.5) * MASK_CELL - p.y;
        if (dx * dx + dy * dy > rPx * rPx) continue;
      }
      g.fillRect(col, row, 1, 1);
    }
  }

  // The cell the pointer is actually in, whatever the arithmetic above
  // decided about its centre.
  const col = Math.floor(p.x / MASK_CELL);
  const row = Math.floor(p.y / MASK_CELL);
  if (col >= 0 && col < MASK.cols && row >= 0 && row < MASK.rows) {
    g.fillRect(col, row, 1, 1);
  }
  g.globalCompositeOperation = 'source-over';
}

function maskLine(a, b) {
  // Pointer events are sampled, not continuous, so a fast stroke arrives as
  // a handful of far-apart points. Filling between them is what makes a
  // drag a line rather than a row of dots. Half a cell is close enough to
  // leave no gap, and no closer, since anything finer is redrawing cells
  // that are already on.
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / Math.max(MASK_CELL / 2, MASK.pen / 4)));
  for (let i = 0; i <= steps; i++) {
    maskStamp({ x: a.x + (b.x - a.x) * (i / steps), y: a.y + (b.y - a.y) * (i / steps) });
  }
}

/* --- the brush cursor -------------------------------------------------

   A crosshair tells you where the brush is but not how big it is, and the
   picture is nearly always shown smaller than it really is, so "64" on a
   slider means nothing on screen. This is the actual footprint. */
let maskCursorAt = null;

function maskShowPen() {
  const label = mEl('maskPenVal');
  if (label) {
    const cells = Math.round(MASK.pen / MASK_CELL);
    label.textContent = `${MASK.pen} px`;
    label.title = `${cells} mask cell${cells === 1 ? '' : 's'} across `
      + `— NovelAI works in ${MASK_CELL}px blocks`;
  }
  const slider = mEl('maskPen');
  if (slider && Number(slider.value) !== MASK.pen) slider.value = String(MASK.pen);
  maskMoveCursor();
}

function maskSetPen(px) {
  MASK.pen = Math.max(MASK_PEN_MIN, Math.min(MASK_PEN_MAX,
    Math.round(px / MASK_PEN_STEP) * MASK_PEN_STEP));
  maskShowPen();
}

function maskMoveCursor() {
  const cur = mEl('maskCursor');
  if (!cur) return;
  if (!maskCursorAt || !MASK.canvas) { cur.hidden = true; return; }

  // Laid out inside the frame, which is what carries the zoom, so this uses
  // the frame's own unzoomed size: the ring is scaled by the same transform
  // as everything else in there and would otherwise be scaled twice.
  const scale = (MASK.canvas.offsetWidth || 1) / (MASK.canvas.width || 1);
  cur.hidden = false;
  cur.classList.toggle('square', MASK.square);
  cur.classList.toggle('erase', MASK.mode === 'erase');
  cur.style.width = `${MASK.pen * scale}px`;
  cur.style.height = `${MASK.pen * scale}px`;
  cur.style.left = `${maskCursorAt.x * scale}px`;
  cur.style.top = `${maskCursorAt.y * scale}px`;
}

/* --- zoom and pan -----------------------------------------------------

   A mask is painted in 8px blocks, and 8px on a 1216-tall picture shown at
   a third of its size is two pixels of screen. Anything careful - an eye, a
   hand, the edge of a sleeve - needs the picture bigger than the window.

   The zoom is a transform on the frame, which carries the image and the
   mask together, so nothing has to be re-registered: the pointer maths
   reads the canvas's rectangle from the browser and that rectangle already
   has the transform in it. */
const MASK_ZOOM_MIN = 1;
const MASK_ZOOM_MAX = 12;

function maskApplyView() {
  const frame = mEl('maskFrame');
  if (!frame) return;
  maskClampPan();
  frame.style.transform =
    `translate(${MASK.panX}px, ${MASK.panY}px) scale(${MASK.zoom})`;
  frame.style.transformOrigin = 'center center';
  const label = mEl('maskZoomVal');
  if (label) label.textContent = `${Math.round(MASK.zoom * 100)}%`;
  const reset = mEl('maskZoomReset');
  if (reset) reset.disabled = MASK.zoom === 1 && !MASK.panX && !MASK.panY;
}

/* Keep the picture within reach.
 *
 * Panning is in screen pixels about the centre, so the limit is however far
 * the zoomed picture hangs over the frame's own box. Without this the
 * picture can be dragged off the edge and there is no obvious way back. */
function maskClampPan() {
  const frame = mEl('maskFrame');
  if (!frame) return;
  const w = frame.offsetWidth;
  const h = frame.offsetHeight;
  const maxX = Math.max(0, (w * MASK.zoom - w) / 2);
  const maxY = Math.max(0, (h * MASK.zoom - h) / 2);
  MASK.panX = Math.max(-maxX, Math.min(maxX, MASK.panX));
  MASK.panY = Math.max(-maxY, Math.min(maxY, MASK.panY));
}

/* Zoom about a point on the screen, so what is under the pointer stays
   under the pointer. Zooming about the middle instead means hunting for the
   thing you were looking at after every step. */
function maskZoomAt(factor, clientX, clientY) {
  const frame = mEl('maskFrame');
  if (!frame) return;
  const before = MASK.zoom;
  const after = Math.max(MASK_ZOOM_MIN, Math.min(MASK_ZOOM_MAX, before * factor));
  if (after === before) return;

  const r = frame.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Where the anchor sits relative to the centre, unscaled.
  const dx = (clientX - cx - MASK.panX) / before;
  const dy = (clientY - cy - MASK.panY) / before;
  MASK.panX -= dx * (after - before);
  MASK.panY -= dy * (after - before);
  MASK.zoom = after;
  maskApplyView();
  maskMoveCursor();
}

function maskResetView() {
  MASK.zoom = 1;
  MASK.panX = 0;
  MASK.panY = 0;
  maskApplyView();
  maskMoveCursor();
}

function maskWire() {
  const canvas = mEl('maskCanvas');
  let last = null;

  const beginStroke = () => {
    MASK.strokes.push(MASK.gctx.getImageData(0, 0, MASK.cols, MASK.rows));
    if (MASK.strokes.length > 100) MASK.strokes.shift();
  };

  let panFrom = null;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    // Middle button, or space held: drag the picture rather than paint on
    // it. Both are what people already have in their fingers from every
    // other program that zooms.
    if (e.button === 1 || MASK.spaceDown) {
      panFrom = { x: e.clientX, y: e.clientY, panX: MASK.panX, panY: MASK.panY };
      return;
    }

    beginStroke();
    MASK.drawing = true;
    last = maskPoint(e);
    maskStamp(last);
    maskPaintViewSoon();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panFrom) {
      MASK.panX = panFrom.panX + (e.clientX - panFrom.x);
      MASK.panY = panFrom.panY + (e.clientY - panFrom.y);
      maskApplyView();
      return;
    }
    maskCursorAt = maskPoint(e);
    maskMoveCursor();
    if (!MASK.drawing) return;
    const p = maskCursorAt;
    maskLine(last, p);
    last = p;
    maskPaintViewSoon();
  });

  // Deliberately not pointerleave: the pointer is captured, so a stroke
  // that wanders past the edge and comes back is one stroke. Ending it at
  // the edge meant you could not paint up to the border in one go.
  const stop = () => {
    panFrom = null;
    if (!MASK.drawing) return;
    MASK.drawing = false;
    maskPaintView();
    maskUpdateHint();
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerenter', (e) => {
    maskCursorAt = maskPoint(e);
    maskMoveCursor();
  });
  canvas.addEventListener('pointerleave', () => {
    if (MASK.drawing) return;      // captured stroke, cursor stays
    maskCursorAt = null;
    maskMoveCursor();
  });

  // The wheel zooms, because that is what a wheel does over a picture.
  // The brush moved to Ctrl+wheel and to [ and ], which is the arrangement
  // every painting program uses and the one people arrive expecting.
  mEl('maskStage').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return maskSetPen(MASK.pen + (e.deltaY < 0 ? MASK_PEN_STEP : -MASK_PEN_STEP));
    }
    maskZoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  // Double-click puts it back, which is quicker than aiming at a button.
  mEl('maskStage').addEventListener('dblclick', (e) => {
    e.preventDefault();
    maskResetView();
  });
  mEl('maskZoomReset').addEventListener('click', maskResetView);
  mEl('maskZoomIn').addEventListener('click', () => maskZoomCentre(1.25));
  mEl('maskZoomOut').addEventListener('click', () => maskZoomCentre(1 / 1.25));

  // Panning with the middle button or a held space bar; the cursor says so.
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { MASK.spaceDown = false; mEl('maskFrame')?.classList.remove('panning'); }
  });

  mEl('maskPen').addEventListener('input', (e) => maskSetPen(Number(e.target.value)));
  mEl('maskSquare').addEventListener('change', (e) => {
    MASK.square = e.target.checked;
    maskMoveCursor();
  });

  mEl('maskBrush').addEventListener('click', () => maskSetMode('brush'));
  mEl('maskErase').addEventListener('click', () => maskSetMode('erase'));

  mEl('maskUndo').addEventListener('click', maskUndo);
  mEl('maskClear').addEventListener('click', () => {
    if (!MASK.gctx) return;
    beginStroke();
    MASK.gctx.clearRect(0, 0, MASK.cols, MASK.rows);
    maskPaintView();
    maskUpdateHint();
  });

  mEl('maskCancel').addEventListener('click', maskClose);
  mEl('maskSave').addEventListener('click', () => {
    if (!maskHasAnything()) return;
    const png = maskToPng();
    maskClose();
    if (MASK.onSave) MASK.onSave(png);
  });

  // The brush ring is sized against the picture as displayed, so it has to
  // be redrawn when the window changes shape.
  window.addEventListener('resize', maskMoveCursor);

  // Captured, because the gallery behind this window has its own Ctrl+Z
  // and would undo an image operation while someone is painting.
  document.addEventListener('keydown', maskKeys, true);
}

function maskSetMode(mode) {
  MASK.mode = mode;
  mEl('maskBrush').classList.toggle('active', mode === 'brush');
  mEl('maskErase').classList.toggle('active', mode === 'erase');
  maskMoveCursor();
}

function maskUndo() {
  const prev = MASK.strokes.pop();
  if (!prev) return;
  MASK.gctx.putImageData(prev, 0, 0);
  maskPaintView();
  maskUpdateHint();
}

function maskClose() {
  mEl('genMaskModal').hidden = true;
  maskCursorAt = null;
  maskMoveCursor();
}

function maskKeys(e) {
  if (mEl('genMaskModal')?.hidden !== false) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); return maskClose(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.stopPropagation(); e.preventDefault(); return maskUndo();
  }
  if (typing) return;

  if (e.key === '[') { e.stopPropagation(); return maskSetPen(MASK.pen - MASK_PEN_STEP); }
  if (e.key === ']') { e.stopPropagation(); return maskSetPen(MASK.pen + MASK_PEN_STEP); }
  if (e.key === 'b' || e.key === 'B') { e.stopPropagation(); return maskSetMode('brush'); }
  if (e.key === 'e' || e.key === 'E') { e.stopPropagation(); return maskSetMode('erase'); }

  if (e.code === 'Space') {
    e.stopPropagation(); e.preventDefault();
    MASK.spaceDown = true;
    mEl('maskFrame')?.classList.add('panning');
    return;
  }
  if (e.key === '+' || e.key === '=') { e.stopPropagation(); return maskZoomCentre(1.25); }
  if (e.key === '-' || e.key === '_') { e.stopPropagation(); return maskZoomCentre(1 / 1.25); }
  if (e.key === '0') { e.stopPropagation(); return maskResetView(); }
}

/* Zooming from a button or a key has no pointer to zoom about, so it uses
   the middle of the picture. */
function maskZoomCentre(factor) {
  const r = mEl('maskFrame')?.getBoundingClientRect();
  if (!r) return;
  maskZoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}

/* NovelAI wants an opaque black-and-white image, not something with holes
   in it: white where it may repaint, black everywhere else. The grid is
   blown back up by eight with no smoothing, so every edge lands on the
   block boundary NovelAI is going to snap it to anyway - what is sent
   survives its downscale unchanged, which is the whole point. */
function maskToPng() {
  const out = document.createElement('canvas');
  out.width = MASK.canvas.width;
  out.height = MASK.canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(MASK.grid, 0, 0, MASK.cols, MASK.rows,
    0, 0, MASK.cols * MASK_CELL, MASK.rows * MASK_CELL);
  return out.toDataURL('image/png');
}

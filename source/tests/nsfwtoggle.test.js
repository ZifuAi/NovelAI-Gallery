/* The NSFW toggle in the details panel, under the condition that actually
 * broke it: a background refresh happening between opening the image and
 * clicking the switch. That refresh replaces the list with freshly parsed
 * objects, so the open image is no longer the same object as the one in
 * the list - and patching only the list left the switch showing its old
 * state until the window was closed and reopened.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
// Built by tests/run.sh. Override with NAG_BIN to test a different build.
const NAG_BIN = process.env.NAG_BIN || path.join(REPO, 'app', 'nag-dev');
const SEED_PY = path.join(__dirname, 'seed.py');
const SHOTS = path.join(__dirname, 'screenshots');
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'); const os = require('os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nag-tog-'));
const SEED = path.join(DATA, 'seed');
execFileSync('python3', [SEED_PY, SEED]);
const server = spawn(NAG_BIN, [], { env: { ...process.env, NOVELAI_GALLERY_DATA: DATA }, stdio: ['ignore','pipe','pipe'] });
let BASE = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, d) => { console.log(`${ok?'PASS':'FAIL'}  ${n}${ok||!d?'':`\n        ${d}`}`); if (!ok) failures++; };

(async () => {
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no start')), 15000);
    const scan = (b) => { const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); BASE = m[0]; res(); } };
    server.stdout.on('data', scan); server.stderr.on('data', scan);
  });
  for (const f of fs.readdirSync(SEED)) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(SEED, f))]), f);
    await fetch(`${BASE}api/images`, { method: 'POST', body: form });
  }
  const s0 = await fetch(`${BASE}api/settings`).then(r => r.json());
  await fetch(`${BASE}api/settings`, { method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ ...s0, onboarded: true }) });
  const imgs = (await fetch(`${BASE}api/images?limit=20`).then(r=>r.json())).items;
  const safe = imgs.find((i) => !i.nsfwAuto);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.card'); await sleep(900);

  const openImage = async (id) => {
    // Click the corner, away from the hover toolbar the card grows.
    await page.locator(`.card[data-id="${id}"]`).click({ position: { x: 8, y: 60 } });
    await page.locator('#lightbox').waitFor({ state: 'visible' });
    await sleep(700);
  };
  const toggle = () => page.locator('#nsfwToggle');
  const isOn = () => toggle().isChecked();
  const knob = () => page.locator('#nsfwToggle + .switch-track .switch-knob')
    .evaluate((n) => getComputedStyle(n).transform);
  const sub = () => page.locator('.nsfw-row-sub').textContent();

  await openImage(safe.id);
  check('a safe image opens with the switch off', (await isOn()) === false);
  check('and says the state came from the classifier',
    (await sub()).includes('automatically'));

  // The condition that broke it: force a background refresh while the
  // image is open, so the list is rebuilt out from under it.
  // The refresh button is behind the lightbox, so this calls the same
  // thing the periodic background refresh calls.
  await page.evaluate(() => load({ reset: true, silent: true }));
  await sleep(1400);
  check('the switch survives a refresh while open', (await isOn()) === false);

  // Now the actual complaint.
  const before = await knob();
  await page.click('#nsfwToggle + .switch-track');
  await sleep(900);

  check('clicking marks it on straight away, with no reopening',
    (await isOn()) === true, 'the switch snapped back to off');
  check('and the knob moves with it', (await knob()) !== before);
  check('and the wording changes to say you set it', (await sub()).includes('Set by you'),
    await sub());

  // The gallery behind it has to agree.
  check('the card behind is covered now',
    await page.locator(`.card[data-id="${safe.id}"] .nsfw-cover`).count() === 1);

  // And back off again, still without reopening.
  await page.click('#nsfwToggle + .switch-track');
  await sleep(900);
  check('clicking again turns it off straight away', (await isOn()) === false);
  check('and uncovers the card behind',
    await page.locator(`.card[data-id="${safe.id}"] .nsfw-cover`).count() === 0);

  // Reopening must show the same thing the switch just showed.
  await page.keyboard.press('Escape'); await sleep(500);
  await openImage(safe.id);
  check('reopening agrees with what the switch showed', (await isOn()) === false);
  check('and it is remembered as a manual choice', (await sub()).includes('Set by you'));

  // Reset to automatic, from the right-click menu.
  await page.keyboard.press('Escape'); await sleep(500);
  await page.locator(`.card[data-id="${safe.id}"]`).click({ button: 'right' });
  await sleep(400);
  const reset = page.locator('#ctxMenu .ctx-item', { hasText: 'automatic' });
  if (await reset.count()) {
    await reset.first().click();
    await sleep(900);
    await openImage(safe.id);
    check('resetting hands it back to the classifier',
      (await sub()).includes('automatically') && (await isOn()) === false);
  }

  // Colour labels went through the same stale-copy path.
  await page.keyboard.press('Escape'); await sleep(400);
  await openImage(safe.id);
  await page.evaluate(() => load({ reset: true, silent: true }));
  await sleep(1400);
  await page.locator('.color-pick[data-color="#ff6b6b"]').click();
  await sleep(900);
  check('a colour label also applies without reopening',
    await page.locator('.color-pick[data-color="#ff6b6b"].active').count() === 1);
  check('and the card behind shows the dot',
    await page.locator(`.card[data-id="${safe.id}"] .card-color`).count() === 1);

  // --- the colour filter can be cleared without opening the menu -------
  await page.keyboard.press('Escape'); await sleep(400);
  await page.click('#viewMenuBtn'); await sleep(350);
  await page.locator('#viewMenu [data-color="#ff6b6b"]').click();
  await sleep(800);
  check('filtering by colour narrows the gallery',
    await page.locator('.card').count() === 1);
  check('and a clear button appears on the toolbar',
    await page.locator('#viewMenuClear').isVisible());
  await page.click('#viewMenuClear');
  await sleep(800);
  check('clicking it clears the filter without opening the menu',
    await page.locator('.card').count() === 6 &&
    !(await page.locator('#viewMenu').isVisible()));
  check('and the clear button goes away with the filter',
    !(await page.locator('#viewMenuClear').isVisible()));

  // --- the grid loads thumbnails, the large view loads the original ----
  const thumbReqs = [];
  const fileReqs = [];
  page.on('request', (r) => {
    if (/\/api\/images\/[^/]+\/thumb$/.test(r.url())) thumbReqs.push(r.url());
    if (/\/api\/images\/[^/]+\/file$/.test(r.url())) fileReqs.push(r.url());
  });
  await page.reload();
  await page.waitForSelector('.card');
  await sleep(1500);
  check('every grid tile asks for a thumbnail', thumbReqs.length >= 6,
    `${thumbReqs.length} thumb requests`);
  check('and the grid alone pulls no full-size images', fileReqs.length === 0,
    fileReqs.join(', '));

  await openImage(safe.id);
  check('opening an image loads the original, not the thumbnail',
    fileReqs.length === 1, `${fileReqs.length} file requests`);

  // The seeded images here are small flat PNGs, so bytes saved is not a
  // fair measure on them - the Go test covers that with realistic image
  // content. What matters in the browser is the property that holds for
  // any input: the tile decodes a capped, correctly-shaped bitmap.
  const dims = await page.evaluate((id) => new Promise((res) => {
    const t = new Image(), f = new Image();
    let left = 2;
    const done = () => { if (--left === 0) res({
      tw: t.naturalWidth, th: t.naturalHeight,
      fw: f.naturalWidth, fh: f.naturalHeight }); };
    t.onload = done; f.onload = done;
    t.src = `/api/images/${id}/thumb`;
    f.src = `/api/images/${id}/file`;
  }), safe.id);
  check('the thumbnail is capped at 640px on its longest edge',
    Math.max(dims.tw, dims.th) <= 640, JSON.stringify(dims));
  check('and keeps the original aspect ratio',
    Math.abs((dims.tw / dims.th) - (dims.fw / dims.fh)) < 0.01, JSON.stringify(dims));

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close(); server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})().catch((e) => { server.kill(); throw e; });

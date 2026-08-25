/* Full-app regression against the real Go backend.
 *
 * Everything here drives the shipped UI against a real store with real
 * images, because the pieces most likely to break - folder nesting, colour
 * labels, undo, the view menu, the settings tabs - are the ones whose
 * server and browser halves have to agree.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
// Built by tests/run.sh. Override with NAG_BIN to test a different build.
const NAG_BIN = process.env.NAG_BIN || path.join(REPO, 'app', 'nag-dev');
const SEED_PY = path.join(__dirname, 'seed.py');
const SHOTS = path.join(__dirname, 'screenshots');
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

/* A fresh app per run. Reusing a library between runs makes a failure here
   mean "some earlier run left something behind" as often as it means a real
   regression, which is worse than no test. */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nag-run-'));
const SEED = path.join(DATA, 'seed');
execFileSync('python3', [SEED_PY, SEED]);

const server = spawn(NAG_BIN, [], {
  env: { ...process.env, NOVELAI_GALLERY_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let BASE = '';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForServer = () => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('the app never started')), 15000);
  const scan = (buf) => {
    const m = String(buf).match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) { clearTimeout(t); BASE = m[0]; resolve(); }
  };
  server.stdout.on('data', scan);
  server.stderr.on('data', scan);
});

(async () => {
  await waitForServer();

  // Seed through the real capture path, so the images arrive exactly the
  // way the extension delivers them.
  for (const f of fs.readdirSync(SEED)) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(SEED, f))]), f);
    await fetch(`${BASE}api/images`, { method: 'POST', body: form });
  }
  // Onboarding is its own flow with its own tests; it would sit on top of
  // everything here.
  const s0 = await fetch(`${BASE}api/settings`).then((r) => r.json());
  await fetch(`${BASE}api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...s0, onboarded: true }),
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message}`));
  // A failed request is worth knowing about, but "which one" is the part
  // that makes it actionable, so responses are recorded by URL and status.
  const badResponses = [];
  page.on('response', (r) => {
    // 304 is a cache hit, which is the browser working, not a failure.
    if (r.status() >= 400 && r.url().includes('/api/')) {
      badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`);
    }
  });
  page.on('console', (m) => {
    // The browser logs every non-2xx fetch; the response listener above
    // covers those with more detail, so they're not counted twice.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });

  const api = (p, opts) => page.evaluate(
    ([p, opts]) => fetch(p, opts).then((r) => r.json()), [p, opts]);

  await page.goto(BASE);
  await page.waitForSelector('.card', { timeout: 10000 });
  await sleep(900);

  // --- the gallery ------------------------------------------------------
  // Six of the seven: the explicit one is on the NSFW shelf, which is where
  // the filter puts it rather than leaving it in with everything else.
  check('every seeded image is on screen except the flagged one',
    await page.locator('.card').count() === 6,
    `${await page.locator('.card').count()} cards`);
  check('no page errors on first load', errors.length === 0, errors.join('\n        '));

  // Aspect ratios must survive the layout: the 1600x600 image has to be
  // wider than it is tall on screen too.
  const boxes = await page.locator('.card img').evaluateAll((imgs) =>
    imgs.map((i) => {
      const r = i.getBoundingClientRect();
      return { nat: i.naturalWidth / i.naturalHeight, shown: r.width / r.height };
    }));
  const skewed = boxes.filter((b) => b.nat && Math.abs(b.nat - b.shown) / b.nat > 0.04);
  check('images keep their aspect ratio in the grid', skewed.length === 0,
    JSON.stringify(skewed));

  // --- explicit content -------------------------------------------------
  // Its own shelf in the sidebar, red, and only there while the filter is.
  check('the NSFW shelf is offered while the filter is on',
    await page.locator('#navNsfw').isVisible());
  check('and says how many are on it',
    (await page.locator('#countNsfw').textContent()).trim() === '1',
    await page.locator('#countNsfw').textContent());
  check('while All images counts only the rest',
    (await page.locator('#countAll').textContent()).trim() === '6',
    await page.locator('#countAll').textContent());
  check('and the shelf is labelled in red',
    await page.locator('#navNsfw .nav-label').evaluate(
      (n) => getComputedStyle(n).color) !== await page.locator(
      '.nav-item[data-view="all"] .nav-label').evaluate((n) => getComputedStyle(n).color));

  await page.click('#navNsfw'); await sleep(800);
  check('the flagged image is on the shelf', await page.locator('.card').count() === 1);
  check('exactly the explicit image is covered',
    await page.locator('.card .nsfw-cover').count() === 1);
  await page.locator('.card .nsfw-reveal').first().click();
  await sleep(500);
  check('Reveal uncovers it',
    await page.locator('.card .nsfw-cover').count() === 0);

  // Turning the filter off puts everything back together and takes the
  // shelf away with it.
  await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(await api('/api/settings')), flagNsfw: false }),
  });
  await page.reload(); await page.waitForSelector('.card'); await sleep(900);
  check('with the filter off the shelf is gone',
    await page.locator('#navNsfw').isHidden());
  check('and everything is back in All images',
    await page.locator('.card').count() === 7,
    `${await page.locator('.card').count()} cards`);
  await api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(await api('/api/settings')), flagNsfw: true }),
  });
  await page.reload(); await page.waitForSelector('.card'); await sleep(900);
  await page.click('#navNsfw'); await sleep(700);
  await page.locator('.card .nsfw-reveal').first().click();
  await sleep(400);
  await page.click('.nav-item[data-view="all"]'); await sleep(700);

  // --- layouts ----------------------------------------------------------
  for (const layout of ['justified', 'grid', 'list', 'waterfall']) {
    await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(await api('/api/settings')), layout }),
    });
    await page.reload();
    await page.waitForSelector('.card', { timeout: 8000 });
    await sleep(700);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const visible = await page.locator('.card').count();
    // Six, not seven: the flagged one is on the NSFW shelf.
    check(`${layout}: all images laid out, nothing overflows sideways`,
      visible === 6 && overflow <= 1, `cards=${visible} overflowX=${overflow}`);
  }

  // --- nested folders ---------------------------------------------------
  const parent = await api('/api/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Characters' }),
  });
  const child = await api('/api/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Portraits', parentId: parent.id }),
  });
  const grand = await api('/api/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Close-ups', parentId: child.id }),
  });
  await page.reload();
  await page.waitForSelector('.card', { timeout: 8000 });
  await sleep(700);

  // Depth is expressed as indentation, so that is what gets checked: a
  // tree that reads as flat to the eye is broken however the data looks.
  const depths = await page.locator('#folderList .folder-row').evaluateAll((rows) =>
    rows.map((r) => ({
      name: r.querySelector('.nav-label').textContent.trim(),
      pad: parseFloat(getComputedStyle(r).paddingLeft),
    })));
  const pad = (n) => depths.find((d) => d.name === n)?.pad;
  check('a folder can be nested three deep, and is indented like it',
    pad('Characters') < pad('Portraits') && pad('Portraits') < pad('Close-ups'),
    JSON.stringify(depths));

  // Counts roll up: an image in the deepest folder counts for its parents.
  const items = (await api('/api/images?limit=20')).items;
  await api(`/api/images/${items[0].id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folders: [grand.id] }),
  });
  const tree = await api('/api/folders');
  const byName = Object.fromEntries(tree.map((f) => [f.name, f]));
  check('counts roll up from a subfolder to its parents',
    byName['Characters'].count === 1 && byName['Portraits'].count === 1 && byName['Close-ups'].count === 1,
    JSON.stringify(tree.map((f) => [f.name, f.count])));

  // A folder cannot be moved inside itself; that would detach the branch.
  const cycle = await api(`/api/folders/${parent.id}/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: grand.id }),
  });
  const after = await api('/api/folders');
  check('a folder cannot be dragged into its own descendant',
    after.find((f) => f.id === parent.id).parentId === '' ||
    after.find((f) => f.id === parent.id).parentId === undefined,
    JSON.stringify(cycle));

  // --- renaming, and undo -----------------------------------------------
  await api(`/api/folders/${child.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Headshots' }),
  });
  check('a folder can be renamed',
    (await api('/api/folders')).some((f) => f.name === 'Headshots'));

  await api('/api/undo', { method: 'POST' });
  check('undo puts the old name back',
    (await api('/api/folders')).some((f) => f.name === 'Portraits'));
  await api('/api/redo', { method: 'POST' });
  check('redo applies it again',
    (await api('/api/folders')).some((f) => f.name === 'Headshots'));

  // --- deleting an image is undoable ------------------------------------
  const victim = items[1];
  await page.evaluate((id) => fetch(`/api/images/${id}`, { method: 'DELETE' }), victim.id);
  check('an image can be deleted', (await api('/api/images?limit=20')).total === 6);
  await api('/api/undo', { method: 'POST' });
  const restored = await api('/api/images?limit=20');
  check('undo brings the deleted image back', restored.total === 7);
  const back = restored.items.find((i) => i.id === victim.id);
  const png = await page.evaluate((id) => fetch(`/api/images/${id}/file`).then((r) => r.status), victim.id);
  check('and its file is back on disk too, not just its record', !!back && png === 200,
    `record=${!!back} file=${png}`);

  // --- colour labels are per image --------------------------------------
  await api(`/api/images/${items[2].id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color: '#ff6b6b' }),
  });
  const counts = await api('/api/colors');
  check('a colour label counts against the image that has it',
    (counts.counts || {})['#ff6b6b'] === 1, JSON.stringify(counts));
  const filtered = await api('/api/images?limit=20&color=%23ff6b6b');
  check('the gallery can be filtered to one colour', filtered.total === 1);

  // --- the view menu ----------------------------------------------------
  await page.reload();
  await page.waitForSelector('.card', { timeout: 8000 });
  await sleep(600);
  await page.click('#viewMenuBtn');
  await sleep(300);
  check('the view menu opens', await page.locator('#viewMenu').isVisible());
  check('it holds every sort option',
    (await page.locator('#viewMenu [data-sort]').count()) >= 4);
  // Only colours actually in use are offered - a wall of unused swatches
  // would be noise - so with one labelled image that means All + that one.
  check('and the colour filters, limited to colours in use',
    (await page.locator('#viewMenu [data-color]').count()) === 2,
    await page.locator('#viewMenu').innerHTML());
  await page.keyboard.press('Escape');
  await sleep(250);
  check('Escape closes it', !(await page.locator('#viewMenu').isVisible()));

  // --- the settings tabs ------------------------------------------------
  await page.click('#toolsSettingsBtn');
  await sleep(400);
  const tabs = await page.locator('.settings-tab').allTextContents();
  check('settings is split into four tabs', tabs.length === 4, tabs.join(', '));
  for (const t of ['appearance', 'library', 'capture', 'about']) {
    await page.click(`.settings-tab[data-tab="${t}"]`);
    await sleep(250);
    const shown = await page.locator(`.settings-pane[data-pane="${t}"]`).isVisible();
    const others = await page.locator('.settings-pane:visible').count();
    check(`the ${t} tab shows its own pane and only its own`, shown && others === 1);
  }
  check('About knows which build this is',
    (await page.locator('#aboutVersion').textContent()).trim() === 'Build 1.2.1');

  await page.keyboard.press('Escape');
  await sleep(300);

  // --- the sidebar resizes ---------------------------------------------
  const before = await page.locator('.sidebar').evaluate((n) => n.getBoundingClientRect().width);
  const handle = await page.locator('#sidebarResizer').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 90, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(600);
  const widened = await page.locator('.sidebar').evaluate((n) => n.getBoundingClientRect().width);
  check('the sidebar can be dragged wider', widened > before + 60,
    `${Math.round(before)} -> ${Math.round(widened)}`);
  await page.reload();
  await page.waitForSelector('.card', { timeout: 8000 });
  await sleep(700);
  const kept = await page.locator('.sidebar').evaluate((n) => n.getBoundingClientRect().width);
  check('and the width is remembered', Math.abs(kept - widened) < 6,
    `${Math.round(widened)} -> ${Math.round(kept)}`);

  // --- refreshing an empty view must not flicker ------------------------
  await page.click('.nav-item[data-view="pinned"], [data-view="pinned"]').catch(() => {});
  await sleep(600);
  const html1 = await page.locator('#content').innerHTML();
  await page.click('#refreshBtn');
  await sleep(1200);
  const html2 = await page.locator('#content').innerHTML();
  check('an unchanged empty view is not rewritten on refresh', html1 === html2);

  check('no page errors across the whole run', errors.length === 0,
    errors.slice(0, 5).join('\n        '));
  // The only request expected to fail is the deliberate attempt to drag a
  // folder into its own descendant, which the server is right to refuse.
  const unexpected = badResponses.filter((r) => !/^400 \/api\/folders\/.*\/move$/.test(r));
  check('no unexpected request failures', unexpected.length === 0, unexpected.join(', '));

  await browser.close();
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})().catch((e) => { server.kill(); throw e; });

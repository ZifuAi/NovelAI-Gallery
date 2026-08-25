/* Folders, driven entirely through the interface.
 *
 * The previous suite created folders by calling the API, which is exactly
 * why it missed that the button calling createFolder() had no
 * createFolder() to call. Everything here goes through clicks and typing.
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

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nag-fold-'));
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

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  // If a native dialog ever appears again, fail loudly instead of hanging.
  let nativeDialogs = 0;
  page.on('dialog', async (d) => { nativeDialogs++; await d.dismiss(); });

  await page.goto(BASE);
  await page.waitForSelector('.card'); await sleep(900);

  const folderNames = () => page.locator('#folderList .folder-row .nav-label').allTextContents();
  // Folders are made and edited in one properties window now: name, colour,
  // tags and the NSFW flag together, rather than a rename box with three
  // menu entries beside it that nobody found.
  const typeAndConfirm = async (text) => {
    await page.fill('#folderPropsName', text);
    await page.click('#folderPropsOk');
    await sleep(700);
  };

  // --- creating a top-level folder --------------------------------------
  await page.click('#addFolderBtn');
  await sleep(400);
  check('the + button opens the app’s own dialog, not the browser’s',
    await page.locator('#folderModal').isVisible() && nativeDialogs === 0);
  check('the dialog says what it is for',
    (await page.locator('#folderPropsTitle').textContent()).trim() === 'New folder');
  check('and its name box is focused ready to type',
    await page.evaluate(() => document.activeElement?.id === 'folderPropsName'));
  check('with the colour and NSFW choices there from the start',
    await page.locator('#folderPropsColors .fp-swatch').count() > 1 &&
    await page.locator('#folderPropsNsfw').count() === 1);

  await typeAndConfirm('Characters');
  check('a folder is actually created', (await folderNames()).includes('Characters'),
    JSON.stringify(await folderNames()));

  // --- Enter submits, Escape cancels -------------------------------------
  await page.click('#addFolderBtn'); await sleep(350);
  await page.fill('#folderPropsName', 'Landscapes');
  await page.keyboard.press('Enter');
  await sleep(700);
  check('Enter creates it too', (await folderNames()).includes('Landscapes'));

  await page.click('#addFolderBtn'); await sleep(350);
  await page.fill('#folderPropsName', 'Never made');
  await page.keyboard.press('Escape');
  await sleep(500);
  check('Escape cancels without creating anything',
    !(await folderNames()).includes('Never made') && !(await page.locator('#folderModal').isVisible()));

  // --- a duplicate name is explained in place ----------------------------
  await page.click('#addFolderBtn'); await sleep(350);
  await page.fill('#folderPropsName', 'Characters');
  await page.click('#folderPropsOk');
  await sleep(700);
  check('a duplicate name is refused',
    await page.locator('#folderModal').isVisible() &&
    await page.locator('#folderPropsError').isVisible());
  check('and the dialog stays open with what you typed still there',
    (await page.inputValue('#folderPropsName')) === 'Characters');
  await page.fill('#folderPropsName', 'Portraits');
  await page.click('#folderPropsOk'); await sleep(700);
  check('correcting it works without starting over',
    (await folderNames()).includes('Portraits') && !(await page.locator('#folderModal').isVisible()));

  // --- subfolders, through the right-click menu --------------------------
  const row = (name) => page.locator('#folderList .folder-row', { hasText: name }).first();
  await row('Characters').click({ button: 'right' });
  await sleep(400);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'New subfolder' }).click();
  await sleep(400);
  check('the subfolder dialog names its parent',
    (await page.locator('#folderPropsSub').textContent()).includes('Characters'),
    await page.locator('#folderPropsSub').textContent());
  await typeAndConfirm('Headshots');

  const names = await folderNames();
  check('the subfolder is created', names.includes('Headshots'), JSON.stringify(names));

  const pad = async (name) => parseFloat(await row(name).evaluate((n) => getComputedStyle(n).paddingLeft));
  check('and it is indented under its parent', (await pad('Headshots')) > (await pad('Characters')));

  // Nesting again, one deeper.
  await row('Headshots').click({ button: 'right' }); await sleep(400);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'New subfolder' }).click();
  await sleep(400);
  await typeAndConfirm('Close-ups');
  check('a subfolder can have a subfolder',
    (await folderNames()).includes('Close-ups') &&
    (await pad('Close-ups')) > (await pad('Headshots')));

  // A duplicate is only a duplicate among siblings.
  await row('Portraits').click({ button: 'right' }); await sleep(400);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'New subfolder' }).click();
  await sleep(400);
  await typeAndConfirm('Headshots');
  check('the same name is allowed in a different parent',
    (await page.locator('#folderList .folder-row .nav-label', { hasText: 'Headshots' }).count()) === 2 &&
    !(await page.locator('#folderModal').isVisible()));

  // --- properties: renaming ----------------------------------------------
  await row('Landscapes').click({ button: 'right' }); await sleep(400);
  check('the menu offers properties rather than only a rename',
    await page.locator('#ctxMenu .ctx-item', { hasText: 'Properties' }).count() === 1);
  check('and rename is no longer a separate entry',
    await page.locator('#ctxMenu .ctx-item', { hasText: /^Rename/ }).count() === 0);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'Properties' }).click();
  await sleep(400);
  check('properties opens with the current name filled in',
    (await page.inputValue('#folderPropsName')) === 'Landscapes');
  await typeAndConfirm('Scenery');
  check('renaming works', (await folderNames()).includes('Scenery') &&
    !(await folderNames()).includes('Landscapes'));

  // Double-click opens it too, the way a file manager does.
  await row('Scenery').dblclick();
  await sleep(500);
  check('double-clicking a folder opens its properties',
    await page.locator('#folderModal').isVisible() &&
    (await page.inputValue('#folderPropsName')) === 'Scenery');
  await page.keyboard.press('Escape'); await sleep(400);

  // --- properties: tags ---------------------------------------------------
  await row('Scenery').click({ button: 'right' }); await sleep(400);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'Properties' }).click();
  await sleep(400);
  await page.fill('#folderPropsTags', 'outdoors, reference');
  await page.click('#folderPropsOk'); await sleep(700);
  const tags = await fetch(`${BASE}api/folders`).then(r => r.json());
  const scenery = tags.find((f) => f.name === 'Scenery');
  check('tags are saved', JSON.stringify(scenery.tags) === '["outdoors","reference"]',
    JSON.stringify(scenery.tags));
  check('and the row shows it carries tags',
    await row('Scenery').locator('.tag-mark').count() === 1);

  // Clearing them is a real answer, not an empty form.
  await row('Scenery').click({ button: 'right' }); await sleep(400);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'Properties' }).click();
  await sleep(400);
  await page.fill('#folderPropsTags', '');
  await page.click('#folderPropsOk'); await sleep(700);
  const cleared = (await fetch(`${BASE}api/folders`).then(r => r.json())).find((f) => f.name === 'Scenery');
  check('and an empty box clears them rather than being ignored',
    (cleared.tags || []).length === 0 && !(await page.locator('#folderModal').isVisible()));

  // --- undo covers all of it ---------------------------------------------
  await page.keyboard.press('Control+z'); await sleep(800);
  const back = (await fetch(`${BASE}api/folders`).then(r => r.json())).find((f) => f.name === 'Scenery');
  check('undo brings the tags back', (back.tags || []).length === 2, JSON.stringify(back.tags));

  // --- what a folder passes on to what is filed in it ---------------------
  //
  // The point of setting a colour and an NSFW flag on the folder is that
  // every picture in it takes them, so they do not have to be set one at a
  // time - and that what arrives later takes them too.
  const someImages = (await fetch(`${BASE}api/images?limit=3`).then(r => r.json())).items.map((i) => i.id);
  await fetch(`${BASE}api/images/bulk`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', ids: someImages,
      addFolders: [tags.find((f) => f.name === 'Scenery').id] }),
  });
  await page.reload(); await page.waitForSelector('.card'); await sleep(900);

  await row('Scenery').click({ button: 'right' }); await sleep(400);
  await page.locator('#ctxMenu .ctx-item', { hasText: 'Properties' }).click();
  await sleep(400);
  await page.locator('#folderPropsColors .fp-swatch:not(.fp-none)').first().click();
  // The checkbox itself is under the switch; click what a person clicks.
  await page.locator('.fp-nsfw .switch-track').click();
  await page.click('#folderPropsOk'); await sleep(1200);

  const afterProps = await fetch(`${BASE}api/folders`).then(r => r.json());
  const sceneryNow = afterProps.find((f) => f.name === 'Scenery');
  check('the folder keeps its colour', !!sceneryNow.color, JSON.stringify(sceneryNow));
  check('and its NSFW flag', sceneryNow.nsfw === true);
  check('the row shows both', await row('Scenery').locator('.folder-dot').count() === 1 &&
    await row('Scenery').locator('.folder-nsfw').count() === 1);

  const inFolder = await fetch(`${BASE}api/images?limit=20&folder=${sceneryNow.id}`)
    .then(r => r.json());
  check('every image in the folder took the colour',
    inFolder.items.length === 3 && inFolder.items.every((i) => i.color === sceneryNow.color),
    JSON.stringify(inFolder.items.map((i) => i.color)));
  check('and every one of them is marked NSFW',
    inFolder.items.every((i) => i.nsfwManual === true),
    JSON.stringify(inFolder.items.map((i) => i.nsfwManual)));

  // Something filed in afterwards takes them as well.
  const later = (await fetch(`${BASE}api/images?limit=20`).then(r => r.json()))
    .items.find((i) => !someImages.includes(i.id) && i.color !== sceneryNow.color);
  await fetch(`${BASE}api/images/bulk`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', ids: [later.id], addFolders: [sceneryNow.id] }),
  });
  await sleep(400);
  const joined = (await fetch(`${BASE}api/images/${later.id}`).then(r => r.json()));
  check('an image filed there later inherits them too',
    joined.color === sceneryNow.color && joined.nsfwManual === true,
    JSON.stringify({ color: joined.color, nsfw: joined.nsfwManual }));

  check('no native browser dialogs anywhere', nativeDialogs === 0);
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  await page.click('#addFolderBtn'); await sleep(450);
  await page.screenshot({ path: path.join(SHOTS, 'fix-newfolder.png') });
  await page.keyboard.press('Escape'); await sleep(300);

  await browser.close(); server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})().catch((e) => { server.kill(); throw e; });

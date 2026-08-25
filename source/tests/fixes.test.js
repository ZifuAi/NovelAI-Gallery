/* The three things reported: the "no colour filter" option reading as a
 * grey swatch, the NSFW toggle never looking on, and the settings window
 * resizing itself as you move between tabs.
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

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nag-fix-'));
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
  await fetch(`${BASE}api/images/${imgs[0].id}`, { method: 'PATCH',
    headers: {'Content-Type':'application/json'}, body: JSON.stringify({ color: '#ff6b6b' }) });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.card'); await sleep(900);

  // --- 1. the "no colour filter" option --------------------------------
  await page.click('#viewMenuBtn'); await sleep(350);
  const anyColour = page.locator('#viewMenu [data-color=""]');
  check('"no colour filter" is a labelled row, not a bare swatch',
    (await anyColour.textContent()).trim().includes('Any colour'));
  check('it is as wide as the sort options above it, so it reads as one of them',
    Math.abs(
      (await anyColour.evaluate((n) => n.getBoundingClientRect().width)) -
      (await page.locator('#viewMenu [data-sort]').first().evaluate((n) => n.getBoundingClientRect().width))
    ) < 2);
  check('and it is ticked while no colour filter is on',
    (await anyColour.textContent()).includes('✓'));

  // Picking a colour moves the tick off it, and picking it again clears.
  await page.locator('#viewMenu [data-color="#ff6b6b"]').click();
  await sleep(700);
  await page.click('#viewMenuBtn'); await sleep(350);
  check('choosing a colour un-ticks "Any colour"',
    !(await page.locator('#viewMenu [data-color=""]').textContent()).includes('✓'));
  check('and the gallery is filtered to it',
    await page.locator('.card').count() === 1);
  await page.locator('#viewMenu [data-color=""]').click();
  await sleep(700);
  // Six, not seven: the flagged image is on the NSFW shelf, not in All
  // images, which is where the filter puts it.
  check('choosing it again clears the filter', await page.locator('.card').count() === 6,
    `${await page.locator('.card').count()} cards`);

  // --- 2. the NSFW toggle -----------------------------------------------
  // The flagged image lives on the NSFW shelf now rather than in All
  // images, so that is where it has to be looked at.
  await page.click('#navNsfw'); await sleep(800);
  const explicit = imgs.find((i) => i.nsfwAuto);
  await page.evaluate((id) => {
    document.querySelector(`.card[data-id="${id}"] img`)?.click();
  }, explicit.id).catch(() => {});
  await page.locator(`.card[data-id="${explicit.id}"]`).click({ position: { x: 10, y: 10 } }).catch(() => {});
  await sleep(900);

  const track = page.locator('#nsfwToggle + .switch-track');
  const knobShift = () => track.locator('.switch-knob').evaluate((n) => getComputedStyle(n).transform);
  const trackBg = () => track.evaluate((n) => getComputedStyle(n).backgroundColor);

  const onBg = await trackBg();
  const onKnob = await knobShift();
  check('an explicit image shows its NSFW switch as on',
    onKnob !== 'none' && onKnob !== 'matrix(1, 0, 0, 1, 0, 0)', `knob transform: ${onKnob}`);

  await page.click('#nsfwToggle + .switch-track');
  await sleep(900);
  const offBg = await trackBg();
  const offKnob = await knobShift();
  check('turning it off actually moves the knob back',
    offKnob === 'none' || offKnob === 'matrix(1, 0, 0, 1, 0, 0)', `knob transform: ${offKnob}`);
  check('and the track changes colour with it', onBg !== offBg, `${onBg} vs ${offBg}`);

  await page.click('#nsfwToggle + .switch-track');
  await sleep(900);
  check('turning it back on moves it again', (await knobShift()) === onKnob);

  // The switches in Settings must not have regressed while fixing this.
  await page.keyboard.press('Escape'); await sleep(400);
  await page.click('#toolsSettingsBtn'); await sleep(400);
  await page.click('.settings-tab[data-tab="library"]'); await sleep(400);
  const nsfwSetting = page.locator('#nsfwSwitch .switch-input');
  const settingKnob = () => page.locator('#nsfwSwitch .switch-knob').evaluate((n) => getComputedStyle(n).transform);
  const before = await settingKnob();
  await page.click('#nsfwSwitch .switch-track');
  await sleep(1200);
  check('the switches in Settings still respond too', (await settingKnob()) !== before);
  await page.click('#nsfwSwitch .switch-track');
  await sleep(1200);

  // --- 2b. putting the cover back --------------------------------------
  {
    await page.keyboard.press('Escape'); await sleep(500);
    const cardSel = `.card[data-id="${explicit.id}"]`;
    // Start from a known state: reload so nothing is revealed, then back
    // to the shelf the flagged image is kept on.
    await page.reload(); await page.waitForSelector('.card'); await sleep(900);
    await page.click('#navNsfw'); await sleep(800);
    check('the flagged image starts covered',
      await page.locator(`${cardSel} .nsfw-cover`).count() === 1);
    check('and shows no un-hide button while it is covered',
      await page.locator(`${cardSel} .nsfw-hide`).count() === 0);

    await page.locator(`${cardSel} .nsfw-reveal`).click();
    await sleep(500);
    check('revealing offers a way to hide it again',
      await page.locator(`${cardSel} .nsfw-cover`).count() === 0 &&
      await page.locator(`${cardSel} .nsfw-hide`).count() === 1);

    await page.locator(`${cardSel} .nsfw-hide`).click({ force: true });
    await sleep(500);
    check('and that button puts the cover back',
      await page.locator(`${cardSel} .nsfw-cover`).count() === 1);

    // The other images must not have been touched by any of that.
    check('only that one image was affected',
      await page.locator('.card .nsfw-cover').count() === 1 &&
      await page.locator('.card .nsfw-hide').count() === 0);

    // And it survives a background refresh, which is where the fingerprint
    // bug lived last time.
    await page.locator(`${cardSel} .nsfw-reveal`).click();
    await sleep(400);
    await page.click('#refreshBtn');
    await sleep(1400);
    check('a refresh does not undo the reveal or lose the hide button',
      await page.locator(`${cardSel} .nsfw-cover`).count() === 0 &&
      await page.locator(`${cardSel} .nsfw-hide`).count() === 1);

    await page.click('#toolsSettingsBtn'); await sleep(400);
  }

  // --- 3. the settings window holds one size ----------------------------
  const sizes = {};
  for (const t of ['appearance', 'library', 'capture', 'about']) {
    await page.click(`.settings-tab[data-tab="${t}"]`);
    await sleep(450);
    sizes[t] = await page.locator('.modal-panel.settings').evaluate((n) => {
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    });
  }
  const first = sizes.appearance;
  const same = Object.values(sizes).every((s) => s.w === first.w && s.h === first.h && s.top === first.top);
  check('the settings window is the same size on every tab', same, JSON.stringify(sizes));

  // The tabs themselves must not move, which is what made it feel jumpy.
  const tabTops = {};
  for (const t of ['appearance', 'library', 'capture', 'about']) {
    await page.click(`.settings-tab[data-tab="${t}"]`);
    await sleep(350);
    tabTops[t] = Math.round(await page.locator('.settings-tabs').evaluate((n) => n.getBoundingClientRect().top));
  }
  check('and the tab strip stays put under the pointer',
    new Set(Object.values(tabTops)).size === 1, JSON.stringify(tabTops));

  // A tall pane must still be reachable, not clipped by the fixed height.
  await page.click('.settings-tab[data-tab="library"]'); await sleep(400);
  const reach = await page.locator('.settings-body').evaluate((n) => {
    n.scrollTop = n.scrollHeight;
    return { scrolled: n.scrollTop > 0 || n.scrollHeight <= n.clientHeight, bottomVisible: true };
  });
  const clearBtn = await page.locator('#clearGalleryBtn').isVisible();
  check('a tall pane scrolls rather than being cut off', reach.scrolled && clearBtn);

  // --- where the library is kept ----------------------------------------
  //
  // The images are the part that grows to tens of gigabytes, and the drive
  // Windows is on is often the wrong one. Moving them is moving real files,
  // so this drives it through the interface and then looks on disk.
  await page.click('.settings-tab[data-tab="library"]'); await sleep(400);
  const shownPath = (await page.locator('#storePath').textContent()).trim();
  const storage = await fetch(`${BASE}api/storage`).then(r => r.json());
  check('Settings says where the images are kept',
    shownPath === storage.imagesDir, `${shownPath} vs ${storage.imagesDir}`);
  check('with a way to move them and a way to open the folder',
    await page.locator('#storeMoveBtn').isVisible() &&
    await page.locator('#storeOpenBtn').isVisible());

  const countBefore = (await fetch(`${BASE}api/images?limit=50`).then(r => r.json())).total;
  const dest = `${DATA}/moved-library`;
  await page.click('#storeMoveBtn'); await sleep(500);
  check('moving asks where to, with the default offered as a real choice',
    await page.locator('#storeModal').isVisible() &&
    await page.locator('#storeModal input[value="default"]').count() === 1);

  await page.locator('#storeModal input[value="custom"]').check(); await sleep(300);
  check('choosing a folder of your own reveals somewhere to put it',
    await page.locator('#storeCustomRow').isVisible());
  await page.fill('#storePathInput', dest);
  await page.click('#storeOk'); await sleep(1500);

  const after = await fetch(`${BASE}api/storage`).then(r => r.json());
  check('the library moves to the folder that was chosen',
    after.imagesDir === dest, `${after.imagesDir} vs ${dest}`);
  check('and Settings says so straight away',
    (await page.locator('#storePath').textContent()).trim() === dest);
  const onDisk = fs.readdirSync(dest).filter((f) => f.endsWith('.png')).length;
  check('every picture actually arrived', onDisk === countBefore, `${onDisk} of ${countBefore}`);
  check('and the old folder is not still holding them',
    !fs.existsSync(`${DATA}/gallery-storage/images`) ||
    fs.readdirSync(`${DATA}/gallery-storage/images`).length === 0);

  // The gallery has to keep working from the new place: the index stores
  // file names, not paths, which is the whole reason this is safe.
  await page.keyboard.press('Escape'); await sleep(400);
  await page.reload(); await page.waitForSelector('.card'); await sleep(900);
  const stillThere = await page.locator('.card img').first().evaluate(
    (n) => n.naturalWidth > 0);
  check('and the images still load from where they went', stillThere);

  // A folder that cannot be used says why and changes nothing.
  await page.click('#toolsSettingsBtn'); await sleep(400);
  await page.click('.settings-tab[data-tab="library"]'); await sleep(400);
  await page.click('#storeMoveBtn'); await sleep(500);
  await page.locator('#storeModal input[value="custom"]').check(); await sleep(250);
  await page.fill('#storePathInput', 'not-an-absolute-path');
  await page.click('#storeOk'); await sleep(900);
  check('a path that cannot work is refused in place',
    await page.locator('#storeError').isVisible() &&
    await page.locator('#storeModal').isVisible());
  check('and the library has not moved',
    (await fetch(`${BASE}api/storage`).then(r => r.json())).imagesDir === dest);
  // Escape closes the move window; Settings stays open behind it.
  await page.keyboard.press('Escape'); await sleep(400);

  // --- first-run setup teaches the API token, not the extension ---------
  //
  // The app generates images itself now. The token is what makes that work,
  // so it is the step first-run walks people through; the extension is for
  // people who would rather generate on the website and is offered as such.
  await page.keyboard.press('Escape'); await sleep(300);
  await fetch(`${BASE}api/nai/token`, { method: 'DELETE' });
  {
    const s = await fetch(`${BASE}api/settings`).then(r => r.json());
    await fetch(`${BASE}api/settings`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...s, onboarded: false }) });
  }
  await page.reload(); await page.waitForSelector('.card'); await sleep(900);
  check('first run opens the setup guide',
    await page.locator('#onboardModal').isVisible());

  // Walk to the token step the way a person would.
  let hops = 0;
  let sawStorageStep = false;
  while (hops < 8 && !(await page.locator('#obToken').count())) {
    if (await page.locator('#obStorePath').count()) {
      sawStorageStep = true;
      check('first run says where the images will be kept',
        (await page.locator('#obStorePath').textContent()).length > 3,
        await page.locator('#obStorePath').textContent());
      check('and offers to put them somewhere else',
        await page.locator('#obStoreChoose').isVisible());
    }
    await page.click('#onboardNext'); await sleep(500);
    hops++;
  }
  check('the setup guide reaches an API token step',
    await page.locator('#obToken').count() === 1);
  check('and it passed the storage step on the way',
    sawStorageStep, 'first run never offered a place to keep the images');
  const guide = await page.locator('#onboardBody').innerText();
  check('it says where to get the token',
    /Persistent API Token/i.test(guide), guide.slice(0, 200));
  check('it warns not to share it',
    /don.t share|like a password/i.test(guide));
  check('and points at NovelAI\'s terms',
    /Terms of Service/i.test(guide));
  check('and says where it is kept',
    /encrypted on this PC/i.test(guide));

  await page.fill('#obToken', 'pst-onboarding-token');
  await page.click('#obTokenSave'); await sleep(900);
  const saved = await fetch(`${BASE}api/nai/token`).then(r => r.json());
  check('pasting a token there actually saves it', saved.present === true,
    JSON.stringify(saved));
  check('and the step says so',
    /ready to use/i.test(await page.locator('#obTokenState').textContent()));
  check('without the token being readable back out',
    !JSON.stringify(saved).includes('pst-onboarding-token'));

  // The extension is still there, and still says what it is for.
  await page.click('#onboardNext'); await sleep(700);
  const ext = await page.locator('#onboardBody').innerText();
  check('the extension step is kept for people using the website',
    /novelai\.net/i.test(ext) && /optional/i.test(ext), ext.slice(0, 200));
  check('and it still explains how to load it',
    /Load unpacked/i.test(ext));

  await page.click('#onboardSkip'); await sleep(700);
  check('the guide can be left', await page.locator('#onboardModal').isHidden());

  check('no page errors', errors.length === 0, errors.join('; '));

  // Screenshots for a look. The setup guide above reloaded the page, so
  // Settings has to be opened again rather than assumed still open.
  await page.click('#toolsSettingsBtn'); await sleep(500);
  await page.click('.settings-tab[data-tab="appearance"]'); await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'fix-settings-appearance.png') });
  await page.click('.settings-tab[data-tab="about"]'); await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'fix-settings-about.png') });
  await page.keyboard.press('Escape'); await sleep(400);
  await page.click('#viewMenuBtn'); await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'fix-viewmenu.png') });

  await browser.close(); server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})().catch((e) => { server.kill(); throw e; });

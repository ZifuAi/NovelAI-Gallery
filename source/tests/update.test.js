/* Update UI tests.
 *
 * The real updater talks to GitHub and, on success, replaces the running
 * program - neither of which belongs in a test. So the page is served
 * normally and only the /api/update/* calls are answered by a fake, which
 * lets the whole flow be driven: nothing today, something available, the
 * corner prompt, the download bar, the install call, and the changelog
 * screen after a restart.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
// Built by tests/run.sh. Override with NAG_BIN to test a different build.
const NAG_BIN = process.env.NAG_BIN || path.join(REPO, 'app', 'nag-dev');
const SEED_PY = path.join(__dirname, 'seed.py');
const SHOTS = path.join(__dirname, 'screenshots');
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const UI = path.join(REPO, 'ui');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

// --- a stand-in for the app's own HTTP layer ---------------------------

const fake = {
  progress: { state: 'idle', message: '' },
  daily: { first: true, autoUpdate: false },
  welcome: null,
  installCalled: false,
  downloadCalled: false,
  onboarded: true,
};

const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/update/state') return json(res, { version: '1.2.0', progress: fake.progress });
  if (p === '/api/update/daily') return json(res, fake.daily);
  if (p === '/api/update/check') return json(res, { started: true });
  if (p === '/api/update/download') {
    fake.downloadCalled = true;
    // The real updater flips straight to "downloading"; some checks rely
    // on that, since the UI stops polling once the state settles.
    if (fake.downloadProgress) fake.progress = fake.downloadProgress;
    return json(res, { started: true });
  }
  if (p === '/api/update/install') { fake.installCalled = true; return json(res, { ok: true }); }
  if (p === '/api/update/welcome') { const r = fake.welcome; fake.welcome = null; return json(res, { release: r }); }

  if (p === '/api/health') return json(res, { ok: true, version: '1.2.0' });
  if (p === '/api/settings') return json(res, {
    theme: 'midnight', cardSize: 190, layout: 'waterfall', sort: 'newest',
    metaView: 'tags', flagNsfw: true, sidebarWidth: 232,
    onboarded: fake.onboarded !== false,
    autoUpdate: fake.daily.autoUpdate,
  });
  if (p === '/api/images') return json(res, { items: [], total: 0 });
  if (p === '/api/folders') return json(res, []);
  if (p === '/api/tags') return json(res, []);
  if (p === '/api/colors') return json(res, { names: {}, counts: {} });
  if (p === '/api/undo') return json(res, { canUndo: false, canRedo: false });
  if (p === '/api/storage') return json(res, { imagesDir: '/tmp' });
  if (p.startsWith('/api/')) return json(res, {});

  const file = path.join(UI, p === '/' ? 'index.html' : p.slice(1));
  if (!file.startsWith(UI) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();

  // --- 1. nothing new: the corner stays empty -------------------------
  {
    fake.progress = { state: 'uptodate', message: "You're on the latest build" };
    fake.daily = { first: true, autoUpdate: false };
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await sleep(1400);
    const shown = await page.locator('#updateToast').isVisible();
    check('no prompt when the build is current', !shown);
    check('no page errors on load', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // --- 2. something newer: the prompt appears, and offers the update ---
  let page;
  {
    fake.progress = {
      state: 'available',
      message: 'Build 1.2 is available',
      release: { version: '1.2.0', tag: 'v1.2', name: 'Build 1.2', newer: true,
        assetUrl: 'https://example.invalid/setup.exe', assetSize: 2516582,
        notes: '- a new thing', url: 'https://example.invalid/rel' },
    };
    fake.daily = { first: true, autoUpdate: false };
    page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.locator('#updateToast').waitFor({ state: 'visible', timeout: 5000 });

    check('the prompt names the new build',
      (await page.locator('#updateToastTitle').textContent()).includes('1.2'));
    check('the prompt shows the download size',
      (await page.locator('#updateToastBody').textContent()).includes('2.4 MB'));
    check('the prompt is in a corner, not a modal',
      await page.locator('#updateToast').evaluate((n) => getComputedStyle(n).position === 'fixed'));
    check('no page errors with an update pending', errors.length === 0, errors.join('; '));

    // Dismissing it leaves the app alone.
    await page.click('#updateToastLater');
    await sleep(400);
    check('"Not now" dismisses the prompt', !(await page.locator('#updateToast').isVisible()));
    check('dismissing does not start a download', fake.downloadCalled === false);
  }

  // --- 3. the download, then the install ------------------------------
  {
    await page.reload();
    await page.locator('#updateToast').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#updateToastGo');
    await page.locator('#updateModal').waitFor({ state: 'visible', timeout: 3000 });
    check('choosing Update starts the download', fake.downloadCalled === true);

    // Half way.
    fake.progress = { state: 'downloading', message: 'Downloading…', percent: 50,
      downloaded: 1258291, total: 2516582, release: { version: '1.2.0' } };
    await sleep(900);
    const width = await page.locator('#updateBarFill').evaluate((n) => n.style.width);
    check('the progress bar follows the download', width === '50%', `width was ${width}`);
    check('the overlay says what it is doing',
      (await page.locator('#updateSub').textContent()).includes('of 2.4 MB'));

    // Finished downloading: it should install without another click, since
    // the person already agreed to the update.
    fake.progress = { state: 'ready', message: 'Ready to install', percent: 100,
      release: { version: '1.2.0' } };
    await sleep(1500);
    check('a finished download installs itself', fake.installCalled === true);
    check('the overlay says it is installing',
      (await page.locator('#updateHeadline').textContent()).toLowerCase().includes('install'));
    await page.close();
  }

  // --- 3b. first-run setup must not be interrupted by an update prompt --
  {
    fake.onboarded = false;
    fake.daily = { first: true, autoUpdate: false };
    fake.progress = {
      state: 'available', message: 'Build 1.2 is available',
      release: { version: '1.2.0', newer: true, assetUrl: 'https://example.invalid/setup.exe' },
    };
    const p1 = await browser.newPage();
    await p1.goto(base);
    await sleep(2000);
    check('no update prompt during first-run setup',
      !(await p1.locator('#updateToast').isVisible()));
    await p1.close();
    fake.onboarded = true;
  }

  // --- 4. after the restart: the changelog, once ----------------------
  {
    fake.progress = { state: 'idle' };
    fake.daily = { first: false, autoUpdate: false };
    fake.welcome = {
      version: '1.2.0', name: 'Build 1.2', url: 'https://example.invalid/rel',
      notes: '### Added\n- Nested folders\n- **Undo** everywhere\n\nUse `Ctrl+Z`.',
    };
    const p2 = await browser.newPage();
    const errors = [];
    p2.on('pageerror', (e) => errors.push(e.message));
    await p2.goto(base);
    await p2.locator('#welcomeModal').waitFor({ state: 'visible', timeout: 5000 });

    const body = await p2.locator('#welcomeBody').innerHTML();
    check('the changelog renders its heading', body.includes('<h4>Added</h4>'));
    check('the changelog renders its bullets', (body.match(/<li>/g) || []).length === 2);
    check('the changelog renders bold and code',
      body.includes('<strong>Undo</strong>') && body.includes('<code>Ctrl+Z</code>'));
    check('no page errors on the welcome screen', errors.length === 0, errors.join('; '));

    await p2.click('#welcomeDone');
    await sleep(200);
    check('the changelog can be dismissed', !(await p2.locator('#welcomeModal').isVisible()));

    // Second launch: the server has cleared it, so it must not come back.
    await p2.reload();
    await sleep(1200);
    check('the changelog is shown once, not every launch',
      !(await p2.locator('#welcomeModal').isVisible()));
    await p2.close();
  }

  // --- 5. release notes are data, not markup --------------------------
  {
    fake.welcome = { version: '1.2.0', notes: 'Fixed <img src=x onerror="window.__x=1"> the thing' };
    fake.daily = { first: false, autoUpdate: false };
    const p3 = await browser.newPage();
    await p3.goto(base);
    await p3.locator('#welcomeModal').waitFor({ state: 'visible', timeout: 5000 });
    await sleep(300);
    check('a release body cannot inject markup',
      (await p3.evaluate(() => window.__x)) === undefined &&
      (await p3.locator('#welcomeBody').innerHTML()).includes('&lt;img'));
    await p3.close();
  }

  // --- 6. Settings ▸ About --------------------------------------------
  {
    fake.progress = { state: 'uptodate', message: "You're on the latest build" };
    fake.daily = { first: false, autoUpdate: false };
    const p4 = await browser.newPage();
    const errors = [];
    p4.on('pageerror', (e) => errors.push(e.message));
    await p4.goto(base);
    await sleep(600);
    await p4.click('#toolsSettingsBtn');
    await p4.click('.settings-tab[data-tab="about"]');
    await sleep(600);

    check('About shows which build this is',
      (await p4.locator('#aboutVersion').textContent()).trim() === 'Build 1.2.0');
    check('About has an automatic-updates toggle',
      await p4.locator('#autoUpdateSwitch .switch-input').count() === 1);
    check('About reports the check result',
      (await p4.locator('#updateStatus').textContent()).toLowerCase().includes('latest'));
    check('opening Settings raises no errors', errors.length === 0, errors.join('; '));

    // With an update waiting there is a separate button for it, rather than
    // a label that rewrites itself - the morphing one was easy to miss.
    fake.progress = { state: 'available', message: 'Build 1.2 is available',
      release: { version: '1.2.0', newer: true, assetUrl: 'https://example.invalid/setup.exe' } };
    await p4.click('#checkUpdateBtn');
    await sleep(1500);
    check('an install button appears when there is something to install',
      await p4.locator('#installUpdateBtn').isVisible() &&
      (await p4.locator('#installUpdateBtn').textContent()).includes('1.2'),
      await p4.locator('#installUpdateBtn').textContent());
    check('and Check for updates stays what it says it is',
      (await p4.locator('#checkUpdateBtn').textContent()).trim() === 'Check for updates');

    fake.progress = { state: 'uptodate', message: "You're on the latest build" };
    await p4.click('#checkUpdateBtn');
    await sleep(1500);
    check('and it is hidden when there is nothing to install',
      await p4.locator('#installUpdateBtn').isHidden());

    // --- Install Latest -------------------------------------------------
    // The one thing "Check for updates" cannot do: reinstall the published
    // release when it is the build you are already on. Nothing is newer
    // here, and it must still go through.
    fake.downloadCalled = false; fake.installCalled = false;
    const sameBuild = { version: '1.2.0', newer: false,
      assetUrl: 'https://example.invalid/setup.exe' };
    fake.progress = { state: 'uptodate', message: "You're on the latest build",
      release: sameBuild };
    fake.downloadProgress = { state: 'downloading', percent: 20, release: sameBuild };

    check('Install Latest is offered even with nothing newer',
      await p4.locator('#installLatestBtn').isVisible());
    await p4.click('#installLatestBtn'); await sleep(500);
    check('and it asks first, since the app restarts',
      await p4.locator('#confirmModal').isVisible());
    await p4.click('#confirmCancel'); await sleep(400);
    check('cancelling downloads nothing', fake.downloadCalled === false);

    await p4.click('#installLatestBtn'); await sleep(400);
    await p4.click('#confirmOk');
    await sleep(2500);
    check('confirming fetches the release that is published now',
      fake.downloadCalled === true);
    check('and says which build it is fetching',
      /1\.2\.0/.test(await p4.locator('#updateHeadline').textContent()),
      await p4.locator('#updateHeadline').textContent());

    fake.progress = { state: 'ready', message: 'Ready',
      release: { version: '1.2.0', newer: false,
        assetUrl: 'https://example.invalid/setup.exe' } };
    await sleep(2500);
    check('and installs it once it has come down', fake.installCalled === true);
    check('with no page errors along the way', errors.length === 0, errors.join('; '));
    await p4.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();

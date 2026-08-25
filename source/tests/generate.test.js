/* The Generate tab, driven through the interface against a stand-in for
 * NovelAI. Nothing here talks to the real API or spends anything. */
const path = require('path');
const REPO = path.join(__dirname, '..');
const NAG_BIN = process.env.NAG_BIN || path.join(REPO, 'app', 'nag-dev');
const SEED_PY = path.join(__dirname, 'seed.py');
const SHOTS = path.join(__dirname, 'screenshots');

const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'); const os = require('os');

const http = require('http');
const zlib = require('zlib');

// A minimal PNG writer, so each fake generation is genuinely a new image.
function makePng(w, h, r, g, b) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = (r + x) % 256;
      row[2 + x * 3] = (g + y) % 256;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A stand-in for NovelAI. Answers with a zip holding a PNG, exactly as the
// real API does, so the whole flow runs without a token or any Anlas.
let naiCalls = 0;
let naiFail = null;
let anlasFixed = 4000;
let anlasPurchased = 136;
// When on, the stand-in charges for every generation, the way the real
// account does - so the counter can be checked against a balance that
// actually moves rather than one this app decided for itself.
let anlasAuto = false;
let anlasTier = 3;
let anlasFree = true;
let lastBody = null;   // the last payload NovelAI was sent, for checking
let anlasBroken = false;
const fakeNai = http.createServer((req, res) => {
  if (req.url.includes('/user/data')) {
    if (anlasBroken) {
      res.writeHead(500);
      return res.end('{}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      subscription: {
        tier: anlasTier,
        trainingStepsLeft: {
          fixedTrainingStepsLeft: anlasFixed,
          purchasedTrainingSteps: anlasPurchased },
        perks: {
          unlimitedImageGeneration: anlasFree,
          unlimitedImageGenerationLimits: [{ resolution: 1048576, maxPrompts: 0 }],
        },
      },
    }));
  }
  naiCalls++;
  if (anlasAuto) anlasFixed = Math.max(0, anlasFixed - 30);
  if (naiFail) {
    res.writeHead(naiFail, { 'Content-Type': 'application/json' });
    return res.end('{"message":"nope"}');
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { lastBody = JSON.parse(body); } catch (e) { lastBody = null; }
    // A different picture every call. The store rejects duplicates by
    // hash - correctly - so serving the same bytes twice would look like
    // saving had failed when it was working exactly as intended.
    const png = makePng(64, 96, naiCalls * 37 % 256, 120, 200);
    // Minimal stored (uncompressed) zip, which is all archive/zip needs.
    const name = Buffer.from('image_0.png');
    const crc = zlib.crc32 ? zlib.crc32(png) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(png.length, 18);
    local.writeUInt32LE(png.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(png.length, 20); central.writeUInt32LE(png.length, 24);
    central.writeUInt16LE(name.length, 28);
    const localAll = Buffer.concat([local, name, png]);
    const centralAll = Buffer.concat([central, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralAll.length, 12); end.writeUInt32LE(localAll.length, 16);
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(Buffer.concat([localAll, centralAll, end]));
  });
});

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nag-gen-'));
const SEED_DIR_FOR_FAKE = path.join(DATA, 'seed');
const SEED = path.join(DATA, 'seed');
execFileSync('python3', [SEED_PY, SEED]);
// listen() binds asynchronously, so the port has to be waited for. Reading
// address() straight after the call gave 0, which pointed the app at
// nowhere and made every generation fail with a timeout that looked like a
// UI bug rather than a test one.
let server = null;
async function startApp() {
  await new Promise((res) => fakeNai.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${fakeNai.address().port}`;
  server = spawn(NAG_BIN, [], {
    env: {
      ...process.env,
      NOVELAI_GALLERY_DATA: DATA,
      NOVELAI_GALLERY_NAI_ENDPOINT: `${base}/ai/generate-image`,
      NOVELAI_GALLERY_NAI_USERDATA: `${base}/user/data`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
let BASE = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, d) => { console.log(`${ok?'PASS':'FAIL'}  ${n}${ok||!d?'':`\n        ${d}`}`); if (!ok) failures++; };

(async () => {
  await startApp();
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no start')), 15000);
    const scan = (b) => { const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); BASE = m[0]; res(); } };
    server.stdout.on('data', scan); server.stderr.on('data', scan);
  });
  for (const f of fs.readdirSync(SEED)) {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(path.join(SEED, f))]), f);
    await fetch(`${BASE}api/images`, { method: 'POST', body: fd });
  }
  const s0 = await fetch(`${BASE}api/settings`).then(r => r.json());
  await fetch(`${BASE}api/settings`, { method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ ...s0, onboarded: true }) });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE); await page.waitForSelector('.card'); await sleep(900);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(800);

  // --- the token -------------------------------------------------------
  check('the tab opens with no token saved',
    (await page.locator('#genTokenState').textContent()).trim() === 'Not set');
  check('and Generate is disabled until there is one',
    await page.locator('#genGo').isDisabled());

  // The token lives in Settings now; the tab only points at it.
  await page.click('#genTokenSettings'); await sleep(700);
  check('the Settings button opens Settings on the right tab',
    await page.locator('#settingsModal').isVisible() &&
    await page.locator('.settings-pane[data-pane="capture"]').isVisible());

  await page.fill('#setToken', 'pst-test-token');
  await page.click('#setTokenSave'); await sleep(800);
  check('the value is not echoed back into the field',
    (await page.inputValue('#setToken')) === '');
  await page.keyboard.press('Escape'); await sleep(500);

  check('saving a token enables Generate',
    (await page.locator('#genTokenState').textContent()).trim() === 'Saved' &&
    !(await page.locator('#genGo').isDisabled()));
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(500);
  const tokenInfo = await fetch(`${BASE}api/nai/token`).then(r => r.json());
  check('and the app never serves the token itself',
    !JSON.stringify(tokenInfo).includes('pst-test-token'), JSON.stringify(tokenInfo));

  // --- the model dropdown ---------------------------------------------
  const models = await page.locator('#genModel option').allTextContents();
  check('the current models are offered in a dropdown',
    models.length === 5, models.join(' | '));

  // Whatever is picked, something real is always sent - an empty model
  // would be filled in by the server and might not be what is on screen.
  await page.selectOption('#genModel', ''); await sleep(300);
  check('picking Other with nothing typed still sends a real model',
    await page.evaluate(() => genModelId()) === 'nai-diffusion-5-full',
    await page.evaluate(() => genModelId()));
  await page.fill('#genModelCustom', 'nai-diffusion-4-5-full'); await sleep(200);
  check('and a typed identifier is used as given',
    await page.evaluate(() => genModelId()) === 'nai-diffusion-4-5-full');
  await page.selectOption('#genModel', 'nai-diffusion-5-full'); await sleep(300);
  check('with V5 at the top', /V5/.test(models[0]), models[0]);

  check('and the custom box is hidden until Other is picked',
    await page.locator('#genModelCustom').isHidden());
  await page.selectOption('#genModel', '');
  await sleep(300);
  check('picking Other reveals somewhere to type an identifier',
    await page.locator('#genModelCustom').isVisible());
  await page.selectOption('#genModel', 'nai-diffusion-4-5-full');
  await sleep(300);

  // --- the cost on the button -----------------------------------------
  // On a model outside the free allowance, so what is being checked is the
  // price rather than the account's perks - those get their own section.
  await page.selectOption('#genModel', 'nai-diffusion-5-full'); await sleep(400);
  check('the button shows what a generation will cost',
    /Anlas/.test(await page.locator('#genGo').textContent()),
    await page.locator('#genGo').textContent());
  const oneCost = await page.locator('.gen-cost').textContent();
  await page.selectOption('#genCount', '4'); await sleep(300);
  const fourCost = await page.locator('.gen-cost').textContent();
  const num = (t) => Number(String(t).replace(/[^0-9]/g, ''));
  check('and four images cost four times one',
    num(fourCost) === num(oneCost) * 4, `${oneCost} vs ${fourCost}`);
  await page.selectOption('#genCount', '1'); await sleep(300);

  // --- generating ------------------------------------------------------
  // Under "only save images I save or download" nothing is filed away on
  // its own; the other two modes do it automatically, which is checked
  // further down. Set the mode the way a person would, through Settings.
  await page.click('#genTokenSettings'); await sleep(700);
  await page.click('#captureModes .option[data-option="download"]'); await sleep(600);
  check('manual-only capture can be chosen in Settings',
    (await page.locator('#captureModes .option[data-option="download"]')
      .getAttribute('class')).includes('selected'));
  await page.keyboard.press('Escape'); await sleep(500);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(500);

  await page.fill('#genPrompt', '1girl, city street, night');
  await page.click('#genGo'); await sleep(500);
  check('the first generation asks before spending Anlas',
    await page.locator('#confirmModal').isVisible());
  check('and the confirmation names the cost',
    /Anlas/.test(await page.locator('#confirmBody').textContent()));
  await page.click('#confirmCancel'); await sleep(400);
  check('cancelling generates nothing', naiCalls === 0);

  await page.click('#genGo'); await sleep(500);
  await page.click('#confirmOk');
  await page.locator('#genPreview').waitFor({ state: 'visible', timeout: 15000 });
  await sleep(600);

  check('generating reaches NovelAI once', naiCalls === 1, `${naiCalls} calls`);
  check('and shows the picture on the page', await page.locator('#genPreview').isVisible());

  // The whole point of the change: nothing is filed away on its own.
  const afterGen = await fetch(`${BASE}api/images?limit=50`).then(r => r.json());
  check('but nothing is saved to the gallery yet', afterGen.total === 7,
    `gallery holds ${afterGen.total}`);
  check('and it appears in the history strip',
    await page.locator('.gen-strip .gen-thumb').count() === 1);
  check('marked as not yet saved',
    await page.locator('.gen-strip .gen-kept').count() === 0);

  // --- keeping one ------------------------------------------------------
  await page.click('#genKeep'); await sleep(900);
  const afterKeep = await fetch(`${BASE}api/images?limit=50`).then(r => r.json());
  check('saving it puts it in the gallery', afterKeep.total === 8);
  check('the button then says so and stops offering',
    (await page.locator('#genKeep').textContent()).includes('Saved') &&
    await page.locator('#genKeep').isDisabled());
  check('and the history strip ticks it',
    await page.locator('.gen-strip .gen-kept').count() === 1);

  // Saving twice would quietly duplicate it.
  await page.locator('#genKeep').click({ force: true }).catch(() => {});
  await sleep(600);
  check('and it cannot be saved twice',
    (await fetch(`${BASE}api/images?limit=50`).then(r => r.json())).total === 8);

  // --- discarding -------------------------------------------------------
  await page.click('#genGo'); await sleep(400);
  await page.locator('#genPreview').waitFor({ state: 'visible', timeout: 15000 });
  await sleep(700);
  check('a second generation joins the strip',
    await page.locator('.gen-strip .gen-thumb').count() === 2);

  await page.click('#genDiscard'); await sleep(800);
  check('discarding removes it from the strip',
    await page.locator('.gen-strip .gen-thumb').count() === 1);
  check('and does not touch the gallery',
    (await fetch(`${BASE}api/images?limit=50`).then(r => r.json())).total === 8);

  // --- the other capture modes save on their own ------------------------
  // "Only save images I save or download" is the one mode that waits for a
  // click. Switching back to the ordinary mode must file a generation away
  // without one, or the setting means nothing.
  await page.click('#genTokenSettings'); await sleep(700);
  await page.click('#captureModes .option[data-option="generated"]'); await sleep(600);
  await page.keyboard.press('Escape'); await sleep(500);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(400);

  await page.click('#genGo'); await sleep(400);
  await page.locator('#genPreview').waitFor({ state: 'visible', timeout: 15000 });
  await sleep(1200);
  check('generating under the automatic mode saves without a click',
    (await fetch(`${BASE}api/images?limit=50`).then(r => r.json())).total === 9,
    `gallery holds ${(await fetch(`${BASE}api/images?limit=50`).then(r => r.json())).total}`);
  check('and the strip shows it as already saved',
    await page.locator('.gen-strip .gen-kept').count() === 2,
    `${await page.locator('.gen-strip .gen-kept').count()} ticked`);
  check('with the save button offering nothing more to do',
    await page.locator('#genKeep').isDisabled());

  // Back to manual for the rest, so later generations do not pile into the
  // gallery behind the checks that follow.
  await page.click('#genTokenSettings'); await sleep(700);
  await page.click('#captureModes .option[data-option="download"]'); await sleep(600);
  await page.keyboard.press('Escape'); await sleep(500);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(400);

  // --- an error from NovelAI is reported, not swallowed -----------------
  naiFail = 402;
  await page.click('#genGo'); await sleep(1500);
  check('a refused generation says why',
    /Anlas/.test(await page.locator('#genStatus').textContent()),
    await page.locator('#genStatus').textContent());
  // And keeps the evidence, so a refusal can be looked at rather than
  // guessed at.
  check('and offers the exact request that was refused',
    await page.locator('.gen-copyreq').count() === 1);
  naiFail = null;

  // --- reuse into the tab ----------------------------------------------
  await page.click('.tool-tab[data-tool="gallery"]'); await sleep(700);
  // A seeded image, not the generated one: these carry a prompt in the PNG,
  // which is what Edit in Generate reads.
  const seeded = (await fetch(`${BASE}api/images?limit=50`).then(r => r.json()))
    .items.find((i) => i.meta && i.meta.prompt && i.source === null);
  await page.locator(`.card[data-id="${seeded.id}"]`).click({ position: { x: 8, y: 60 } });
  await page.locator('#lightbox').waitFor({ state: 'visible' }); await sleep(700);
  check('the details panel offers both reuse destinations',
    await page.locator('#reuseBtn').count() === 1 &&
    await page.locator('#editGenBtn').count() === 1);

  // Adding a third button made the row overflow the panel and slide under
  // the image, where it looked fine and could not be clicked.
  const fits = await page.evaluate(() => {
    const panel = document.querySelector('.details').getBoundingClientRect();
    return [...document.querySelectorAll('.reuse-row .btn')].every((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= panel.left - 1 && r.right <= panel.right + 1;
    });
  });
  check('and every one of those buttons stays inside the panel', fits);
  // Three buttons in that row now; make sure it is actually in view before
  // clicking, the same as a person scrolling to it would.
  await page.locator('#editGenBtn').scrollIntoViewIfNeeded();
  await page.locator('#editGenBtn').click(); await sleep(800);

  check('Edit in Generate switches tab and asks the same question',
    await page.locator('#toolGenerate').isVisible() &&
    await page.locator('#genImportModal').isVisible());
  await page.click('#genImportGo'); await sleep(800);
  check('and importing carries the prompt over',
    (await page.inputValue('#genPrompt')).length > 10,
    await page.inputValue('#genPrompt'));
  check('but not the seed, since that would repeat the same picture',
    (await page.inputValue('#genSeed')) === '');
  // The large view has to get out of the way, or the dialog opens behind it.
  check('and the image viewer closes behind you',
    await page.locator('#lightbox').isHidden());

  // --- forgetting the token --------------------------------------------
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(600);
  await page.click('#genTokenSettings'); await sleep(700);
  await page.click('#setTokenClear'); await sleep(800);
  await page.keyboard.press('Escape'); await sleep(500);
  check('forgetting the token disables Generate again',
    (await page.locator('#genTokenState').textContent()).trim() === 'Not set' &&
    await page.locator('#genGo').isDisabled());

  check('the gallery still works after all that, with the kept image in it',
    (await (async () => { await page.click('.tool-tab[data-tool="gallery"]'); await sleep(700);
      return page.locator('.card').count(); })()) === 8,
    'the flagged seed is on the NSFW shelf, so All images is one short');
  // Everything in the settings grid has to stay inside the sidebar; the
  // number inputs pushed the second column off the edge once already.
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(600);
  const insideSidebar = await page.evaluate(() => {
    const side = document.querySelector('.gen-side').getBoundingClientRect();
    return [...document.querySelectorAll('.gen-grid .pg-input, .gen-grid .pg-select')]
      .every((n) => n.getBoundingClientRect().right <= side.right + 1);
  });
  check('the settings fields stay inside the sidebar', insideSidebar);

  // --- character prompts -------------------------------------------------
  await page.click('#genAddChar'); await sleep(300);
  await page.click('#genAddChar'); await sleep(300);
  check('characters can be added', await page.locator('.gen-char').count() === 2);
  check('and the position control appears with them',
    await page.locator('#genPosRow').isVisible());
  await page.locator('.gen-char').first().locator('.gen-char-box').fill('1girl, red hair');
  await page.locator('.gen-char').nth(1).locator('.gen-char-box').fill('1girl, blue hair');
  await page.locator('.gen-char').first().locator('[data-act="remove"]').click();
  await sleep(300);
  check('and removed again', await page.locator('.gen-char').count() === 1);
  check('the one left is the one that was kept',
    (await page.locator('.gen-char').first().locator('.gen-char-box').inputValue())
      === '1girl, blue hair');

  // A character is written the same way the scene is: one big box, two tabs.
  const charTabs = await page.locator('.gen-char .gen-char-tabs .gen-tab').allTextContents();
  // The field should be as deep in the layout as the main prompt is, not a
  // card inside a card inside a card.
  const depth = await page.evaluate(() => {
    const boxes = (sel) => {
      let n = document.querySelector(sel), d = 0;
      while (n && n.id !== 'toolGenerate') {
        const st = getComputedStyle(n);
        if (st.borderTopWidth !== '0px' && st.borderTopStyle !== 'none') d++;
        n = n.parentElement;
      }
      return d;
    };
    return { main: boxes('#genPrompt'), char: boxes('.gen-char-box') };
  });
  check('a character box sits at the same depth as the main prompt',
    depth.char === depth.main, JSON.stringify(depth));

  check('a character has Prompt and UC tabs',
    charTabs.length === 2 && charTabs.join('|').includes('UC'), charTabs.join('|'));

  await page.locator('.gen-char .gen-tab[data-tab="uc"]').click(); await sleep(300);
  check('switching to UC shows an empty box',
    (await page.locator('.gen-char .gen-char-box').inputValue()) === '');
  await page.locator('.gen-char .gen-char-box').fill('hat, hood');
  await page.locator('.gen-char .gen-tab[data-tab="prompt"]').click(); await sleep(300);
  check('and switching back brings the prompt, not the undesired content',
    (await page.locator('.gen-char .gen-char-box').inputValue()) === '1girl, blue hair');
  await page.locator('.gen-char .gen-tab[data-tab="uc"]').click(); await sleep(300);
  check('each tab keeps what was typed in it',
    (await page.locator('.gen-char .gen-char-box').inputValue()) === 'hat, hood');
  await page.locator('.gen-char .gen-tab[data-tab="prompt"]').click(); await sleep(300);

  // Both the scene prompt and the character boxes can be dragged taller.
  const resizable = await page.evaluate(() => {
    const ok = (sel) => {
      const n = document.querySelector(sel);
      return n && ['vertical', 'both'].includes(getComputedStyle(n).resize);
    };
    return { prompt: ok('#genPrompt'), negative: ok('#genNegative'), char: ok('.gen-char-box') };
  });
  check('the scene prompt is resizable', resizable.prompt && resizable.negative,
    JSON.stringify(resizable));
  check('and so is a character box', resizable.char);

  // Nothing to position when there is nobody to position.
  const savedChars = await page.locator('.gen-char').count();
  for (let i = 0; i < savedChars; i++) {
    await page.locator('.gen-char [data-act="remove"]').first().click();
    await sleep(200);
  }
  check('removing the last character hides the position control',
    await page.locator('#genPosRow').isHidden());
  await page.click('#genAddChar'); await sleep(300);
  await page.locator('.gen-char .gen-char-box').fill('1girl, blue hair');
  check('and adding one brings it back', await page.locator('#genPosRow').isVisible());

  // --- placing characters -----------------------------------------------
  check('position offers AI\u2019s Choice and Custom',
    await page.locator('.gen-segbtn').count() === 2 &&
    (await page.locator('.gen-segbtn').allTextContents()).join('|').includes('Custom'));
  check('and AI\u2019s Choice is the default',
    await page.locator('.gen-segbtn[data-pos="auto"]').evaluate((n) => n.classList.contains('active')));
  check('the canvas cannot be opened while the model is choosing',
    await page.locator('#genOpenCanvas').isDisabled());

  await page.click('.gen-segbtn[data-pos="custom"]'); await sleep(500);
  check('choosing Custom opens the placement canvas',
    await page.locator('#genCanvasModal').isVisible());
  check('with a marker for each character',
    await page.locator('.genpos-mark').count() === 1);

  // Drag it somewhere and check the coordinate actually moved.
  const frame = await page.locator('#genPosFrame').boundingBox();
  const mark = await page.locator('.genpos-mark').first().boundingBox();
  await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.2, frame.y + frame.height * 0.8, { steps: 12 });
  await page.mouse.up();
  await sleep(400);
  await page.click('#genPosDone'); await sleep(400);

  const at = await page.locator('.gen-char-at').first().textContent();
  const xy = at.match(/(\d+)%,\s*(\d+)%/);
  check('dragging a marker moves that character', xy && Number(xy[1]) < 35 && Number(xy[2]) > 65, at);

  // And the frame follows the shape of the picture, so a marker sits where
  // it will actually land.
  await page.selectOption('#genSize',
    await page.locator('#genSize option').evaluateAll(
      (o) => o.findIndex((x) => x.textContent.includes('1216 × 832')).toString())
      .then((i) => ({ index: Number(i) })));
  await sleep(300);
  await page.click('#genOpenCanvas'); await sleep(500);
  const ratio = await page.locator('#genPosFrame').evaluate((n) => {
    const r = n.getBoundingClientRect(); return r.width / r.height;
  });
  check('the canvas matches the aspect ratio being generated', ratio > 1.2, `ratio ${ratio.toFixed(2)}`);
  check('and states the resolution it stands for',
    /\d+ × \d+/.test(await page.locator('#genPosSize').textContent()),
    await page.locator('#genPosSize').textContent());

  // Changing the size while it is open has to reshape it, or the markers
  // would be placed against a frame that no longer applies.
  await page.selectOption('#genSize',
    await page.locator('#genSize option').evaluateAll(
      (o) => o.findIndex((x) => x.textContent.includes('832 × 1216')).toString())
      .then((i) => ({ index: Number(i) })));
  await sleep(500);
  const portrait = await page.locator('#genPosFrame').evaluate((n) => {
    const r = n.getBoundingClientRect(); return r.width / r.height;
  });
  check('and follows a size change while it is open', portrait < 1,
    `ratio ${portrait.toFixed(2)}`);
  await page.click('#genPosReset'); await sleep(300);
  await page.click('#genPosDone'); await sleep(400);
  check('reset puts everyone back in the middle',
    (await page.locator('.gen-char-at').first().textContent()).includes('50%'));

  await page.click('.gen-segbtn[data-pos="auto"]'); await sleep(400);
  check('switching back to AI\u2019s Choice hides the coordinates',
    await page.locator('.gen-char-at').count() === 0);

  // --- folding, and the button that must never fold away ----------------
  const goVisible = () => page.locator('#genGo').isVisible();
  check('the Generate button is on screen to begin with', await goVisible());

  await page.click('.gen-block-head[data-fold="settings"]'); await sleep(350);
  check('the settings section folds', await page.locator('.gen-foldbody[data-body="settings"]').isHidden());
  await page.click('.gen-block-head[data-fold="chars"]'); await sleep(350);
  check('so does character prompts', await page.locator('.gen-foldbody[data-body="chars"]').isHidden());
  check('and the Generate button is still there', await goVisible());

  // It also has to survive a sidebar too tall to fit, which is what put it
  // off screen in the first place.
  await page.click('.gen-block-head[data-fold="settings"]'); await sleep(300);
  await page.click('.gen-block-head[data-fold="chars"]'); await sleep(300);
  await page.locator('.gen-scroll').evaluate((n) => { n.scrollTop = n.scrollHeight; });
  await sleep(300);
  check('and stays visible however far the sidebar is scrolled', await goVisible());

  const stripWide = await page.locator('.gen-history').evaluate((n) => n.getBoundingClientRect().width);
  await page.click('#genHistoryFold'); await sleep(400);
  const stripThin = await page.locator('.gen-history').evaluate((n) => n.getBoundingClientRect().width);
  check('the history can be folded out of the way', stripThin < stripWide - 60,
    `${Math.round(stripWide)} -> ${Math.round(stripThin)}`);
  await page.click('#genHistoryFold'); await sleep(400);

  // --- settings reachable from every tab --------------------------------
  for (const tab of ['generate', 'gallery', 'prompt']) {
    await page.click(`.tool-tab[data-tool="${tab}"]`); await sleep(500);
    if (!await page.locator('#toolsSettingsBtn').isVisible()) {
      check(`settings is reachable from the ${tab} tab`, false);
    }
  }
  check('settings is reachable from every tab', true);
  await page.click('#toolsSettingsBtn'); await sleep(500);
  check('and the button opens it', await page.locator('#settingsModal').isVisible());
  await page.keyboard.press('Escape'); await sleep(400);

  // --- what's left in the account --------------------------------------
  // The checks above left us on the gallery with the token forgotten.
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(700);
  await page.click('#genTokenSettings'); await sleep(600);
  await page.fill('#setToken', 'pst-test-token');
  await page.click('#setTokenSave'); await sleep(900);
  await page.keyboard.press('Escape'); await sleep(600);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(900);

  check('the remaining Anlas is shown beside the token',
    await page.locator('#genAnlas').isVisible() &&
    (await page.locator('#genAnlas').textContent()).includes('4,136'),
    await page.locator('#genAnlas').textContent());
  check('and it sits in the token block',
    await page.locator('#genTokenCard #genAnlas').count() === 1);

  // An account with nothing left - or an Opus subscription, where the
  // fixed allowance genuinely sits at zero while the ordinary sizes are
  // free - used to read as "Anlas —" and look broken. Zero is an answer.
  anlasFixed = 0; anlasPurchased = 0;
  await page.reload(); await page.waitForSelector('.tool-tab'); await sleep(900);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(1200);
  check('a balance of zero is shown as zero, not as unknown',
    (await page.locator('#genAnlas').textContent()).includes('0 Anlas') &&
    await page.locator('#genAnlas').getAttribute('data-known') === 'yes',
    await page.locator('#genAnlas').textContent());
  anlasFixed = 4000; anlasPurchased = 136;

  // A balance that cannot be read says so rather than vanishing, which
  // would look exactly like the feature being broken.
  anlasBroken = true;
  await page.reload(); await page.waitForSelector('.tool-tab'); await sleep(900);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(1200);
  check('an unreadable balance is stated, not hidden',
    await page.locator('#genAnlas').isVisible() &&
    (await page.locator('#genAnlas').textContent()).includes('—'),
    await page.locator('#genAnlas').textContent());
  anlasBroken = false;

  // --- the counter follows the account, not this app's arithmetic -------
  //
  // Anlas can be spent on the website or in another window, so a figure
  // that only ever counted down from what this app thought it had spent
  // would drift away from the truth. The number moves the moment a
  // generation finishes, and then NovelAI's own figure replaces it.
  await page.reload(); await page.waitForSelector('.tool-tab'); await sleep(900);
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(1400);
  check('the balance is on screen without hunting for it',
    await page.locator('#genAnlas').isVisible() &&
    (await page.locator('#genAnlas').textContent()).includes('4,136'),
    await page.locator('#genAnlas').textContent());
  const anlasSize = await page.locator('#genAnlas').evaluate(
    (n) => parseFloat(getComputedStyle(n).fontSize));
  check('and it is big enough to read at a glance', anlasSize >= 13,
    `${anlasSize}px`);

  // Spending it for real: the stand-in now charges, the way the account
  // does.
  anlasAuto = true;
  await page.fill('#genPrompt', 'a balance test');
  const callsBefore = naiCalls;
  await page.click('#genGo'); await sleep(500);
  // The page was reloaded above, so the once-a-session warning is back.
  if (await page.locator('#confirmModal').isVisible()) {
    await page.click('#confirmOk');
  }
  for (let i = 0; i < 60 && naiCalls === callsBefore; i++) await sleep(250);
  await sleep(600);
  check('the counter drops as soon as the generation lands',
    !(await page.locator('#genAnlasDelta').isHidden()) &&
    (await page.locator('#genAnlasDelta').textContent()).startsWith('−'),
    await page.locator('#genAnlasDelta').textContent());
  check('and says the figure is an estimate until it is confirmed',
    await page.locator('#genAnlas').getAttribute('data-estimated') === 'yes',
    await page.locator('#genAnlas').getAttribute('data-estimated'));

  // Then the account's own number arrives and takes over.
  await sleep(9500);
  const settled = await page.locator('#genAnlas').textContent();
  check('then NovelAI\'s own figure replaces the estimate',
    settled.includes((anlasFixed + anlasPurchased).toLocaleString()) &&
    await page.locator('#genAnlas').getAttribute('data-estimated') === 'no',
    `${settled} vs ${(anlasFixed + anlasPurchased).toLocaleString()}`);
  anlasAuto = false;

  // Anlas spent somewhere else shows up when asked for.
  anlasFixed = 2500;
  await page.click('#genAnlasRefresh'); await sleep(1200);
  check('and the refresh button picks up spending from anywhere else',
    (await page.locator('#genAnlas').textContent()).includes('2,636'),
    await page.locator('#genAnlas').textContent());
  anlasFixed = 4000;
  await page.click('#genAnlasRefresh'); await sleep(1000);

  // --- what a generation costs -----------------------------------------
  // NovelAI publishes the conditions for a free generation rather than its
  // prices: one image, no bigger than a Normal size, 28 steps or fewer, no
  // base image, V4.5 or older. Whether the account has them at all comes
  // from the account.
  await page.selectOption('#genModel', 'nai-diffusion-4-5-full'); await sleep(300);
  await page.fill('#genSteps', '28'); await page.locator('#genSteps').blur(); await sleep(400);
  check('a generation the account gets free says Free',
    (await page.locator('#genGo').textContent()).includes('Free'),
    await page.locator('#genGo').textContent());

  await page.fill('#genSteps', '40'); await page.locator('#genSteps').blur(); await sleep(400);
  check('but not past the step limit',
    /Anlas/.test(await page.locator('#genGo').textContent()),
    await page.locator('#genGo').textContent());
  await page.fill('#genSteps', '28'); await page.locator('#genSteps').blur(); await sleep(300);
  await page.selectOption('#genCount', '2'); await sleep(400);
  check('and not for more than one image at a time',
    /Anlas/.test(await page.locator('#genGo').textContent()),
    await page.locator('#genGo').textContent());
  await page.selectOption('#genCount', '1'); await sleep(300);
  await page.selectOption('#genModel', 'nai-diffusion-5-full'); await sleep(400);
  check('and not on V5, which is outside the allowance',
    /Anlas/.test(await page.locator('#genGo').textContent()),
    await page.locator('#genGo').textContent());

  // An account without the perk is never told anything is free.
  anlasFree = false; anlasTier = 1;
  await page.selectOption('#genModel', 'nai-diffusion-4-5-full'); await sleep(300);
  await page.click('#genAnlasRefresh'); await sleep(1200);
  check('an account without free generations is never told it has them',
    /Anlas/.test(await page.locator('#genGo').textContent()),
    await page.locator('#genGo').textContent());
  anlasFree = true; anlasTier = 3;
  await page.click('#genAnlasRefresh'); await sleep(1000);

  // --- weighted prompts are coloured in ---------------------------------
  //
  // `1.5::x::` asks for more of something and `-1::x::` asks for less. In a
  // plain box they differ by one character, which is a thin way to tell
  // apart "give me this" and "keep this out".
  await page.fill('#genPrompt',
    'a girl, 1.5::red scarf::, -1::hat::, standing');
  await sleep(400);
  const weights = await page.evaluate(() => {
    const layer = document.querySelector('#genPrompt')
      .closest('.hl-wrap').querySelector('.hl-layer');
    const pick = (sel) => [...layer.querySelectorAll(sel)].map((n) => n.textContent);
    const colour = (sel) => {
      const n = layer.querySelector(sel);
      return n ? getComputedStyle(n).color : '';
    };
    return {
      pos: pick('.w-pos .w-text'),
      neg: pick('.w-neg .w-text'),
      plain: layer.textContent,
      posColour: colour('.w-pos .w-num'),
      negColour: colour('.w-neg .w-num'),
      hidden: getComputedStyle(document.querySelector('#genPrompt')).color,
    };
  });
  check('a positive weight is picked out', weights.pos.join('|') === 'red scarf',
    weights.pos.join('|'));
  check('and a negative one separately', weights.neg.join('|') === 'hat',
    weights.neg.join('|'));
  check('in two different colours',
    weights.posColour !== weights.negColour && !!weights.posColour,
    `${weights.posColour} vs ${weights.negColour}`);
  check('the words themselves are all still there',
    weights.plain.includes('a girl, 1.5::red scarf::, -1::hat::, standing'),
    weights.plain);
  check('and the field itself does not double the text',
    /rgba\(0, 0, 0, 0\)|transparent/.test(weights.hidden), weights.hidden);

  // What the box holds is what gets sent — the colouring is only paint.
  check('what is typed is what is sent',
    (await page.inputValue('#genPrompt')) === 'a girl, 1.5::red scarf::, -1::hat::, standing');

  // Setting a value in code fires no input event, so the layer has to be
  // repainted by hand or it keeps showing the previous prompt.
  await page.evaluate(() => { gEl('genPrompt').value = '2::sunset::'; genUpdateCost(); });
  await sleep(300);
  check('a prompt filled in by the app is coloured too',
    await page.evaluate(() => document.querySelector('#genPrompt')
      .closest('.hl-wrap').querySelector('.w-pos .w-text')?.textContent) === 'sunset');

  // Character boxes are rebuilt whenever one is added or removed, so their
  // layers have to come back with them.
  await page.click('#genAddChar'); await sleep(400);
  await page.locator('.gen-char').last().locator('.gen-char-box')
    .fill('-1.5::glasses::'); await sleep(400);
  check('character boxes are coloured the same way',
    await page.evaluate(() => {
      const box = document.querySelectorAll('#genChars .gen-char-box');
      const last = box[box.length - 1];
      return last.closest('.hl-wrap')?.querySelector('.w-neg .w-text')?.textContent;
    }) === 'glasses');
  await page.locator('.gen-char').last().locator('[data-act="remove"]').click();
  await sleep(300);
  await page.fill('#genPrompt', '');

  // --- dropping a NovelAI PNG in ---------------------------------------
  await page.fill('#genPrompt', '');
  const seededPath = path.join(SEED, 'safe-landscape.png');
  const dt = await page.evaluateHandle(async ([b64, name]) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'image/png' }));
    return dt;
  }, [fs.readFileSync(seededPath).toString('base64'), 'safe-landscape.png']);
  await page.dispatchEvent('#toolGenerate', 'drop', { dataTransfer: dt });
  await sleep(1200);

  // Dropping asks what the picture is for rather than deciding: the same
  // image can be wanted as a reference or as a recipe, and guessing turned
  // a plain generation into img2img without saying so.
  check('dropping an image asks what to do with it',
    await page.locator('#genImportModal').isVisible());
  check('and offers the two things this app cannot do, greyed',
    await page.locator('.import-actions .btn[disabled]').count() === 2);
  check('with the metadata section shown for a NovelAI PNG',
    await page.locator('#genImportMeta').isVisible());

  await page.click('#genImportGo'); await sleep(800);
  check('importing metadata fills the prompt',
    (await page.inputValue('#genPrompt')).includes('scenic landscape'),
    await page.inputValue('#genPrompt'));
  check('and the settings',
    (await page.inputValue('#genSteps')) === '28');
  check('and importing metadata does not make it a reference image',
    await page.locator('#genRefEmpty').isVisible(),
    'a metadata import silently became img2img');
  // An image naming a model this app does not list falls back to the
  // newest rather than leaving an identifier NovelAI will reject.
  check('a model it does not recognise falls back to V5',
    (await page.inputValue('#genModel')) === 'nai-diffusion-5-full',
    await page.inputValue('#genModel'));
  check('and the Other box is left empty, not carrying a stale name',
    (await page.inputValue('#genModelCustom')) === '');
  check('but leaves the seed alone unless it was ticked',
    (await page.inputValue('#genSeed')) === '');

  // A file with nothing in it says so rather than silently doing nothing.
  const junk = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' }));
    return dt;
  });
  await page.dispatchEvent('#toolGenerate', 'drop', { dataTransfer: junk });
  await sleep(700);
  check('and a file that is not an image is refused',
    (await page.inputValue('#genPrompt')).includes('scenic landscape') &&
    await page.locator('#genImportModal').isHidden());

  // --- an image with characters comes back with its characters ----------
  //
  // This is the whole point of reuse: a two-character picture must return
  // as two characters, not one merged prompt with the people lost.
  const two = (await fetch(`${BASE}api/images?limit=50`).then(r => r.json()))
    .items.find((i) => (i.meta?.prompt || '').includes('park bench'));
  check('the two-character image is in the library', !!two);

  await page.click('.tool-tab[data-tool="gallery"]'); await sleep(700);
  await page.locator(`.card[data-id="${two.id}"]`).click({ position: { x: 8, y: 60 } });
  await page.locator('#lightbox').waitFor({ state: 'visible' }); await sleep(700);
  await page.locator('#editGenBtn').scrollIntoViewIfNeeded();
  await page.locator('#editGenBtn').click(); await sleep(1000);
  // Reuse asks what to bring over now, the same as a dropped file does.
  await page.locator('#genImportModal').waitFor({ state: 'visible', timeout: 10000 });
  check('reuse asks what to bring over, characters included',
    await page.locator('#impChars').isChecked());
  await page.click('#genImportGo'); await sleep(900);

  check('reusing it rebuilds both characters',
    await page.locator('.gen-char').count() === 2,
    `${await page.locator('.gen-char').count()} characters`);
  check('with the right prompts',
    (await page.locator('.gen-char').first().locator('.gen-char-box').inputValue())
      .includes('red hair'));
  check('and each character keeps its own UC', await (async () => {
    await page.locator('.gen-char').first().locator('.gen-tab[data-tab="uc"]').click();
    await sleep(300);
    return (await page.locator('.gen-char').first().locator('.gen-char-box').inputValue()) === 'hat';
  })());
  check('positions come back as Custom, since the image used them',
    await page.locator('.gen-segbtn[data-pos="custom"]').evaluate((n) => n.classList.contains('active')));
  check('and the coordinates survive',
    (await page.locator('.gen-char-at').first().textContent()).includes('30%'),
    await page.locator('.gen-char-at').first().textContent());

  // Reusing an image with no characters must clear the ones left behind.
  const plain = (await fetch(`${BASE}api/images?limit=50`).then(r => r.json()))
    .items.find((i) => (i.meta?.prompt || '').includes('scenic landscape'));
  await page.click('.tool-tab[data-tool="gallery"]'); await sleep(600);
  await page.locator(`.card[data-id="${plain.id}"]`).click({ position: { x: 8, y: 60 } });
  await page.locator('#lightbox').waitFor({ state: 'visible' }); await sleep(700);
  await page.locator('#editGenBtn').scrollIntoViewIfNeeded();
  await page.locator('#editGenBtn').click(); await sleep(900);
  await page.locator('#genImportModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#genImportGo'); await sleep(900);
  check('reusing an image without characters clears the old ones',
    await page.locator('.gen-char').count() === 0);

  // --- reference images and inpainting ----------------------------------
  await page.click('.tool-tab[data-tool="generate"]'); await sleep(600);

  // The import checks above left a reference loaded, so clear it to see the
  // state someone opening the tab fresh would get.
  if (await page.locator('#genRefClear').isVisible()) {
    await page.click('#genRefClear'); await sleep(500);
  }

  // Before anything is loaded: what you could add, with the two this app
  // has not built greyed rather than hidden.
  check('the reference list is shown before anything is loaded',
    await page.locator('#genRefEmpty').isVisible() &&
    await page.locator('#genRefActive').isHidden());
  check('with three options offered',
    await page.locator('.gen-refopt').count() === 3);
  check('and the two that are not supported marked as such',
    await page.locator('.gen-refopt.disabled').count() === 2);
  check('the sliders are not there yet',
    await page.locator('#genRefSliders').isHidden());

  // Dropping a picture in sets it as a reference.
  const dt2 = await page.evaluateHandle(async ([b64, name]) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'image/png' }));
    return dt;
  }, [fs.readFileSync(path.join(SEED, 'safe-portrait.png')).toString('base64'), 'safe-portrait.png']);
  await page.dispatchEvent('#toolGenerate', 'drop', { dataTransfer: dt2 });
  await sleep(1400);
  check('the dialog offers Image2Image', await page.locator('#genImportI2I').isVisible());
  await page.click('#genImportI2I'); await sleep(1200);

  check('choosing Image2Image makes it the reference',
    await page.locator('#genRefActive').isVisible() &&
    await page.locator('#genRefEmpty').isHidden());

  // The size sent has to be the reference's own size. Asking NovelAI to
  // generate a different resolution from the image it is working over is a
  // mismatch it refuses, and it was what made import-then-generate fail.
  const refSizeText = await page.locator('#genRefSize').textContent();
  check('the reference states the size it forces', /\d+ × \d+/.test(refSizeText), refSizeText);
  const chosen = await page.locator('#genSize option:checked').textContent();
  check('and the size control follows it',
    chosen.includes('700') || refSizeText.includes(chosen.replace(/[^0-9×]/g, '')),
    `${chosen} vs ${refSizeText}`);

  // Generating with it must ask for exactly that size.
  const before = naiCalls;
  await page.click('#genGo'); await sleep(600);
  if (await page.locator('#confirmModal').isVisible()) { await page.click('#confirmOk'); }
  await sleep(2500);
  check('a generation from a reference reaches NovelAI', naiCalls > before);
  check('and asks for the reference size',
    lastBody?.parameters?.width === 700 && lastBody?.parameters?.height === 1000,
    JSON.stringify({ w: lastBody?.parameters?.width, h: lastBody?.parameters?.height }));
  check('as img2img, not a fresh generate', lastBody?.action === 'img2img', lastBody?.action);
  check('with no add_original_image, which is an inpainting setting',
    !('add_original_image' in (lastBody?.parameters || {})));
  check('which is Image2Image until a mask is painted',
    (await page.locator('#genRefName').textContent()).includes('Image2Image'));
  check('and the sliders stay away until then',
    await page.locator('#genRefSliders').isHidden());

  // Painting a mask.
  await page.click('#genInpaintBtn'); await sleep(900);
  check('Inpaint opens the mask painter', await page.locator('#genMaskModal').isVisible());
  check('and saving is refused while nothing is painted',
    await page.locator('#maskSave').isDisabled());

  // The mask has to sit exactly on the picture. When the frame was fitted
  // by CSS the image was letterboxed inside it while the canvas stretched
  // to fill it, so paint landed somewhere other than where the pointer was.
  const rects = await page.evaluate(() => {
    const i = document.getElementById('maskImg').getBoundingClientRect();
    const c = document.getElementById('maskCanvas').getBoundingClientRect();
    const img = document.getElementById('maskImg');
    return { i: [i.x, i.y, i.width, i.height], c: [c.x, c.y, c.width, c.height],
      ratio: img.naturalWidth / img.naturalHeight };
  });
  check('the mask lies exactly on the picture',
    rects.i.every((v, n) => Math.abs(v - rects.c[n]) < 1),
    JSON.stringify(rects));
  check('and the picture keeps its own shape',
    Math.abs((rects.i[2] / rects.i[3]) - rects.ratio) < 0.02,
    `${(rects.i[2] / rects.i[3]).toFixed(3)} vs ${rects.ratio.toFixed(3)}`);

  // A landscape picture is the case that was actually broken: the frame was
  // as tall as the stage and only its width was clamped, so the image was
  // letterboxed inside a frame the canvas filled. The painter is opened
  // directly here because that is the layout under test, and getting a wide
  // reference in through the interface would prove nothing extra.
  // Narrowed on purpose: with a roomy window a wide picture fits anyway and
  // the broken layout looked fine. It is the window that is too narrow for
  // the picture that exposes it.
  const wasViewport = page.viewportSize();
  await page.setViewportSize({ width: 780, height: 900 }); await sleep(400);
  const wide = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1216; c.height = 832;
    const x = c.getContext('2d');
    x.fillStyle = '#345'; x.fillRect(0, 0, c.width, c.height);
    maskOpen(c.toDataURL('image/png'), () => {});
    await new Promise((r) => setTimeout(r, 500));
    const i = document.getElementById('maskImg').getBoundingClientRect();
    const cv = document.getElementById('maskCanvas').getBoundingClientRect();
    return { i: [i.x, i.y, i.width, i.height], c: [cv.x, cv.y, cv.width, cv.height],
      ratio: i.width / i.height };
  });
  check('a landscape picture lines up too',
    wide.i.every((v, n) => Math.abs(v - wide.c[n]) < 1) &&
    Math.abs(wide.ratio - 1216 / 832) < 0.02,
    JSON.stringify(wide));

  // Back to the picture the rest of this section is about.
  await page.click('#maskCancel'); await sleep(300);
  await page.setViewportSize(wasViewport); await sleep(400);
  await page.click('#genInpaintBtn'); await sleep(900);

  // NovelAI works masks in 8px blocks, so a brush finer than that paints
  // nothing that survives its downscale.
  const pen = page.locator('#maskPen');
  check('the brush cannot be set finer than NovelAI\'s 8px mask block',
    await pen.getAttribute('min') === '8' && await pen.getAttribute('step') === '8',
    `min ${await pen.getAttribute('min')} step ${await pen.getAttribute('step')}`);
  check('and has a stated maximum',
    Number(await pen.getAttribute('max')) === 512);
  await page.evaluate(() => maskSetPen(2));
  check('asking for less than a block gives you a block',
    await page.evaluate(() => MASK.pen) === 8);
  await page.evaluate(() => maskSetPen(9999));
  check('and asking for more than the maximum stops there',
    await page.evaluate(() => MASK.pen) === 512);

  // The keys are there because the slider is at the top of the window and
  // the picture is in the middle of it.
  await page.evaluate(() => maskSetPen(64));
  await page.keyboard.press('['); await sleep(150);
  check('[ takes the brush down a block', await page.evaluate(() => MASK.pen) === 56);
  await page.keyboard.press(']'); await page.keyboard.press(']'); await sleep(150);
  check('] brings it back up', await page.evaluate(() => MASK.pen) === 72);
  await page.evaluate(() => maskSetPen(64));

  const box = await page.locator('#maskCanvas').boundingBox();
  // The cursor is the brush's real footprint on a picture that is being
  // shown smaller than it is.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await sleep(200);
  const cursor = await page.evaluate(() => {
    const c = document.getElementById('maskCursor');
    const canvas = document.getElementById('maskCanvas');
    const r = canvas.getBoundingClientRect();
    return { shown: !c.hidden, w: c.getBoundingClientRect().width,
      want: 64 * (r.width / canvas.width) };
  });
  check('the brush shows its size on the picture',
    cursor.shown && Math.abs(cursor.w - cursor.want) < 2,
    JSON.stringify(cursor));

  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 14 });
  await page.mouse.up();
  await sleep(400);
  check('painting enables saving', !(await page.locator('#maskSave').isDisabled()));

  // Undo puts the stroke back the way it was.
  await page.click('#maskUndo'); await sleep(400);
  check('undo takes the stroke back off', await page.locator('#maskSave').isDisabled());

  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  await page.click('#maskSave'); await sleep(700);

  check('saving a mask closes the painter', await page.locator('#genMaskModal').isHidden());
  check('and turns the reference into inpainting',
    (await page.locator('#genRefName').textContent()).includes('Inpainting'));
  check('which is when the sliders appear',
    await page.locator('#genRefSliders').isVisible());

  // The mask has to be a real black-and-white image, not an empty one.
  const maskOk = await page.evaluate(() => {
    const src = document.getElementById('genRefThumb').src;
    return src.startsWith('data:image/png') && src.length > 200;
  });
  check('the saved mask is a real image', maskOk);

  // And it has to be a mask NovelAI can use as painted. It reduces a mask
  // to an eighth of the picture with nearest sampling, so anything that is
  // not aligned to an 8px block is not approximated - it is resampled, and
  // parts of it simply vanish. Every block must therefore be all-on or
  // all-off, and every pixel pure black or pure white.
  const grid = await page.evaluate(async () => {
    const src = GEN.mask;
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = src; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const at = (x, y) => d[(y * c.width + x) * 4];

    let painted = 0, mixedBlocks = 0, greys = 0;
    for (let by = 0; by < c.height; by += 8) {
      for (let bx = 0; bx < c.width; bx += 8) {
        const first = at(bx, by);
        let same = true;
        for (let y = by; y < Math.min(by + 8, c.height); y++) {
          for (let x = bx; x < Math.min(bx + 8, c.width); x++) {
            const v = at(x, y);
            if (v !== 0 && v !== 255) greys++;
            if (v !== first) same = false;
          }
        }
        if (!same) mixedBlocks++;
        if (first === 255) painted++;
      }
    }
    return { painted, mixedBlocks, greys, w: c.width, h: c.height };
  });
  check('the mask is aligned to NovelAI\'s 8px blocks',
    grid.mixedBlocks === 0, `${grid.mixedBlocks} blocks straddle the grid`);
  check('and is pure black and white, with nothing in between',
    grid.greys === 0, `${grid.greys} grey pixels`);
  check('and actually marks something out',
    grid.painted > 4, `${grid.painted} blocks painted`);
  check('at the picture\'s own size',
    grid.w === 700 && grid.h === 1000, `${grid.w}x${grid.h}`);

  // --- an inpaint carries the whole prompt ------------------------------
  //
  // Repainting part of a picture is still a generation, and it has to be
  // told everything a generation is told: the scene, every character, the
  // undesired content, and each character's own undesired content. A mask
  // that quietly dropped half the prompt would repaint the area from a
  // description nobody wrote.
  await page.fill('#genPrompt', '2girls, park bench, autumn');
  await page.click('.gen-tabs .gen-tab[data-box="negative"]'); await sleep(300);
  await page.fill('#genNegative', 'lowres, bad hands');
  await page.click('.gen-tabs .gen-tab[data-box="prompt"]'); await sleep(300);
  while (await page.locator('.gen-char [data-act="remove"]').count()) {
    await page.locator('.gen-char [data-act="remove"]').first().click();
    await sleep(200);
  }
  await page.click('#genAddChar'); await sleep(250);
  await page.click('#genAddChar'); await sleep(250);
  const chars = page.locator('.gen-char');
  await chars.nth(0).locator('.gen-char-box').fill('red hair, blue dress');
  await chars.nth(1).locator('.gen-char-box').fill('blonde, glasses');
  await chars.nth(0).locator('.gen-tab[data-tab="uc"]').click(); await sleep(200);
  await chars.nth(0).locator('.gen-char-box').fill('hat');
  await chars.nth(1).locator('.gen-tab[data-tab="uc"]').click(); await sleep(200);
  await chars.nth(1).locator('.gen-char-box').fill('scarf');
  await sleep(300);

  lastBody = null;
  await page.click('#genGo');
  await page.locator('#genPreview').waitFor({ state: 'visible', timeout: 15000 });
  await sleep(800);

  const sent = lastBody || {};
  const v4 = sent.parameters?.v4_prompt?.caption || {};
  const v4uc = sent.parameters?.v4_negative_prompt?.caption || {};
  const capt = (o) => (o.char_captions || []).map((c) => c.char_caption);

  check('an inpaint goes out as infill', sent.action === 'infill', sent.action);
  check('and uses the inpainting model',
    /-inpainting$/.test(sent.model || ''), sent.model);
  check('the scene prompt goes with it',
    sent.input === '2girls, park bench, autumn' &&
    v4.base_caption === '2girls, park bench, autumn',
    `${sent.input} | ${v4.base_caption}`);
  check('so does every character',
    JSON.stringify(capt(v4)) === JSON.stringify(['red hair, blue dress', 'blonde, glasses']),
    JSON.stringify(capt(v4)));
  check('so does the undesired content',
    sent.parameters?.negative_prompt === 'lowres, bad hands' &&
    v4uc.base_caption === 'lowres, bad hands',
    `${sent.parameters?.negative_prompt} | ${v4uc.base_caption}`);
  check('and each character\'s own undesired content',
    JSON.stringify(capt(v4uc)) === JSON.stringify(['hat', 'scarf']),
    JSON.stringify(capt(v4uc)));
  check('with the mask and the picture both sent',
    !!sent.parameters?.mask && !!sent.parameters?.image);
  check('and the original kept outside the mask',
    sent.parameters?.add_original_image === true);

  // --- inpainting what is on the stage ----------------------------------
  //
  // Repainting the picture you just made used to mean saving it, finding it
  // in the gallery and importing it back. The button under the picture does
  // the whole thing.
  await page.click('#genRefClear'); await sleep(500);
  check('the picture on the stage offers to be inpainted',
    await page.locator('#genInpaintCurrent').isVisible());
  await page.click('#genInpaintCurrent'); await sleep(1200);
  check('and pressing it opens the painter on that picture',
    await page.locator('#genMaskModal').isVisible());
  check('having made that picture the reference',
    await page.evaluate(() => !!GEN.refImage && /^Generation/.test(GEN.refName)),
    await page.evaluate(() => GEN.refName));

  // --- looking closely ---------------------------------------------------
  // 8px blocks on a picture shrunk to fit a window are a couple of screen
  // pixels; anything careful needs it bigger.
  const maskBox = await page.locator('#maskCanvas').boundingBox();
  const startW = maskBox.width;
  await page.mouse.move(maskBox.x + maskBox.width / 2, maskBox.y + maskBox.height / 2);
  await page.mouse.wheel(0, -240); await sleep(400);
  const zoomed = await page.locator('#maskCanvas').boundingBox();
  check('the wheel zooms the picture in',
    zoomed.width > startW * 1.1, `${startW} → ${zoomed.width}`);
  check('and the zoom is stated', /[0-9]+%/.test(
    await page.locator('#maskZoomVal').textContent()));

  // Painting has to keep landing where the pointer is once it is zoomed.
  const painted = await page.evaluate(async () => {
    const canvas = document.getElementById('maskCanvas');
    const r = canvas.getBoundingClientRect();
    // A point well inside the visible part of the picture.
    const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
    const p = maskPoint({ clientX: cx, clientY: cy });
    return { x: p.x, y: p.y, w: canvas.width, h: canvas.height };
  });
  check('and the pointer still maps onto the picture while zoomed',
    painted.x > 0 && painted.x < painted.w && painted.y > 0 && painted.y < painted.h,
    JSON.stringify(painted));

  // Dragging with the middle button moves the picture rather than painting.
  const beforePan = await page.evaluate(() => ({ x: MASK.panX, y: MASK.panY }));
  const pb = await page.locator('#maskCanvas').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(pb.x + pb.width / 2 - 60, pb.y + pb.height / 2 - 40, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await sleep(300);
  const afterPan = await page.evaluate(() => ({ x: MASK.panX, y: MASK.panY }));
  check('the middle button pans instead of painting',
    afterPan.x !== beforePan.x || afterPan.y !== beforePan.y,
    `${JSON.stringify(beforePan)} → ${JSON.stringify(afterPan)}`);
  check('and panning paints nothing',
    await page.locator('#maskSave').isDisabled());

  // Ctrl still belongs to the brush, so the wheel can belong to the zoom.
  const penBefore = await page.evaluate(() => MASK.pen);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120); await sleep(300);
  await page.keyboard.up('Control');
  check('Ctrl and the wheel still size the brush',
    await page.evaluate(() => MASK.pen) === penBefore + 8,
    `${penBefore} → ${await page.evaluate(() => MASK.pen)}`);

  await page.click('#maskZoomReset'); await sleep(400);
  check('Fit puts the whole picture back',
    await page.evaluate(() => MASK.zoom === 1 && MASK.panX === 0 && MASK.panY === 0));
  await page.click('#maskCancel'); await sleep(400);

  // Removing it goes back to the list, not to an empty card.
  await page.click('#genRefClear'); await sleep(600);
  check('removing the reference returns to the list',
    await page.locator('#genRefEmpty').isVisible() &&
    await page.locator('#genRefActive').isHidden() &&
    await page.locator('#genRefSliders').isHidden());

  check('no page errors overall', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close(); server.kill(); fakeNai.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})().catch((e) => { server?.kill(); fakeNai.close(); console.error(e); process.exit(1); });

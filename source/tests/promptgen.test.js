/* Prompt Generator, driven through the interface. */
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs=require('fs'), os=require('os'), path=require('path');
const REPO=path.join(__dirname,'..');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'nag-pg-')); const SEED=path.join(DATA,'seed');
execFileSync('python3',[path.join(__dirname,'seed.py'),SEED]);
const srv=spawn(process.env.NAG_BIN || path.join(REPO,'app','nag-dev'),[],{env:{...process.env,NOVELAI_GALLERY_DATA:DATA},stdio:['ignore','pipe','pipe']});
let BASE='';const sleep=m=>new Promise(r=>setTimeout(r,m));
let fail=0; const ck=(n,ok,d)=>{console.log(`${ok?'PASS':'FAIL'}  ${n}${ok||!d?'':`\n        ${d}`}`);if(!ok)fail++;};
(async()=>{
  await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('no')),15000);
    const scan=b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+\//);if(m){clearTimeout(t);BASE=m[0];res();}};
    srv.stdout.on('data',scan);srv.stderr.on('data',scan);});
  for(const f of fs.readdirSync(SEED)){const fd=new FormData();
    fd.append('file',new Blob([fs.readFileSync(path.join(SEED,f))]),f);
    await fetch(`${BASE}api/images`,{method:'POST',body:fd});}
  const s0=await fetch(`${BASE}api/settings`).then(r=>r.json());
  await fetch(`${BASE}api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...s0,onboarded:true})});

  const b=await chromium.launch();const p=await b.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text());});
  await p.goto(BASE);await p.waitForSelector('.card');await sleep(900);
  await p.click('.tool-tab[data-tool="prompt"]');await sleep(1200);

  ck('the generator builds on first visit', await p.locator('.pg-bucket').count() >= 10,
     `${await p.locator('.pg-bucket').count()} buckets`);
  const first = await p.locator('#pgOut').textContent();
  ck('and rolls a prompt straight away', first.trim().length > 40, first);
  ck('which starts with the quality prefix', first.startsWith('masterpiece'), first.slice(0,60));
  ck('and contains Danbooru artist tags', /artist:/.test(first));

  // Lock, then reroll: the locked bucket must survive.
  const outfitText = () => p.locator('.pg-bucket[data-id="outfit"] textarea').inputValue();
  const before = await outfitText();
  await p.click('.pg-bucket[data-id="outfit"] [data-act="lock"]');
  await sleep(200);
  for (let i=0;i<6;i++){ await p.click('#pgReroll'); await sleep(150); }
  ck('a locked bucket survives repeated rerolls', (await outfitText()) === before,
     `${before} -> ${await outfitText()}`);

  // Turning a bucket off removes it from the prompt.
  const loc = await p.locator('.pg-bucket[data-id="location"] textarea').inputValue();
  await p.click('.pg-bucket[data-id="location"] [data-act="toggle"]');
  await sleep(300);
  const withoutLoc = await p.locator('#pgOut').textContent();
  ck('switching a bucket off drops it from the prompt',
     !pgHas(withoutLoc, loc), `looking for "${loc}"`);
  await p.click('.pg-bucket[data-id="location"] [data-act="toggle"]');
  await sleep(300);

  // The mix slider.
  await p.locator('#pgMix').fill('100'); await sleep(400);
  const prose = await p.locator('#pgOut').textContent();
  ck('at full prose it reads as sentences', /\. /.test(prose) || /\.$/.test(prose.trim()), prose);
  ck('and artists are still tags, not prose', /artist:/.test(prose));
  await p.locator('#pgMix').fill('0'); await sleep(400);

  // Must / never.
  await p.fill('#pgMust','twintails, red scarf'); await sleep(400);
  const withMust = await p.locator('#pgOut').textContent();
  ck('must-include tags always appear', withMust.includes('twintails') && withMust.includes('red scarf'));

  await p.fill('#pgBan','beach, forest'); await sleep(200);
  let banned=false;
  for(let i=0;i<15;i++){ await p.click('#pgRoll'); await sleep(120);
    const t=await p.locator('#pgOut').textContent();
    if(/\bbeach\b|\bforest\b/.test(t)) banned=true; }
  ck('banned tags never turn up across 15 rolls', !banned);

  // Editing a pool persists. Extras lives in a section that starts folded,
  // so open it first - the same thing a person would have to do.
  await p.click('.pg-group[data-group="framing"] .pg-group-head'); await sleep(350);
  await p.click('.pg-bucket[data-id="extras"] [data-act="edit"]'); await sleep(400);
  await p.fill('#askInput','test-tag-one, test-tag-two');
  await p.click('#askOk'); await sleep(700);
  const cfg = await fetch(`${BASE}api/promptgen`).then(r=>r.json());
  const extras = cfg.buckets.find(x=>x.id==='extras');
  ck('an edited pool is saved to disk',
     JSON.stringify(extras.tags)==='["test-tag-one","test-tag-two"]', JSON.stringify(extras.tags));

  // Presets.
  await p.click('#pgSave'); await sleep(400);
  await p.fill('#askInput','my preset'); await p.click('#askOk'); await sleep(700);
  ck('a preset is saved and listed', await p.locator('.pg-preset').count()===1);

  // Mining the library.
  const mined = await fetch(`${BASE}api/promptgen/mine`).then(r=>r.json());
  ck('the library can be mined for tags actually in use',
     Array.isArray(mined) && mined.length>0 && mined[0].count>=1,
     JSON.stringify(mined.slice(0,3)));

  // Going back to the gallery must still work.
  await p.click('.tool-tab[data-tool="gallery"]'); await sleep(800);
  ck('the gallery is unharmed by all of that', await p.locator('.card').count()===7);

  // --- the redesign: groups, folding, section switches -----------------
  // The gallery check above left us on the other tab.
  await p.click('.tool-tab[data-tool="prompt"]'); await sleep(600);
  ck('buckets are grouped into sections', await p.locator('.pg-group').count() === 6,
     `${await p.locator('.pg-group').count()} groups`);

  const wardrobeBody = p.locator('.pg-group[data-group="wardrobe"] .pg-group-body');
  ck('an open section shows its buckets', await wardrobeBody.isVisible());
  await p.click('.pg-group[data-group="wardrobe"] .pg-group-head');
  await sleep(300);
  ck('clicking the header folds it away', !(await wardrobeBody.isVisible()));
  await p.click('.pg-group[data-group="wardrobe"] .pg-group-head');
  await sleep(300);
  ck('and clicking again brings it back', await wardrobeBody.isVisible());

  // Folding must not change the prompt - it is a view, not a switch.
  const beforeFold = await p.locator('#pgOut').textContent();
  await p.click('.pg-group[data-group="scene"] .pg-group-head');
  await sleep(300);
  ck('folding a section does not change the prompt',
     (await p.locator('#pgOut').textContent()) === beforeFold);
  await p.click('.pg-group[data-group="scene"] .pg-group-head');
  await sleep(300);

  // A section holding one pool must not show the same switch twice - once
  // on the section and once on the pool inside it.
  const dupes = await p.locator('.pg-group').evaluateAll((groups) =>
    groups.filter((g) => g.querySelectorAll('.pg-bucket').length === 1
      && g.querySelector('[data-act="groupToggle"]')).length);
  ck('a section with one pool shows one switch, not two', dupes === 0, `${dupes} duplicated`);
  ck('sections with several pools keep their own switch',
    await p.locator('.pg-group[data-group="scene"] [data-act="groupToggle"]').count() === 1);

  // The section switch does change it.
  const loc2 = await p.locator('.pg-bucket[data-id="location"] textarea').inputValue();
  await p.click('.pg-group[data-group="scene"] [data-act="groupToggle"]');
  await sleep(400);
  ck('switching a whole section off drops all of it',
     !pgHas(await p.locator('#pgOut').textContent(), loc2), `looking for "${loc2}"`);
  await p.click('.pg-group[data-group="scene"] [data-act="groupToggle"]');
  await sleep(400);
  ck('and switching it back on restores it',
     pgHas(await p.locator('#pgOut').textContent(), loc2));

  // --- characters from a series -----------------------------------------
  ck('series are offered', await p.locator('#pgSeries option').count() >= 8);
  await p.selectOption('#pgSeries', 'Chainsaw Man');
  await sleep(300);
  const chars = await p.locator('#pgCharacter option').allTextContents();
  ck('picking a series lists its characters',
     chars.some((c) => /makima/i.test(c)), chars.join(', '));

  await p.selectOption('#pgCharacter', 'makima_(chainsaw_man)');
  await p.check('#pgCharOn');
  await sleep(500);
  const withChar = await p.locator('#pgOut').textContent();
  ck('the chosen character is in the prompt', withChar.includes('makima_(chainsaw_man)'));
  ck('and the buckets that would fight it are switched off',
     !(await p.locator('.pg-bucket[data-id="outfit"]').evaluate((n) => n.classList.contains('off')) === false),
     'outfit should be dimmed');

  const outfitTags = await p.locator('.pg-bucket[data-id="outfit"] textarea').inputValue();
  ck('so its outfit tags are not in the prompt either',
     !pgHas(withChar, outfitTags), `looking for "${outfitTags}"`);

  await p.uncheck('#pgCharOn');
  await sleep(500);
  const withoutChar = await p.locator('#pgOut').textContent();
  ck('turning the character off removes it', !withoutChar.includes('makima'));
  ck('and hands the wardrobe back', pgHas(withoutChar, outfitTags));

  await p.click('#pgCharRandom');
  await sleep(500);
  ck('Random picks a character and switches it on',
     (await p.isChecked('#pgCharOn')) &&
     (await p.locator('#pgOut').textContent()).includes((await p.inputValue('#pgCharacter'))));
  await p.uncheck('#pgCharOn'); await sleep(300);

  ck('no page errors', errs.length===0, errs.slice(0,3).join(' | '));
  await p.click('.tool-tab[data-tool="prompt"]'); await sleep(600);
  await p.screenshot({path: path.join(__dirname,'screenshots','promptgen.png'), fullPage:false});
  await b.close();srv.kill();fs.rmSync(DATA,{recursive:true,force:true});
  console.log(fail?`\n${fail} failing`:'\nall passing');
  process.exit(fail?1:0);
})().catch(e=>{srv.kill();console.error(e);process.exit(1)});

// Whole-tag matching. Plain substring matching reported "scarf" as present
// because the must-include field contained "red scarf", which made a passing
// feature look broken.
function pgHas(text, csv){
  return csv.split(',').map(s=>s.trim()).filter(Boolean).some((t) => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|,\\s*)${esc}(\\s*,|\\s*$)`, 'm').test(text);
  });
}

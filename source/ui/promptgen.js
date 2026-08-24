/* Prompt Generator.
 *
 * Rolls a NovelAI prompt from pools you control. The design goal is that a
 * roll is *coherent* rather than merely random: picking a scene biases
 * every bucket toward things that belong together, so you get "rainy night,
 * neon reflections, umbrella" instead of "rainy night, beach, sunbathing".
 *
 * Everything is Danbooru vocabulary, because that is what the models were
 * trained on: `artist:name` for artists and ordinary booru words for the
 * rest. Emphasis uses NovelAI's own syntax - {tag} to strengthen, [tag] to
 * weaken, and `1.3::tag ::` where a precise weight is wanted.
 *
 * Rolling happens here rather than on the server: it is a handful of random
 * picks and should feel instant. The server owns the pools and presets.
 */

const PG = {
  cfg: null,
  // bucket id -> { text, locked, on, prose }
  state: {},
  mix: 0,
  scene: 'Any',
  // Group id -> collapsed. Style and framing start folded: they are set
  // once and then rarely touched, unlike the scene and the wardrobe.
  collapsed: { style: false, subject: false, wardrobe: false, action: false, scene: false, framing: true },
  character: null,
};

const PG_GROUPS = [
  ['style', 'Art style'],
  ['subject', 'Subject'],
  ['wardrobe', 'Wardrobe'],
  ['action', 'Expression & pose'],
  ['scene', 'Scene'],
  ['framing', 'Framing & extras'],
];

// Buckets a character tag brings its own answer to. Rolling these on top of
// "makima_(chainsaw_man)" fights the character rather than dressing her.
const PG_CHARACTER_OWNS = ['appearance', 'outfit', 'accessory'];

const pgEl = (id) => document.getElementById(id);

const pgSplit = (s) => String(s || '')
  .split(',').map((t) => t.trim()).filter(Boolean);

/* A seeded shuffle would let a roll be reproduced, but the far more common
   wish is "give me another" - so this is plain Math.random and the history
   is what makes a roll recoverable. */
function pgPick(pool, n) {
  const bag = [...new Set(pool)];
  const out = [];
  for (let i = 0; i < n && bag.length; i++) {
    out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  }
  return out;
}

function pgBucket(id) {
  return (PG.cfg?.buckets || []).find((b) => b.id === id);
}

function pgScene() {
  return (PG.cfg?.scenes || []).find((s) => s.Name === PG.scene || s.name === PG.scene);
}

/* Rolling one bucket.
 *
 * A scene doesn't restrict the pool, it weights it: preferred entries are
 * far more likely but the rest stay reachable, so a scene still surprises
 * you occasionally instead of cycling the same six tags. */
function pgRollBucket(b, banned) {
  const scene = pgScene();
  const prefer = (scene?.prefer || scene?.Prefer || {})[b.id] || [];
  const ok = (t) => !banned.includes(t.toLowerCase());

  const pool = [];
  for (const t of b.tags || []) {
    if (!ok(t)) continue;
    // Four entries for a preferred tag against one for the rest: strongly
    // steered, never a closed set.
    pool.push(t);
    if (prefer.includes(t)) pool.push(t, t, t);
  }
  if (!pool.length) return '';

  const min = Math.max(0, b.min ?? 1);
  const max = Math.max(min, b.max ?? min);
  const n = min + Math.floor(Math.random() * (max - min + 1));
  return pgPick(pool, n).join(', ');
}

function pgRoll({ onlyUnlocked = false } = {}) {
  const banned = pgSplit(pgEl('pgBan').value).map((t) => t.toLowerCase());
  for (const b of PG.cfg.buckets) {
    const st = PG.state[b.id] || (PG.state[b.id] = { text: '', locked: false, on: true });
    if (onlyUnlocked && st.locked) continue;
    st.text = pgRollBucket(b, banned);
  }
  pgRenderBuckets();
  pgCompile();
}

/* --- turning buckets into a prompt ----------------------------------- */

/* Reading tags back as a sentence.
 *
 * This is deliberately simple joining rather than an attempt at grammar: a
 * clumsy sentence built from the right tags beats a fluent one that dropped
 * half of them, and the model reads both. */
function pgProse(id, tags) {
  if (!tags.length) return '';
  const list = tags.map((t) => t.replace(/_/g, ' '));
  const join = (a) => a.length > 1
    ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
    : a[0];
  switch (id) {
    case 'appearance':  return `She has ${join(list)}.`;
    case 'outfit':      return `She is wearing ${join(list)}.`;
    case 'accessory':   return `She has ${join(list)} with her.`;
    case 'expression':  return `Her expression is ${join(list)}.`;
    case 'pose':        return `She is ${join(list)}.`;
    case 'location':    return `The scene is set in ${join(list)}.`;
    case 'time':        return `It is ${join(list)}.`;
    case 'lighting':    return `The light is ${join(list)}.`;
    case 'extras':      return `There is ${join(list)}.`;
    default:            return `${join(list)}.`;
  }
}

function pgCompile() {
  const mix = PG.mix;
  const must = pgSplit(pgEl('pgMust').value);

  const tagParts = [];
  const proseParts = [];

  for (const b of PG.cfg.buckets) {
    const st = PG.state[b.id];
    if (!st || !st.on || !st.text.trim()) continue;
    const tags = pgSplit(st.text);

    // Artists, character count and composition stay as tags at every mix:
    // they are labels the model matches, not description it reads.
    const canProse = b.prose && st.prose !== false;
    if (canProse && mix > 0 && Math.random() * 100 < mix) {
      proseParts.push(pgProse(b.id, tags));
    } else if (canProse && mix >= 100) {
      proseParts.push(pgProse(b.id, tags));
    } else {
      tagParts.push(...tags);
    }
  }

  // A chosen character goes in as a tag, always - it is the one thing in
  // the prompt that was picked rather than rolled.
  if (PG.character && pgEl('pgCharOn').checked) {
    tagParts.unshift(PG.character);
  }

  const out = [];
  if (pgEl('pgQuality').checked && pgEl('pgQualityText').value.trim()) {
    out.push(pgEl('pgQualityText').value.trim());
  }
  if (tagParts.length) out.push(tagParts.join(', '));
  if (proseParts.length) out.push(proseParts.join(' '));
  // Must-have tags go last so nothing above can push them out of the
  // model's attention, and they are never subject to the mix.
  if (must.length) out.push(must.join(', '));

  pgEl('pgOut').textContent = out.join('\n');
  pgEl('pgMixRead').textContent = mix === 0
    ? 'all tags'
    : (mix === 100 ? 'all prose (except artists and framing)' : `${100 - mix}% tags · ${mix}% prose`);
}

/* --- the bucket rows -------------------------------------------------- */

function pgGroupOf(id) {
  return (PG.cfg?.buckets || []).filter((b) => (b.group || 'subject') === id);
}

function pgRenderBuckets() {
  const host = pgEl('pgBuckets');
  host.innerHTML = PG_GROUPS.map(([gid, label]) => {
    const buckets = pgGroupOf(gid);
    if (!buckets.length) return '';
    const folded = PG.collapsed[gid];
    // A group counts as on when any bucket in it is on, so the group switch
    // reads as "is this section contributing anything".
    const anyOn = buckets.some((b) => PG.state[b.id]?.on);
    // With one pool in the section, the section switch and the pool's own
    // switch are the same switch drawn twice. Only the pool keeps one.
    const groupSwitch = buckets.length > 1;
    return `
      <section class="pg-group${folded ? ' folded' : ''}" data-group="${gid}">
        <div class="pg-group-head" data-act="fold">
          <span class="pg-caret">${folded ? '▸' : '▾'}</span>
          <span class="pg-group-name">${esc(label)}</span>
          <span class="pg-group-count">${buckets.length}</span>
          <div class="topbar-spacer"></div>
          ${groupSwitch ? `
            <button class="pg-icon${anyOn ? ' on' : ''}" data-act="groupToggle"
              title="${anyOn ? 'Section is in the prompt' : 'Section is switched off'}"
              aria-label="Toggle section">${anyOn ? '●' : '○'}</button>` : ''}
        </div>
        <div class="pg-group-body">${pgBucketRows(buckets)}</div>
      </section>`;
  }).join('');

  host.querySelectorAll('.pg-group-head').forEach((head) => {
    const gid = head.closest('.pg-group').dataset.group;
    head.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="groupToggle"]')) {
        const buckets = pgGroupOf(gid);
        const anyOn = buckets.some((b) => PG.state[b.id]?.on);
        buckets.forEach((b) => { PG.state[b.id].on = !anyOn; });
        pgRenderBuckets();
        return pgCompile();
      }
      PG.collapsed[gid] = !PG.collapsed[gid];
      pgRenderBuckets();
    });
  });

  pgWireBucketRows(host);
}

function pgBucketRows(buckets) {
  return buckets.map((b) => {
    const st = PG.state[b.id] || { text: '', locked: false, on: true };
    return `
      <div class="pg-bucket${st.on ? '' : ' off'}" data-id="${esc(b.id)}">
        <div class="pg-bucket-head">
          <span class="pg-bucket-name">${esc(b.label)}</span>
          ${b.prose ? '' : '<span class="pg-badge" title="Always rendered as tags">tags only</span>'}
          <div class="topbar-spacer"></div>
          <button class="pg-icon${st.locked ? ' on' : ''}" data-act="lock"
            title="${st.locked ? 'Locked — reroll leaves this alone' : 'Lock this bucket'}"
            aria-label="Lock">${st.locked ? '🔒' : '🔓'}</button>
          <button class="pg-icon" data-act="reroll" title="Roll just this one" aria-label="Reroll">↻</button>
          <button class="pg-icon${st.on ? ' on' : ''}" data-act="toggle"
            title="${st.on ? 'In the prompt' : 'Left out of the prompt'}" aria-label="Include">${st.on ? '●' : '○'}</button>
          <button class="pg-icon" data-act="edit" title="Edit this pool" aria-label="Edit pool">⋯</button>
        </div>
        <textarea class="pg-input mono pg-bucket-text" rows="2" spellcheck="false"
          placeholder="empty — roll, or type your own">${esc(st.text)}</textarea>
      </div>`;
  }).join('');
}

function pgWireBucketRows(host) {
  host.querySelectorAll('.pg-bucket').forEach((row) => {
    const id = row.dataset.id;
    const st = PG.state[id];
    row.querySelector('.pg-bucket-text').addEventListener('input', (e) => {
      st.text = e.target.value;
      pgCompile();
    });
    row.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'lock') st.locked = !st.locked;
        if (act === 'toggle') st.on = !st.on;
        if (act === 'reroll') {
          st.text = pgRollBucket(pgBucket(id),
            pgSplit(pgEl('pgBan').value).map((t) => t.toLowerCase()));
        }
        if (act === 'edit') return pgEditPool(id);
        pgRenderBuckets();
        pgCompile();
      });
    });
  });
}

async function pgEditPool(id) {
  const b = pgBucket(id);
  if (!b) return;
  await askText({
    title: `${b.label} pool`,
    sub: 'Comma separated. These are the tags this bucket rolls from.',
    value: (b.tags || []).join(', '),
    okLabel: 'Save',
    submit: async (text) => {
      b.tags = pgSplit(text);
      await pgSaveConfig();
      return null;
    },
  });
  pgRenderBuckets();
}

async function pgSaveConfig() {
  PG.cfg.qualityPrefix = pgEl('pgQualityText').value;
  PG.cfg.undesiredBlock = pgEl('pgUC').value;
  try {
    await fetch('/api/promptgen', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PG.cfg),
    });
  } catch (e) { toast('Could not save your pools'); }
}

/* --- presets ---------------------------------------------------------- */

function pgRenderPresets() {
  const host = pgEl('pgPresets');
  const list = PG.cfg?.presets || [];
  if (!list.length) {
    host.innerHTML = '<div class="pg-hint">No presets yet. Roll something you like, then Save preset.</div>';
    return;
  }
  host.innerHTML = list.map((p, i) => `
    <div class="pg-preset" data-i="${i}">
      <span class="pg-preset-name">${esc(p.name)}</span>
      <button class="pg-icon" data-act="load" title="Load" aria-label="Load">↥</button>
      <button class="pg-icon" data-act="del" title="Delete" aria-label="Delete">×</button>
    </div>`).join('');

  host.querySelectorAll('.pg-preset').forEach((row) => {
    const p = list[Number(row.dataset.i)];
    row.querySelector('[data-act="load"]').addEventListener('click', () => {
      Object.entries(p.values || {}).forEach(([id, text]) => {
        if (PG.state[id]) PG.state[id].text = text;
      });
      pgRenderBuckets();
      pgCompile();
      toast(`Loaded “${p.name}”`);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      PG.cfg.presets = list.filter((x) => x !== p);
      await pgSaveConfig();
      pgRenderPresets();
    });
  });
}

/* --- wiring ----------------------------------------------------------- */

async function pgInit() {
  if (PG.cfg) return;
  try {
    PG.cfg = await fetch('/api/promptgen').then((r) => r.json());
  } catch (e) {
    return toast('Could not load the prompt generator');
  }
  PG.cfg.presets = PG.cfg.presets || [];

  for (const b of PG.cfg.buckets) {
    PG.state[b.id] = { text: '', locked: false, on: true };
  }

  pgEl('pgScene').innerHTML = (PG.cfg.scenes || [])
    .map((s) => `<option>${esc(s.name || s.Name)}</option>`).join('');
  pgEl('pgQualityText').value = PG.cfg.qualityPrefix || '';
  pgEl('pgUC').value = PG.cfg.undesiredBlock || '';

  pgEl('pgScene').addEventListener('change', (e) => { PG.scene = e.target.value; });
  pgEl('pgMix').addEventListener('input', (e) => { PG.mix = Number(e.target.value); pgCompile(); });
  pgEl('pgQuality').addEventListener('change', pgCompile);
  pgEl('pgQualityText').addEventListener('change', pgSaveConfig);
  pgEl('pgUC').addEventListener('change', pgSaveConfig);
  pgEl('pgMust').addEventListener('input', pgCompile);

  pgEl('pgRoll').addEventListener('click', () => pgRoll());
  pgEl('pgReroll').addEventListener('click', () => pgRoll({ onlyUnlocked: true }));
  pgEl('pgClear').addEventListener('click', () => {
    Object.values(PG.state).forEach((st) => { st.text = ''; });
    pgRenderBuckets();
    pgCompile();
  });

  pgEl('pgCopy').addEventListener('click', () => {
    navigator.clipboard.writeText(pgEl('pgOut').textContent || '');
    toast('Prompt copied');
  });
  pgEl('pgCopyUC').addEventListener('click', () => {
    navigator.clipboard.writeText(pgEl('pgUC').value || '');
    toast('Undesired content copied');
  });

  pgEl('pgSave').addEventListener('click', async () => {
    const values = {};
    Object.entries(PG.state).forEach(([id, st]) => { values[id] = st.text; });
    await askText({
      title: 'Save preset',
      sub: 'Saves the tags currently in every bucket.',
      placeholder: 'e.g. rainy city nights',
      okLabel: 'Save',
      submit: async (name) => {
        PG.cfg.presets.push({ name, values, prompt: pgEl('pgOut').textContent, saved: new Date().toISOString() });
        await pgSaveConfig();
        pgRenderPresets();
        return null;
      },
    });
  });

  // Sending reuses the same bridge the gallery uses for "reuse prompt":
  // the extension is already watching, so there is no second mechanism to
  // keep working.
  pgEl('pgSend').addEventListener('click', async () => {
    const text = pgEl('pgOut').textContent || '';
    if (!text.trim()) return toast('Roll something first');
    await navigator.clipboard.writeText(text);
    pgEl('pgSendNote').textContent = 'Copied — paste into NovelAI’s prompt box.';
    setTimeout(() => { pgEl('pgSendNote').textContent = ''; }, 6000);
  });

  pgInitCharacters();
  pgRenderBuckets();
  pgRenderPresets();
  pgRoll();
}

/* --- characters from a series ---------------------------------------- */

function pgInitCharacters() {
  const series = PG.cfg.series || [];
  const seriesSel = pgEl('pgSeries');
  const charSel = pgEl('pgCharacter');
  if (!series.length) return;

  seriesSel.innerHTML = series.map((x) => `<option>${esc(x.name)}</option>`).join('');

  const fillCharacters = () => {
    const chosen = series.find((x) => x.name === seriesSel.value) || series[0];
    charSel.innerHTML = (chosen.characters || [])
      .map((c) => `<option value="${esc(c)}">${esc(c.replace(/_/g, ' '))}</option>`).join('');
    apply();
  };

  // Turning a character on silences the buckets that describe the same
  // things, rather than letting them contradict it. Turning it off gives
  // them back, so this is a loan and not a deletion.
  const apply = () => {
    const on = pgEl('pgCharOn').checked;
    PG.character = on ? charSel.value : null;
    PG_CHARACTER_OWNS.forEach((id) => {
      if (PG.state[id]) PG.state[id].on = !on;
    });
    pgRenderBuckets();
    pgCompile();
  };

  seriesSel.addEventListener('change', fillCharacters);
  charSel.addEventListener('change', apply);
  pgEl('pgCharOn').addEventListener('change', apply);
  pgEl('pgCharRandom').addEventListener('click', () => {
    const s = series[Math.floor(Math.random() * series.length)];
    seriesSel.value = s.name;
    fillCharacters();
    const opts = charSel.options;
    if (opts.length) charSel.selectedIndex = Math.floor(Math.random() * opts.length);
    pgEl('pgCharOn').checked = true;
    apply();
  });

  fillCharacters();
  pgEl('pgCharOn').checked = false;
  apply();
}

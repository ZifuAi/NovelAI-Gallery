'use strict';

/**
 * Turns NovelAI's prompt metadata into structured, displayable sections.
 *
 * NovelAI has two generations of prompt format living in the same
 * `Comment` JSON blob:
 *
 *   - Legacy: a single `prompt` string and a single `uc` string.
 *   - V4-style: `v4_prompt.caption.base_caption` plus a list of
 *     per-character captions in `v4_prompt.caption.char_captions[]`,
 *     with the same shape mirrored under `v4_negative_prompt`.
 *
 * NOTE: the V4 field names below are taken from the shape NovelAI writes
 * into exported PNGs, but I have not been able to verify them against a
 * live account. Everything here is written to degrade gracefully - if a
 * field is missing or shaped differently, that section simply doesn't
 * render and the legacy `prompt`/`uc` strings still do. Nothing throws.
 */

/**
 * Split a prompt string into individual tags.
 *
 * Splits on commas and periods, per the display convention that each
 * comma/period-delimited fragment is its own tag. The negative lookahead
 * on digits keeps decimal numbers intact, so a weight like `1.5::detailed::`
 * or a strength of `0.7` stays a single tag instead of being torn in half.
 * Newlines are treated as separators too.
 */
function splitTags(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/[\n\r]+|[,.](?!\d)/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** A tag carrying explicit emphasis is worth showing slightly stronger. */
function isWeighted(tag) {
  return /::|[{}[\]]|:\s*[\d.]+\s*$/.test(tag);
}

function safeGet(obj, path) {
  try {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  } catch (e) {
    return undefined;
  }
}

/**
 * Build the section model for one image record.
 * Returns: [{ id, name, kind, tags?, characters?, raw }]
 */
function buildSections(meta) {
  const sections = [];
  const comment = meta?.comment || {};

  // ---- Base (positive) prompt -------------------------------------
  const v4Base = safeGet(comment, 'v4_prompt.caption.base_caption');
  const basePrompt = v4Base || meta?.prompt || comment.prompt || '';
  if (basePrompt) {
    sections.push({
      id: 'base',
      name: 'Base prompt',
      kind: 'positive',
      tags: splitTags(basePrompt),
      raw: basePrompt,
    });
  }

  // ---- Character prompts -------------------------------------------
  const charCaptions = safeGet(comment, 'v4_prompt.caption.char_captions');
  if (Array.isArray(charCaptions) && charCaptions.length > 0) {
    const characters = charCaptions
      .map((c, i) => {
        const text = c?.char_caption || c?.caption || '';
        return text ? { label: `Character ${i + 1}`, tags: splitTags(text), raw: text } : null;
      })
      .filter(Boolean);

    if (characters.length > 0) {
      sections.push({
        id: 'characters',
        name: 'Character prompts',
        kind: 'positive',
        characters,
        raw: characters.map((c) => c.raw).join('\n\n'),
      });
    }
  }

  // ---- Undesired content (negative) --------------------------------
  const v4NegBase = safeGet(comment, 'v4_negative_prompt.caption.base_caption');
  const negPrompt = v4NegBase || meta?.negativePrompt || comment.uc || '';
  if (negPrompt) {
    sections.push({
      id: 'uc',
      name: 'Undesired content',
      kind: 'negative',
      tags: splitTags(negPrompt),
      raw: negPrompt,
    });
  }

  // ---- Per-character undesired content ------------------------------
  const negCharCaptions = safeGet(comment, 'v4_negative_prompt.caption.char_captions');
  if (Array.isArray(negCharCaptions) && negCharCaptions.length > 0) {
    const characters = negCharCaptions
      .map((c, i) => {
        const text = c?.char_caption || c?.caption || '';
        return text ? { label: `Character ${i + 1}`, tags: splitTags(text), raw: text } : null;
      })
      .filter(Boolean);

    if (characters.length > 0) {
      sections.push({
        id: 'uc-characters',
        name: 'Character undesired content',
        kind: 'negative',
        characters,
        raw: characters.map((c) => c.raw).join('\n\n'),
      });
    }
  }

  return sections;
}

window.PromptModel = { splitTags, isWeighted, buildSections };

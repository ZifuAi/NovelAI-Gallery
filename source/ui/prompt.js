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

  // Each subject carries its own undesired content, the way NovelAI writes
  // it: the base prompt has one, and every character has one of their own.
  // Listing all the prompts and then all the undesired content separately
  // made you count rows to work out which belonged to which.
  const pair = (id, name, prompt, negative) => {
    if (!prompt && !negative) return;
    sections.push({
      id,
      name,
      kind: 'positive',
      tags: splitTags(prompt || ''),
      raw: prompt || '',
      negative: negative
        ? { tags: splitTags(negative), raw: negative }
        : null,
    });
  };

  // ---- Base prompt, and the undesired content that goes with it -----
  const v4Base = safeGet(comment, 'v4_prompt.caption.base_caption');
  const basePrompt = v4Base || meta?.prompt || comment.prompt || '';
  const v4NegBase = safeGet(comment, 'v4_negative_prompt.caption.base_caption');
  const baseNeg = v4NegBase || meta?.negativePrompt || comment.uc || '';
  pair('base', 'Base prompt', basePrompt, baseNeg);

  // ---- One section per character ------------------------------------
  const charCaptions = safeGet(comment, 'v4_prompt.caption.char_captions') || [];
  const negCaptions = safeGet(comment, 'v4_negative_prompt.caption.char_captions') || [];
  const count = Math.max(
    Array.isArray(charCaptions) ? charCaptions.length : 0,
    Array.isArray(negCaptions) ? negCaptions.length : 0,
  );

  const textOf = (c) => (typeof c === 'string' ? c : (c?.char_caption || c?.caption || ''));
  for (let i = 0; i < count; i++) {
    pair(
      `char-${i + 1}`,
      `Character ${i + 1}`,
      textOf(charCaptions[i]),
      textOf(negCaptions[i]),
    );
  }

  return sections;
}

window.PromptModel = { splitTags, isWeighted, buildSections };

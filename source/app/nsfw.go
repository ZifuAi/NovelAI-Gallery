package main

import (
	"regexp"
	"strings"
)

// Explicit-content detection, from the prompt only.
//
// The rule this implements: mark what is actually explicit - genitals, sex
// acts, nudity - and leave ordinary anatomy alone. "large breasts" is a
// body description and is not flagged; "vaginal" is an act and is.
//
// Two things matter for not getting this wrong:
//
//  1. Only the POSITIVE prompt is read. Undesired content is what someone
//     asked the model to avoid, so a prompt with "nsfw, nude" in undesired
//     content means the opposite of explicit, and scanning it would flag
//     exactly the people trying hardest to avoid the thing.
//
//  2. Every term is matched on word boundaries. Without that, "anal" hits
//     "analysis", "cum" hits "cucumber", "sex" hits "unisex", and "cock"
//     hits "peacock" - all of which are plausible in a prompt.
//
// Nothing here inspects the picture; it can only be as good as the prompt.
// An image with no prompt is never flagged, and the manual toggle exists
// precisely because a keyword list cannot be the last word.

var explicitTerms = []string{
	// Genitals and explicit anatomy
	"pussy", "vagina", "vaginal", "vulva", "clitoris", "clit", "labia",
	"penis", "cock", "dick", "cocks", "testicles", "scrotum", "foreskin",
	"glans", "erection", "erect penis", "anus", "asshole", "anal",
	"urethra", "cervix", "futanari", "futa", "dickgirl", "pubic hair",
	"spread pussy", "genitals",
	// Acts
	"sex", "having sex", "penetration", "penetrated", "insertion",
	"fellatio", "blowjob", "deepthroat", "irrumatio", "cunnilingus",
	"oral sex", "paizuri", "titfuck", "titjob", "handjob", "footjob",
	"masturbation", "masturbating", "fingering", "doggystyle", "cowgirl position", "missionary position",
	"mating press", "gangbang", "threesome", "orgy", "sixty-nine",
	"double penetration", "intercourse", "copulation", "fucking",
	"fucked", "humping",

	// Toys
	"dildo", "vibrator", "sex toy", "buttplug", "butt plug", "anal beads",
	"onahole", "condom",

	// Fluids and aftermath
	"cum", "cumming", "semen", "ejaculation", "ejaculating", "creampie",
	"bukkake", "cumdrip", "precum", "squirting", "orgasm", "ahegao",

	// Nudity
	"nude", "nudity", "naked", "topless", "bottomless", "nipples",
	"areolae", "areola", "no panties", "pantyless", "exposed breasts",

	// Explicit intent
	"nsfw", "explicit", "uncensored", "hardcore", "porn", "pornographic",
	"r-18", "rating: explicit",
}

// Terms that describe a body or clothing and must never, on their own,
// mark an image as explicit. This list does not feed the matcher - the
// matcher simply doesn't contain these words - but it is asserted against
// in the tests, so adding a careless term to explicitTerms later fails
// loudly instead of quietly flagging half a library.
var neverExplicit = []string{
	"breasts", "large breasts", "huge breasts", "gigantic breasts",
	"medium breasts", "small breasts", "flat chest", "cleavage",
	"underboob", "sideboob", "thighs", "thick thighs", "wide hips",
	"curvy", "ass", "butt", "midriff", "navel", "bare shoulders",
	"bikini", "swimsuit", "one-piece swimsuit", "lingerie", "panties",
	"underwear", "bra", "garter belt", "garter straps", "thighhighs",
	"stockings", "pantyhose", "leotard", "bodysuit", "skindentation",
	"cameltoe", "sexy", "unisex", "analysis", "cucumber", "peacock",
	"cocktail dress", "assassin", "grass", "classic", "brass",
	"scummy", "documentary",
}

// One alternation of every term, each wrapped in word boundaries. Built
// once: this runs against every image in the library when the setting is
// toggled.
var explicitRe = buildExplicitRe()

func buildExplicitRe() *regexp.Regexp {
	parts := make([]string, 0, len(explicitTerms))
	for _, t := range explicitTerms {
		parts = append(parts, regexp.QuoteMeta(t))
	}
	// \b won't do at the end of a multi-word term ending in a letter is
	// fine, but hyphens like "r-18" need the boundary outside the whole
	// term rather than per-word.
	// A trailing s/es is allowed so "dildos" and "nudes" match without
	// every plural needing its own entry.
	return regexp.MustCompile(
		`(?i)(^|[^a-z0-9])(` + strings.Join(parts, "|") + `)(?:es|s)?($|[^a-z0-9])`)
}

// positivePromptText gathers only the prompt the image was generated FROM,
// leaving undesired content out entirely.
func positivePromptText(m Meta) string {
	parts := []string{m.Prompt}

	if m.Comment != nil {
		if v, ok := m.Comment["prompt"].(string); ok {
			parts = append(parts, v)
		}
		// Any nested caption container, except the negative one.
		for key, val := range m.Comment {
			lk := strings.ToLower(key)
			if strings.Contains(lk, "negative") || lk == "uc" {
				continue
			}
			if !strings.Contains(lk, "prompt") && !strings.Contains(lk, "caption") {
				continue
			}
			var found []string
			collectCaptions(val, 0, &found)
			parts = append(parts, found...)
		}
	}
	return strings.Join(parts, "\n")
}

// classifyNSFW reports whether an image's prompt describes explicit
// content.
func classifyNSFW(m Meta) bool {
	text := positivePromptText(m)
	if strings.TrimSpace(text) == "" {
		return false
	}
	return explicitRe.MatchString(text)
}

// effectiveNSFW combines what the classifier found with the user's own
// decision. A manual mark always beats the guess; the master setting
// beats both, because "off" has to mean nothing is flagged at all.
func effectiveNSFW(r *Record, enabled bool) bool {
	if !enabled {
		return false
	}
	if r.NSFWManual != nil {
		return *r.NSFWManual
	}
	return r.NSFWAuto
}

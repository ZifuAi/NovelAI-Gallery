package main

import "testing"

func metaWith(prompt, negative string) Meta {
	return Meta{
		Prompt:         prompt,
		NegativePrompt: negative,
		Comment: map[string]any{
			"prompt": prompt,
			"uc":     negative,
		},
	}
}

// The line this feature has to walk: ordinary anatomy and clothing are not
// explicit, and words that merely contain an explicit substring are not
// either.
func TestNeverFlagsOrdinaryPrompts(t *testing.T) {
	for _, term := range neverExplicit {
		prompt := "1girl, masterpiece, " + term + ", detailed background"
		if classifyNSFW(metaWith(prompt, "")) {
			t.Errorf("%q should not be flagged", term)
		}
	}

	realistic := []string{
		"1girl, large breasts, cleavage, bikini, beach, sunset",
		"2girls, thighhighs, garter straps, lingerie, bedroom, soft lighting",
		"portrait, sexy pose, curvy, wide hips, leotard",
		"a peacock in tall grass, analysis of classical composition",
		"assassin in a cocktail dress, brass railing, documentary style",
		"cucumber sandwiches on a picnic blanket",
		"unisex uniform, school classroom",
		"", // no prompt at all
	}
	for _, p := range realistic {
		if classifyNSFW(metaWith(p, "")) {
			t.Errorf("should not be flagged: %q", p)
		}
	}
}

func TestFlagsExplicitPrompts(t *testing.T) {
	explicit := []string{
		"1girl, nude, lying on bed",
		"1girl, completely naked, bedroom",
		"vaginal, sex, hetero, 1girl 1boy",
		"anal, from behind",
		"fellatio, pov",
		"cum on face, bukkake",
		"exposed nipples, topless",
		"futanari, erection",
		"masturbation, fingering",
		"nsfw, explicit, uncensored",
		"holding a dildo",
		"creampie, mating press",
		"1girl, large breasts, pussy, spread legs", // anatomy plus explicit
	}
	for _, p := range explicit {
		if !classifyNSFW(metaWith(p, "")) {
			t.Errorf("should be flagged: %q", p)
		}
	}
}

// The subtle one. Undesired content lists what the image is meant NOT to
// contain, so reading it would flag precisely the prompts written to avoid
// explicit output.
func TestUndesiredContentIsNotEvidence(t *testing.T) {
	m := metaWith(
		"1girl, school uniform, classroom, masterpiece",
		"nsfw, nude, pussy, sex, explicit, lowres, bad anatomy",
	)
	if classifyNSFW(m) {
		t.Error("explicit terms in undesired content must not flag an image")
	}

	// And the same shape in V4's nested form.
	v4 := Meta{
		Comment: map[string]any{
			"v4_prompt": map[string]any{
				"caption": map[string]any{
					"base_caption": "1girl, sundress, park",
					"char_captions": []any{
						map[string]any{"char_caption": "blonde hair, green eyes"},
					},
				},
			},
			"v4_negative_prompt": map[string]any{
				"caption": map[string]any{
					"base_caption": "nsfw, nude, explicit",
					"char_captions": []any{
						map[string]any{"char_caption": "pussy, sex"},
					},
				},
			},
		},
	}
	if classifyNSFW(v4) {
		t.Error("V4 undesired content must not flag an image")
	}
}

// A character prompt is part of what was asked for, so it counts.
func TestFlagsExplicitCharacterPrompts(t *testing.T) {
	m := Meta{
		Comment: map[string]any{
			"v4_prompt": map[string]any{
				"caption": map[string]any{
					"base_caption": "2girls, bedroom, soft lighting",
					"char_captions": []any{
						map[string]any{"char_caption": "long hair, blue eyes"},
						map[string]any{"char_caption": "nude, nipples"},
					},
				},
			},
		},
	}
	if !classifyNSFW(m) {
		t.Error("an explicit character prompt should flag the image")
	}
}

func TestManualMarkBeatsTheClassifier(t *testing.T) {
	yes, no := true, false
	safeAuto := &Record{NSFWAuto: false}
	explicitAuto := &Record{NSFWAuto: true}

	if !effectiveNSFW(explicitAuto, true) {
		t.Error("an auto-flagged image should be flagged")
	}
	if effectiveNSFW(safeAuto, true) {
		t.Error("an unflagged image should not be flagged")
	}

	// The user overrules the guess, in both directions.
	marked := &Record{NSFWAuto: false, NSFWManual: &yes}
	cleared := &Record{NSFWAuto: true, NSFWManual: &no}
	if !effectiveNSFW(marked, true) {
		t.Error("a manual mark should flag an image the classifier missed")
	}
	if effectiveNSFW(cleared, true) {
		t.Error("a manual clear should unflag an image the classifier caught")
	}

	// With the setting off, nothing is flagged - manual marks included.
	for _, r := range []*Record{explicitAuto, marked, cleared} {
		if effectiveNSFW(r, false) {
			t.Error("the setting being off must mean nothing is flagged")
		}
	}
}

package main

import (
	"strings"
	"testing"
)

// COLORREF is 0x00BBGGRR - the byte order is reversed from CSS, which is
// exactly the kind of thing worth pinning down in a test, since getting it
// wrong paints the title bar a plausible-looking but wrong colour.
func TestColorRef(t *testing.T) {
	cases := []struct {
		in   string
		want uint32
		ok   bool
	}{
		{"#16181f", 0x1f1816, true}, // the default dark surface
		{"#FFFFFF", 0xffffff, true}, // symmetric, but proves parsing
		{"#000000", 0x000000, true},
		{"#ff0000", 0x0000ff, true}, // red -> blue-most byte is zero
		{"#0000ff", 0xff0000, true},
		{"  #abc  ", 0xccbbaa, true}, // short form, with whitespace
		{"rgb(22, 24, 31)", 0x1f1816, true},
		{"rgba(22, 24, 31, 0.5)", 0x1f1816, true},
		{"rgb(255 0 0 / 50%)", 0x0000ff, true},
		{"", 0, false},
		{"transparent", 0, false},
		{"#12345", 0, false},
		{"rgb(300, 0, 0)", 0, false},
		{"var(--surface-1)", 0, false},
	}

	for _, c := range cases {
		got, ok := colorRef(c.in)
		if ok != c.ok {
			t.Errorf("colorRef(%q) ok = %v, want %v", c.in, ok, c.ok)
			continue
		}
		if ok && got != c.want {
			t.Errorf("colorRef(%q) = %#06x, want %#06x", c.in, got, c.want)
		}
	}
}

func TestSortRecordsIsDeterministic(t *testing.T) {
	// Same timestamp on every record: the ordering has to come from
	// insertion order, and "oldest" must be the exact mirror of "newest".
	const ts = "2026-01-01T00:00:00.000000000Z"
	mk := func(id string) *Record { return &Record{ID: id, AddedAt: ts} }

	build := func() ([]*Record, map[*Record]int) {
		out := []*Record{mk("a"), mk("b"), mk("c"), mk("d")}
		pos := map[*Record]int{}
		for i, r := range out {
			pos[r] = i
		}
		return out, pos
	}

	newest, pos := build()
	sortRecords(newest, "newest", pos)
	oldest, pos2 := build()
	sortRecords(oldest, "oldest", pos2)

	if len(newest) != len(oldest) {
		t.Fatal("length changed")
	}
	for i := range newest {
		if newest[i].ID != oldest[len(oldest)-1-i].ID {
			t.Fatalf("oldest is not the reverse of newest: %v vs %v",
				ids(newest), ids(oldest))
		}
	}
}

func ids(rs []*Record) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.ID
	}
	return out
}

// A V4 prompt is not one string: the base caption, each character's
// caption, and both sets of undesired content are separate fields. Search
// has to see all of them.
func TestSearchTextCoversEveryPromptPart(t *testing.T) {
	r := &Record{
		Filename: "x.png",
		Notes:    "my note",
		Meta: Meta{
			Prompt:         "base tag, scenery",
			NegativePrompt: "lowres",
			Model:          "nai-diffusion-4",
			Comment: map[string]any{
				"prompt": "base tag, scenery",
				"uc":     "lowres",
				"v4_prompt": map[string]any{
					"caption": map[string]any{
						"base_caption": "base tag, scenery",
						"char_captions": []any{
							map[string]any{"char_caption": "pink twintails, dragon horns"},
							map[string]any{"char_caption": "green jacket"},
						},
					},
				},
				"v4_negative_prompt": map[string]any{
					"caption": map[string]any{
						"base_caption": "bad hands",
						"char_captions": []any{
							map[string]any{"char_caption": "extra fingers"},
						},
					},
				},
			},
		},
	}

	hay := searchText(r)
	for _, want := range []string{
		"base tag", "scenery", // base prompt
		"pink twintails", "dragon horns", // character 1
		"green jacket",    // character 2
		"bad hands",       // undesired content
		"extra fingers",   // per-character undesired content
		"nai-diffusion-4", // model
		"my note",         // notes
	} {
		if !containsFold(hay, want) {
			t.Errorf("search text is missing %q", want)
		}
	}

	// A rename of the container fields must not break it.
	renamed := &Record{Meta: Meta{Comment: map[string]any{
		"v5_prompt": map[string]any{
			"caption": map[string]any{
				"character_captions": []any{
					map[string]any{"caption": "silver hair"},
				},
			},
		},
	}}}
	if !containsFold(searchText(renamed), "silver hair") {
		t.Error("renamed caption fields should still be searchable")
	}
}

func containsFold(hay, needle string) bool {
	return strings.Contains(hay, strings.ToLower(needle))
}

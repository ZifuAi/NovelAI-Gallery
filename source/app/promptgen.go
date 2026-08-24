package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// The prompt generator's pools and presets.
//
// Rolling happens in the browser - it is a handful of random picks and
// should feel instant, with no round trip. This side owns the durable
// part: the pools you edit, the presets you save, and mining your own
// library for tags you actually use.
//
// Tags are Danbooru-style throughout, because that is the vocabulary the
// models were trained on: underscores-or-spaces, `artist:name` for
// artists, and the ordinary booru words for everything else.

type Bucket struct {
	// ID is stable and referred to by presets; Label is what you see.
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Tags  []string `json:"tags"`
	// Min/Max entries to draw when rolling this bucket.
	Min int `json:"min"`
	Max int `json:"max"`
	// Prose is whether this bucket renders as natural language when the
	// mix slider calls for it. Artists and quality never do.
	Prose bool `json:"prose"`
	// Group is the collapsible section this bucket belongs to, so a dozen
	// buckets read as four groups rather than one long scroll.
	Group string `json:"group"`
}

// Series are characters from actual shows, kept apart from the ordinary
// pools because they are chosen deliberately rather than rolled at random -
// and because a character tag carries its own outfit and hair, which will
// fight anything else you rolled.
type Series struct {
	Name       string   `json:"name"`
	Characters []string `json:"characters"`
}

type Scene struct {
	Name string `json:"name"`
	// Bucket id -> tags this scene prefers. A scene is what keeps a roll
	// coherent: picking "rainy night" should not then choose a beach.
	Prefer map[string][]string `json:"prefer"`
}

type PromptConfig struct {
	Buckets []Bucket `json:"buckets"`
	Scenes  []Scene  `json:"scenes"`
	Series  []Series `json:"series"`
	Presets []Preset `json:"presets"`

	QualityPrefix  string `json:"qualityPrefix"`
	UndesiredBlock string `json:"undesiredBlock"`
}

type Preset struct {
	Name   string            `json:"name"`
	Values map[string]string `json:"values"`
	Prompt string            `json:"prompt"`
	Saved  string            `json:"saved"`
}

var promptMu sync.Mutex

func (s *Store) promptPath() string { return filepath.Join(s.dir, "prompt-generator.json") }

// PromptConfig returns the saved pools, seeding defaults the first time.
func (s *Store) PromptConfig() PromptConfig {
	promptMu.Lock()
	defer promptMu.Unlock()

	var cfg PromptConfig
	if b, err := os.ReadFile(s.promptPath()); err == nil {
		if json.Unmarshal(b, &cfg) == nil && len(cfg.Buckets) > 0 {
			return cfg
		}
	}
	cfg = defaultPromptConfig()
	writeJSONAtomic(s.promptPath(), cfg)
	return cfg
}

func (s *Store) SavePromptConfig(cfg PromptConfig) PromptConfig {
	promptMu.Lock()
	defer promptMu.Unlock()
	writeJSONAtomic(s.promptPath(), cfg)
	return cfg
}

// MinedTags reports the tags that actually appear in this library, most
// used first. Starter pools are guesses; this is evidence - it offers back
// the vocabulary the person has been using all along.
func (s *Store) MinedTags(limit int) []MinedTag {
	s.mu.RLock()
	defer s.mu.RUnlock()

	counts := map[string]int{}
	for _, r := range s.records {
		if r == nil {
			continue
		}
		for _, part := range strings.Split(r.Meta.Prompt, ",") {
			t := strings.TrimSpace(strings.ToLower(part))
			// Drop weighting syntax so "{{artist:x}}" and "artist:x" are
			// counted as the same tag.
			t = strings.Trim(t, "{}[]() ")
			if i := strings.Index(t, "::"); i >= 0 {
				t = strings.TrimSpace(t[i+2:])
			}
			if t == "" || len(t) > 60 {
				continue
			}
			counts[t]++
		}
	}

	out := make([]MinedTag, 0, len(counts))
	for tag, n := range counts {
		out = append(out, MinedTag{Tag: tag, Count: n, Artist: strings.HasPrefix(tag, "artist:")})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

type MinedTag struct {
	Tag    string `json:"tag"`
	Count  int    `json:"count"`
	Artist bool   `json:"artist"`
}

// defaultPromptConfig is a starter set, not an attempt at a tag database.
// It is deliberately small and obviously editable - a huge built-in list
// would be someone else's taste baked into your tool.
func defaultPromptConfig() PromptConfig {
	b := func(group, id, label string, min, max int, prose bool, tags ...string) Bucket {
		return Bucket{ID: id, Label: label, Min: min, Max: max, Prose: prose, Tags: tags, Group: group}
	}
	return PromptConfig{
		QualityPrefix:  "masterpiece, best quality, absurdres, very aesthetic, newest",
		UndesiredBlock: "lowres, worst quality, bad anatomy, bad hands, jpeg artifacts, watermark, signature",
		Buckets: []Bucket{
			b("style", "artist", "Artists", 2, 4, false,
				"artist:ixy", "artist:rella", "artist:ask_(askzy)", "artist:yaegashi_nan",
				"artist:ciloranko", "artist:wlop", "artist:ke-ta", "artist:mika_pikazo",
				"artist:torino_aqua", "artist:momoko_(momopoco)", "artist:kantoku",
				"artist:fuzichoco", "artist:hiten", "artist:sho_(sho_lwlw)", "artist:tidsean"),
			b("subject", "character", "Character", 1, 1, false,
				"1girl", "1boy", "2girls", "1girl, 1boy", "solo"),
			b("subject", "appearance", "Appearance", 2, 4, true,
				"long hair", "short hair", "twintails", "ponytail", "blonde hair",
				"black hair", "silver hair", "blue eyes", "green eyes", "heterochromia",
				"freckles", "long eyelashes"),
			b("wardrobe", "outfit", "Outfit", 2, 4, true,
				"school uniform", "sailor collar", "oversized jacket", "hoodie",
				"summer dress", "kimono", "sweater", "coat", "shorts", "pleated skirt",
				"thighhighs", "scarf"),
			b("wardrobe", "accessory", "Accessory", 0, 2, true,
				"hair ribbon", "hairclip", "glasses", "headphones", "earrings",
				"holding umbrella", "holding phone", "backpack", "cat ears"),
			b("action", "expression", "Expression", 1, 2, true,
				"smile", "soft smile", "smirk", "blush", "half-closed eyes",
				"looking at viewer", "looking away", "closed eyes", "surprised"),
			b("action", "pose", "Pose / action", 1, 2, true,
				"standing", "sitting", "walking", "leaning forward", "arms behind back",
				"hands in pockets", "stretching", "lying down", "running", "looking back"),
			b("scene", "location", "Location", 1, 2, true,
				"city street", "classroom", "rooftop", "cafe interior", "train station",
				"forest", "beach", "flower field", "bedroom", "library", "shrine",
				"convenience store", "riverbank"),
			b("scene", "time", "Time & weather", 1, 2, true,
				"night", "sunset", "golden hour", "blue hour", "overcast", "rain",
				"snow", "morning light", "fog"),
			b("scene", "lighting", "Lighting", 1, 2, true,
				"cinematic lighting", "rim lighting", "backlighting", "neon lights",
				"soft lighting", "dappled sunlight", "god rays", "candlelight"),
			b("framing", "composition", "Composition", 1, 2, false,
				"upper body", "cowboy shot", "full body", "close-up", "from above",
				"from below", "dutch angle", "wide shot", "profile view", "from behind"),
			b("framing", "extras", "Extras", 0, 2, true,
				"depth of field", "bokeh", "motion blur", "lens flare", "reflection",
				"falling petals", "dust particles", "wind"),
		},
		// Characters from real shows. These are chosen, never rolled: a
		// character tag brings its own hair, eyes and outfit, so mixing one
		// into a random wardrobe roll produces a fight rather than a picture.
		// Danbooru's own naming, which is what the models were trained on.
		Series: []Series{
			{Name: "Frieren", Characters: []string{
				"frieren", "fern_(sousou_no_frieren)", "stark_(sousou_no_frieren)",
				"himmel_(sousou_no_frieren)"}},
			{Name: "Genshin Impact", Characters: []string{
				"raiden_shogun", "hu_tao_(genshin_impact)", "ganyu_(genshin_impact)",
				"nahida_(genshin_impact)", "furina_(genshin_impact)", "yelan_(genshin_impact)"}},
			{Name: "Blue Archive", Characters: []string{
				"arona_(blue_archive)", "hoshino_(blue_archive)", "yuuka_(blue_archive)",
				"asuna_(blue_archive)", "hina_(blue_archive)"}},
			{Name: "Chainsaw Man", Characters: []string{
				"makima_(chainsaw_man)", "power_(chainsaw_man)", "hayakawa_aki",
				"denji_(chainsaw_man)"}},
			{Name: "Jujutsu Kaisen", Characters: []string{
				"gojo_satoru", "kugisaki_nobara", "itadori_yuuji", "fushiguro_megumi"}},
			{Name: "Spy x Family", Characters: []string{
				"anya_(spy_x_family)", "yor_briar", "loid_forger"}},
			{Name: "Oshi no Ko", Characters: []string{
				"hoshino_ai_(oshi_no_ko)", "hoshino_ruby", "arima_kana", "kurokawa_akane"}},
			{Name: "Fate", Characters: []string{
				"artoria_pendragon_(fate)", "tohsaka_rin", "jeanne_d'arc_(fate)",
				"ishtar_(fate)", "scathach_(fate)"}},
			{Name: "Re:Zero", Characters: []string{
				"rem_(re:zero)", "ram_(re:zero)", "emilia_(re:zero)", "beatrice_(re:zero)"}},
			{Name: "Vocaloid", Characters: []string{
				"hatsune_miku", "kagamine_rin", "megurine_luka"}},
		},
		Scenes: []Scene{
			{Name: "Any", Prefer: map[string][]string{}},
			{Name: "Rainy night in the city", Prefer: map[string][]string{
				"location":  {"city street", "train station", "convenience store"},
				"time":      {"night", "rain"},
				"lighting":  {"neon lights", "rim lighting", "backlighting"},
				"extras":    {"reflection", "bokeh", "depth of field"},
				"outfit":    {"oversized jacket", "coat", "hoodie", "scarf"},
				"accessory": {"holding umbrella", "holding phone"},
			}},
			{Name: "Golden hour outdoors", Prefer: map[string][]string{
				"location": {"flower field", "riverbank", "beach", "forest"},
				"time":     {"sunset", "golden hour", "morning light"},
				"lighting": {"dappled sunlight", "god rays", "soft lighting"},
				"extras":   {"falling petals", "wind", "lens flare"},
				"outfit":   {"summer dress", "sweater"},
			}},
			{Name: "Quiet indoors", Prefer: map[string][]string{
				"location": {"bedroom", "library", "cafe interior", "classroom"},
				"time":     {"morning light", "overcast"},
				"lighting": {"soft lighting", "candlelight"},
				"pose":     {"sitting", "lying down", "leaning forward"},
				"extras":   {"depth of field", "dust particles"},
			}},
			{Name: "Winter", Prefer: map[string][]string{
				"location": {"city street", "shrine", "forest"},
				"time":     {"snow", "overcast", "blue hour"},
				"outfit":   {"coat", "scarf", "sweater", "thighhighs"},
				"lighting": {"soft lighting", "rim lighting"},
			}},
		},
	}
}

package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The token must not be sendable anywhere but NovelAI. This is the one
// rule worth a test that cannot be argued with: everything else about the
// feature is a convenience, and this is the part that would be a leak.
func TestTokenOnlyEverGoesToNovelAI(t *testing.T) {
	elsewhere := []string{
		"https://example.invalid/ai/generate-image",
		"http://image.novelai.net/ai/generate-image",       // plain http
		"https://image.novelai.net.attacker.test/generate", // suffix trick
		"https://attacker.test/?x=image.novelai.net",
		"",
	}
	for _, bad := range elsewhere {
		if naiAllowedHost(bad) {
			t.Errorf("%q was accepted as NovelAI", bad)
		}
		if _, err := naiGenerate(bad, "secret-token", GenerateRequest{Prompt: "x"}); err == nil {
			t.Errorf("generating against %q should have been refused", bad)
		}
	}
	if !naiAllowedHost(naiEndpoint) {
		t.Error("the real endpoint was rejected")
	}
	// Case in the host must not defeat it.
	if !naiAllowedHost("https://IMAGE.NovelAI.net/ai/generate-image") {
		t.Error("host matching should be case-insensitive")
	}
}

func TestPayloadShapeMatchesNovelAI(t *testing.T) {
	g := GenerateRequest{Prompt: "1girl, city", Negative: "blurry", Model: "nai-diffusion-4-5-full"}
	g.fill()
	p := naiPayload(g)

	if p["input"] != "1girl, city" || p["action"] != "generate" {
		t.Errorf("root keys wrong: %+v", p)
	}
	params, ok := p["parameters"].(map[string]any)
	if !ok {
		t.Fatal("parameters is not an object")
	}
	for _, k := range []string{"width", "height", "scale", "sampler", "steps", "negative_prompt"} {
		if _, ok := params[k]; !ok {
			t.Errorf("parameters is missing %q", k)
		}
	}
	// An unset seed must be absent, not zero: zero is a real seed.
	if _, ok := params["seed"]; ok {
		t.Error("an unset seed was sent as a value")
	}
	g.Seed = 12345
	if naiPayload(g)["parameters"].(map[string]any)["seed"] != int64(12345) {
		t.Error("a set seed was not passed through")
	}
}

// V4-family models take the prompt a second time in a structured field.
// Sending only `input` produces a picture that ignored half the prompt,
// which is very hard to tell apart from the model just being bad.
func TestStructuredPromptForModernModels(t *testing.T) {
	structured := func(model string) bool {
		g := GenerateRequest{Prompt: "p", Negative: "n", Model: model}
		g.fill()
		_, ok := naiPayload(g)["parameters"].(map[string]any)["v4_prompt"]
		return ok
	}
	for _, m := range []string{"nai-diffusion-4-full", "nai-diffusion-4-5-full", "nai-diffusion-4-5-curated", "nai-diffusion-5-full"} {
		if !structured(m) {
			t.Errorf("%s should send the structured prompt", m)
		}
	}
	for _, m := range []string{"nai-diffusion-3", "nai-diffusion-furry"} {
		if structured(m) {
			t.Errorf("%s should not send the structured prompt", m)
		}
	}

	// And the guess can be overridden, so an unfamiliar model is a setting
	// rather than a rebuild.
	off := false
	g := GenerateRequest{Prompt: "p", Model: "nai-diffusion-5-full", Structured: &off}
	g.fill()
	if _, ok := naiPayload(g)["parameters"].(map[string]any)["v4_prompt"]; ok {
		t.Error("the structured prompt could not be switched off")
	}

	on := true
	g2 := GenerateRequest{Prompt: "p", Model: "something-unknown", Structured: &on}
	g2.fill()
	if _, ok := naiPayload(g2)["parameters"].(map[string]any)["v4_prompt"]; !ok {
		t.Error("the structured prompt could not be switched on")
	}

	// The structured caption has to carry the same prompt, not an empty one.
	g3 := GenerateRequest{Prompt: "1girl", Negative: "blurry", Model: "nai-diffusion-4-5-full"}
	g3.fill()
	v4 := naiPayload(g3)["parameters"].(map[string]any)["v4_prompt"].(map[string]any)
	cap := v4["caption"].(map[string]any)
	if cap["base_caption"] != "1girl" {
		t.Errorf("base_caption = %v, want the prompt", cap["base_caption"])
	}
}

func zipOf(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	f.Write(body)
	zw.Close()
	return buf.Bytes()
}

func TestGenerateReadsTheImageOutOfTheZip(t *testing.T) {
	png := pngBytes(t, 64, 96)

	var gotAuth, gotType string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotType = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &gotBody)
		w.Write(zipOf(t, "image_0.png", png))
	}))
	defer srv.Close()

	// The host guard is the point of the previous test; here it has to be
	// stepped around to exercise the parsing at all.
	out, err := naiGenerateAt(srv.URL, "tok-123", GenerateRequest{Prompt: "1girl", Model: "nai-diffusion-3", Width: 64, Height: 96, Steps: 28, Scale: 5, Sampler: "k_euler"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, png) {
		t.Error("the PNG that came back is not the one that was served")
	}
	if gotAuth != "Bearer tok-123" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotType != "application/json" {
		t.Errorf("Content-Type = %q", gotType)
	}
	if gotBody["input"] != "1girl" {
		t.Errorf("the prompt did not arrive: %+v", gotBody)
	}
}

// A bare PNG, an error page, and an empty body all have to be handled -
// the first because it is plausible, the others because they are what a
// broken day looks like.
func TestGenerateHandlesOddResponses(t *testing.T) {
	png := pngBytes(t, 32, 32)

	serve := func(status int, body []byte) ([]byte, error) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			w.Write(body)
		}))
		defer srv.Close()
		return naiGenerateAt(srv.URL, "t", GenerateRequest{Prompt: "x"})
	}

	if out, err := serve(200, png); err != nil || !bytes.Equal(out, png) {
		t.Errorf("a bare PNG should be accepted: %v", err)
	}
	if _, err := serve(200, []byte("<html>nope</html>")); err == nil {
		t.Error("an HTML body should be an error")
	}
	if _, err := serve(200, nil); err == nil {
		t.Error("an empty body should be an error")
	}

	// And the status codes people will actually hit say something useful.
	for code, want := range map[int]string{
		401: "token",
		402: "Anlas",
		429: "rate limiting",
	} {
		_, err := serve(code, []byte("{}"))
		if err == nil || !bytes.Contains([]byte(err.Error()), []byte(want)) {
			t.Errorf("status %d gave %v, expected it to mention %q", code, err, want)
		}
	}
}

func TestTokenStoreRoundTrip(t *testing.T) {
	ts := newTokenStore(t.TempDir())
	if ts.Present() {
		t.Error("a fresh store should hold no token")
	}
	if _, err := ts.Get(); err == nil {
		t.Error("reading a token that was never set should fail")
	}

	if err := ts.Set("pst-secret"); err != nil {
		t.Fatal(err)
	}
	if !ts.Present() {
		t.Error("the token was not recorded")
	}
	got, err := ts.Get()
	if err != nil || got != "pst-secret" {
		t.Errorf("got %q, %v", got, err)
	}

	// Clearing is how "forget my token" is expressed.
	ts.Set("")
	if ts.Present() {
		t.Error("the token was not cleared")
	}
}

// V4 keeps each character's description in its own caption, because putting
// two people in one prompt makes the model blend them.
func TestCharacterPrompts(t *testing.T) {
	g := GenerateRequest{
		Prompt:   "2girls, park",
		Negative: "blurry",
		Model:    "nai-diffusion-5-full",
		Characters: []CharacterPrompt{
			{Prompt: "1girl, red hair", Negative: "hat"},
			{Prompt: "1girl, blue hair", Position: true, X: 0.75, Y: 0.5},
			{Prompt: "   "}, // empty: describes nobody, so it is dropped
		},
	}
	g.fill()
	if len(g.Characters) != 2 {
		t.Fatalf("an empty character prompt survived: %+v", g.Characters)
	}

	params := naiPayload(g)["parameters"].(map[string]any)
	v4 := params["v4_prompt"].(map[string]any)
	caps := v4["caption"].(map[string]any)["char_captions"].([]any)
	if len(caps) != 2 {
		t.Fatalf("got %d character captions, want 2", len(caps))
	}
	first := caps[0].(map[string]any)
	if first["char_caption"] != "1girl, red hair" {
		t.Errorf("char_caption = %v", first["char_caption"])
	}
	// A centre is always sent. An empty list is not a shape NovelAI
	// accepts, and sending one failed every generation that had a character
	// in it; use_coords is what decides whether the value is used.
	got := first["centers"].([]any)
	if len(got) != 1 {
		t.Fatalf("centers = %v, want exactly one coordinate", got)
	}
	if c := got[0].(map[string]any); c["x"] != 0.5 || c["y"] != 0.5 {
		t.Errorf("an unset position became %v, want the middle of the frame", c)
	}

	second := caps[1].(map[string]any)
	centers := second["centers"].([]any)
	if len(centers) != 1 {
		t.Fatalf("a positioned character has %d centers", len(centers))
	}
	c := centers[0].(map[string]any)
	if c["x"] != 0.75 || c["y"] != 0.5 {
		t.Errorf("centers = %v", c)
	}
	if v4["use_coords"] != true {
		t.Error("use_coords should be on when a character asked for a position")
	}

	// Each character's undesired content rides along in the negative half,
	// in the same order.
	nv4 := params["v4_negative_prompt"].(map[string]any)
	ncaps := nv4["caption"].(map[string]any)["char_captions"].([]any)
	if len(ncaps) != 2 || ncaps[0].(map[string]any)["char_caption"] != "hat" {
		t.Errorf("negative char captions = %+v", ncaps)
	}
}

// Turning coordinates on when nobody chose one would tell the model to obey
// positions that were never set.
func TestCoordsOffWhenNoCharacterAskedForOne(t *testing.T) {
	g := GenerateRequest{
		Prompt: "2girls", Model: "nai-diffusion-5-full",
		Characters: []CharacterPrompt{{Prompt: "a"}, {Prompt: "b"}},
	}
	g.fill()
	v4 := naiPayload(g)["parameters"].(map[string]any)["v4_prompt"].(map[string]any)
	if v4["use_coords"] != false {
		t.Error("use_coords should stay off when no position was chosen")
	}
}

func TestAtMostSixCharacters(t *testing.T) {
	g := GenerateRequest{Prompt: "x", Model: "nai-diffusion-5-full"}
	for i := 0; i < 10; i++ {
		g.Characters = append(g.Characters, CharacterPrompt{Prompt: "c"})
	}
	g.fill()
	if len(g.Characters) != 6 {
		t.Errorf("kept %d characters, want NovelAI's limit of 6", len(g.Characters))
	}
}

// Repainting part of a picture needs the inpainting model for that family.
// Asking the ordinary model to infill just fails, and picking it by hand is
// a step nobody should have to get right.
func TestInpaintModelIsDerivedFromTheBaseModel(t *testing.T) {
	cases := map[string]string{
		"nai-diffusion-5-full":       "nai-diffusion-5-full-inpainting",
		"nai-diffusion-4-5-full":     "nai-diffusion-4-5-full-inpainting",
		"nai-diffusion-4-5-curated":  "nai-diffusion-4-5-curated-inpainting",
		"nai-diffusion-3":            "nai-diffusion-3-inpainting",
		"nai-diffusion-furry-3":      "furry-diffusion-inpainting",
		"nai-diffusion-furry":        "furry-diffusion-inpainting",
		"nai-diffusion-3-inpainting": "nai-diffusion-3-inpainting",
		"":                           "",
	}
	for base, want := range cases {
		if got := inpaintModelFor(base); got != want {
			t.Errorf("inpaintModelFor(%q) = %q, want %q", base, got, want)
		}
	}
}

func TestActionFollowsWhatWasSupplied(t *testing.T) {
	cases := []struct {
		image, mask string
		want        string
	}{
		{"", "", "generate"},
		{"aW1n", "", "img2img"},
		{"aW1n", "bWFzaw==", "infill"},
	}
	for _, c := range cases {
		g := GenerateRequest{Prompt: "x", Model: "nai-diffusion-5-full", Image: c.image, Mask: c.mask}
		g.fill()
		p := naiPayload(g)
		if p["action"] != c.want {
			t.Errorf("image=%q mask=%q gave action %v, want %q", c.image, c.mask, p["action"], c.want)
		}

		params := p["parameters"].(map[string]any)
		if c.image == "" {
			if _, ok := params["image"]; ok {
				t.Error("an image was sent when none was supplied")
			}
			continue
		}
		if params["image"] != c.image {
			t.Error("the source image did not make it into the request")
		}
		// Strength defaults rather than being sent as zero, which would
		// mean "change nothing" and quietly waste the generation.
		if params["strength"] == float64(0) {
			t.Error("strength was sent as zero, which changes nothing")
		}

		if c.mask == "" {
			if p["model"] != "nai-diffusion-5-full" {
				t.Errorf("model = %v, want the base model when not inpainting", p["model"])
			}
			continue
		}
		if p["model"] != "nai-diffusion-5-full-inpainting" {
			t.Errorf("model = %v, want the inpainting model", p["model"])
		}
		if params["mask"] != c.mask {
			t.Error("the mask did not make it into the request")
		}
		// Without this the untouched part is regenerated too and the seam shows.
		if params["add_original_image"] != true {
			t.Error("add_original_image should be on when inpainting")
		}
	}
}

// The interface and the server each need a model to fall back on, and they
// must be the same one. When they drifted apart, picking "Other" and
// leaving the box empty generated with a different model than the screen
// showed - invisible until the picture came back wrong.
func TestDefaultModelMatchesTheInterface(t *testing.T) {
	js, err := os.ReadFile("../ui/generate.js")
	if err != nil {
		t.Skip("ui/generate.js not present")
	}
	want := "const GEN_DEFAULT_MODEL = '" + defaultModel + "';"
	if !strings.Contains(string(js), want) {
		t.Errorf("ui/generate.js does not define %s (the Go default is %q)", want, defaultModel)
	}

	g := GenerateRequest{Prompt: "x"}
	g.fill()
	if g.Model != defaultModel {
		t.Errorf("an unnamed model filled in as %q, want %q", g.Model, defaultModel)
	}
}

// Every identifier the interface offers has to be one NovelAI knows. The
// list is NovelAI's own naming, not a pattern extended by guesswork, so a
// stray entry here is a generation that fails for no visible reason.
func TestInterfaceOffersOnlyRealModels(t *testing.T) {
	js, err := os.ReadFile("../ui/generate.js")
	if err != nil {
		t.Skip("ui/generate.js not present")
	}
	known := map[string]bool{
		"nai-diffusion-5-full":      true,
		"nai-diffusion-5-curated":   true,
		"nai-diffusion-4-5-full":    true,
		"nai-diffusion-4-5-curated": true,
		"":                          true, // the Other… entry, which takes a typed identifier
	}
	block := string(js)
	start := strings.Index(block, "const GEN_MODELS = [")
	if start < 0 {
		t.Fatal("could not find the model list")
	}
	end := strings.Index(block[start:], "];")
	for _, line := range strings.Split(block[start:start+end], "\n") {
		i := strings.Index(line, "', '")
		if i < 0 {
			continue
		}
		id := strings.TrimSuffix(strings.TrimSpace(line[i+4:]), "],")
		id = strings.Trim(id, "'")
		if !known[id] {
			t.Errorf("the model list offers %q, which is not a NovelAI identifier", id)
		}
	}
}

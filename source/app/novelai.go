package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Generating through NovelAI's own image API.
//
// This is the second way images get into the library. The browser extension
// still works exactly as before and both paths end up in the same store
// through the same Insert, so search, metadata, explicit-content flagging
// and undo need no special case for either.
//
// The token is the sensitive part, and the rules around it are deliberate:
// it is written encrypted, it is never sent back to the page that set it,
// and requests carrying it can only go to NovelAI's own host. That last one
// is enforced here in code rather than by convention, because "we only ever
// call NovelAI" is the kind of promise that quietly stops being true.

// defaultModel is what a request that names no model falls back to.
//
// The interface holds the same string in ui/generate.js, and a test asserts
// they still match. Two defaults that drift apart mean the app quietly
// generates with a different model than the one on screen - invisible until
// the picture comes back wrong.
const defaultModel = "nai-diffusion-5-full"

const (
	naiHost     = "image.novelai.net"
	naiAPIHost  = "api.novelai.net"
	naiEndpoint = "https://" + naiHost + "/ai/generate-image"
	naiUserData = "https://" + naiAPIHost + "/user/data"
	naiTimeout  = 3 * time.Minute
)

// naiAllowedHost is the allowlist a request carrying the token may reach.
// Two hosts, both NovelAI's: images come from one and account details from
// the other. Anything else is refused, whatever a caller or config says.
func naiAllowedHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "https" {
		return false
	}
	return strings.EqualFold(u.Host, naiHost) || strings.EqualFold(u.Host, naiAPIHost)
}

// --- the token ---------------------------------------------------------

type tokenStore struct {
	mu   sync.Mutex
	path string
}

func newTokenStore(dataDir string) *tokenStore {
	return &tokenStore{path: filepath.Join(dataDir, "novelai-token.bin")}
}

// Set writes the token, encrypted where the platform can do it. An empty
// value clears it, which is how "forget my token" is expressed.
func (t *tokenStore) Set(token string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	token = strings.TrimSpace(token)
	if token == "" {
		os.Remove(t.path)
		return nil
	}
	sealed, err := sealSecret([]byte(token))
	if err != nil {
		return err
	}
	// 0600 is meaningful on the Linux dev build and harmless on Windows,
	// where the encryption is what actually protects it.
	return os.WriteFile(t.path, sealed, 0o600)
}

func (t *tokenStore) Get() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	b, err := os.ReadFile(t.path)
	if err != nil {
		return "", fmt.Errorf("no API token saved yet")
	}
	clear, err := openSecret(b)
	if err != nil {
		return "", fmt.Errorf("your saved token could not be read; enter it again")
	}
	return string(clear), nil
}

func (t *tokenStore) Present() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, err := os.Stat(t.path)
	return err == nil && st.Size() > 0
}

// --- generating ---------------------------------------------------------

// GenerateRequest is what the UI sends. It is deliberately not the same
// shape as NovelAI's payload: keeping a boundary here means the app's own
// interface doesn't have to change every time theirs does.
type GenerateRequest struct {
	Prompt   string  `json:"prompt"`
	Negative string  `json:"negative"`
	Model    string  `json:"model"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Steps    int     `json:"steps"`
	Scale    float64 `json:"scale"`
	Sampler  string  `json:"sampler"`
	Seed     int64   `json:"seed"`
	Count    int     `json:"count"`
	// NoiseSchedule is model-dependent; empty lets NovelAI choose.
	NoiseSchedule string `json:"noiseSchedule"`
	// CFGRescale is NovelAI's cfg_rescale; 0 leaves it off.
	CFGRescale float64 `json:"cfgRescale"`
	// Characters are V4's separate per-character prompts. Up to six.
	Characters []CharacterPrompt `json:"characters"`

	// Working from an existing picture. Image is base64 PNG; Mask marks the
	// part to repaint, and its presence is what turns this into inpainting
	// rather than a variation on the whole frame.
	Image    string  `json:"image"`
	Mask     string  `json:"mask"`
	Strength float64 `json:"strength"`
	Noise    float64 `json:"noise"`
	// Structured overrides the guess about whether this model wants the
	// v4_prompt fields. nil means "decide from the model name".
	Structured *bool `json:"structured"`
}

func (g *GenerateRequest) fill() {
	if g.Model == "" {
		g.Model = defaultModel
	}
	if g.Width <= 0 {
		g.Width = 832
	}
	if g.Height <= 0 {
		g.Height = 1216
	}
	if g.Steps <= 0 {
		g.Steps = 23
	}
	if g.Scale <= 0 {
		g.Scale = 6
	}
	if g.Sampler == "" {
		g.Sampler = "k_euler_ancestral"
	}
	if g.Count <= 0 {
		g.Count = 1
	}
	// A count above this is a mistake or a runaway loop, and every one of
	// them costs Anlas.
	if g.Count > 4 {
		g.Count = 4
	}

	if g.Image != "" && g.Strength <= 0 {
		g.Strength = 0.7
	}

	// NovelAI takes six characters at most, and an empty one would tell the
	// model there is a person there with nothing to say about them.
	kept := g.Characters[:0]
	for _, c := range g.Characters {
		if strings.TrimSpace(c.Prompt) == "" {
			continue
		}
		if len(kept) == 6 {
			break
		}
		// A centre is sent whether or not one was chosen, so an unset pair
		// becomes the middle of the frame rather than the top-left corner.
		if !c.Position {
			if c.X == 0 {
				c.X = 0.5
			}
			if c.Y == 0 {
				c.Y = 0.5
			}
		}
		kept = append(kept, c)
	}
	g.Characters = kept
}

// CharacterPrompt is one character in a multi-character scene.
//
// V4 introduced these because describing two people in one prompt makes the
// model blend them - one prompt each keeps their descriptions apart. X and Y
// are fractions of the frame; leaving Position off lets the model decide,
// which NovelAI's own documentation describes as the more reliable default.
type CharacterPrompt struct {
	Prompt   string  `json:"prompt"`
	Negative string  `json:"negative"`
	Position bool    `json:"position"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

// naiCharCaptions builds the char_captions list for one side of the prompt.
func naiCharCaptions(chars []CharacterPrompt, negative bool) []any {
	out := make([]any, 0, len(chars))
	for _, c := range chars {
		text := c.Prompt
		if negative {
			text = c.Negative
		}
		// A centre is always sent, even when nobody chose one.
		//
		// An empty list looked like the honest way to say "you decide", and
		// it is what broke every generation that had a character prompt in
		// it. NovelAI's own requests always carry a coordinate; `use_coords`
		// is the flag that decides whether it means anything. So the value
		// goes in regardless and, with use_coords off, is ignored.
		entry := map[string]any{
			"char_caption": text,
			"centers":      []any{map[string]any{"x": c.X, "y": c.Y}},
		}
		out = append(out, entry)
	}
	return out
}

// naiPayload builds NovelAI's request body.
//
// The shape - input/model/action at the root and everything else nested
// under parameters - is what their API expects. Values the caller did not
// set are left out rather than sent as zero, since a zero is a real setting
// to them and "unset" is not.
func naiPayload(g GenerateRequest) map[string]any {
	params := map[string]any{
		"params_version":       3,
		"width":                g.Width,
		"height":               g.Height,
		"scale":                g.Scale,
		"sampler":              g.Sampler,
		"steps":                g.Steps,
		"n_samples":            1, // asked for one at a time, so a failure costs one
		"ucPreset":             0,
		"qualityToggle":        false, // the app manages quality tags itself
		"dynamic_thresholding": false,
		"controlnet_strength":  1,
		"legacy":               false,
		"cfg_rescale":          g.CFGRescale,
		"negative_prompt":      g.Negative,
	}
	if g.Seed > 0 {
		params["seed"] = g.Seed
	}
	if g.NoiseSchedule != "" {
		params["noise_schedule"] = g.NoiseSchedule
	}

	// V4 and later carry the prompt a second time in their own structure.
	// Sending only `input` gets you a picture that ignored half the prompt,
	// which looks like a bad model rather than a missing field - so this is
	// worth getting right even though it reads as duplication.
	structured := isV4Model(g.Model)
	if g.Structured != nil {
		structured = *g.Structured
	}
	if structured {
		// use_coords only means anything if a character actually asked to
		// be somewhere; switching it on with no positions set would tell
		// the model to obey coordinates nobody chose.
		useCoords := false
		for _, c := range g.Characters {
			if c.Position {
				useCoords = true
				break
			}
		}
		params["v4_prompt"] = map[string]any{
			"caption": map[string]any{
				"base_caption":  g.Prompt,
				"char_captions": naiCharCaptions(g.Characters, false),
			},
			"use_coords": useCoords,
			"use_order":  true,
		}
		params["v4_negative_prompt"] = map[string]any{
			"caption": map[string]any{
				"base_caption":  g.Negative,
				"char_captions": naiCharCaptions(g.Characters, true),
			},
			"legacy_uc": false,
		}
	}

	action := generationAction(g)
	model := g.Model
	if action == "infill" {
		// Chosen from the base model rather than offered as a setting:
		// there is exactly one right answer and the app knows it.
		model = inpaintModelFor(g.Model)
	}

	if g.Image != "" {
		params["image"] = g.Image
		// Strength is how far it may stray from what is already there, and
		// noise is how much is thrown in to work from. Both only mean
		// anything once there is a source image.
		params["strength"] = g.Strength
		params["noise"] = g.Noise
	}
	if g.Mask != "" {
		params["mask"] = g.Mask
		// Only meaningful when inpainting: it keeps the part outside the
		// mask exactly as it was, so no seam shows. Sent on a plain
		// generate it is at best ignored and at worst confusing.
		params["add_original_image"] = true
	}

	return map[string]any{
		"input":      g.Prompt,
		"model":      model,
		"action":     action,
		"parameters": params,
	}
}

// isV4Model reports whether a model takes the structured prompt fields.
//
// Matched by family rather than an exact list, so a point release does not
// silently fall back to the V3 shape. V5 is included on the assumption that
// it continued the structure V4 introduced rather than returning to a bare
// `input` string - if that turns out to be wrong, the Structured prompt
// switch in the interface turns it off without a rebuild.
func isV4Model(model string) bool {
	m := strings.ToLower(model)
	return strings.HasPrefix(m, "nai-diffusion-4") || strings.HasPrefix(m, "nai-diffusion-5")
}

// naiError turns a status code into something worth reading. The status
// alone tells the user nothing they can act on.
// naiMessage digs NovelAI's own explanation out of a response body. They
// answer errors as {"message": "..."}, and that sentence is worth more than
// the status code: "answered 500" tells nobody what to do, while their own
// words usually name the problem outright.
func naiMessage(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var out struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(body, &out) == nil {
		if out.Message != "" {
			return out.Message
		}
		if out.Error != "" {
			return out.Error
		}
	}
	msg := strings.TrimSpace(string(body))
	if len(msg) > 200 {
		msg = msg[:200] + "…"
	}
	return msg
}

func naiError(code int, body []byte) error {
	detail := naiMessage(body)
	with := func(base string) error {
		if detail == "" {
			return fmt.Errorf("%s", base)
		}
		return fmt.Errorf("%s — NovelAI said: %s", base, detail)
	}

	switch code {
	case 401:
		return fmt.Errorf("NovelAI rejected the token — check it in Settings")
	case 402:
		return fmt.Errorf("not enough Anlas for that generation")
	case 429:
		return fmt.Errorf("NovelAI is rate limiting; wait a moment and try again")
	case 400:
		return with("NovelAI refused those settings")
	}
	return with(fmt.Sprintf("NovelAI answered %d", code))
}

// naiGenerate asks for a single image and returns the PNG bytes. It refuses
// any endpoint that is not NovelAI's own.
func naiGenerate(endpoint, token string, g GenerateRequest) ([]byte, error) {
	if !naiAllowedHost(endpoint) {
		// The token must never leave for anywhere else, whatever a config
		// file or a caller says.
		return nil, fmt.Errorf("refusing to send the token to %s", endpoint)
	}
	return naiGenerateAt(endpoint, token, g)
}

// naiGenerateAt is naiGenerate without the host check, so the request
// building and response parsing can be tested against a local server. It is
// unexported and called from exactly two places: naiGenerate, and tests.
func naiGenerateAt(endpoint, token string, g GenerateRequest) ([]byte, error) {

	body, err := json.Marshal(naiPayload(g))
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/x-zip-compressed")
	req.Header.Set("User-Agent", appName+"/"+appVersion)

	client := &http.Client{Timeout: naiTimeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach NovelAI: %v", err)
	}
	defer res.Body.Close()

	// Cap the read: a wrong endpoint answering with something enormous
	// should fail, not fill memory.
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, naiError(res.StatusCode, raw)
	}
	return firstPNGFromZip(raw)
}

// firstPNGFromZip pulls the image out of NovelAI's zip response.
func firstPNGFromZip(raw []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		// Not a zip: most likely an error page or a plain image. If it is
		// already a PNG, take it rather than failing on a technicality.
		if len(raw) > 8 && bytes.HasPrefix(raw, []byte("\x89PNG\r\n\x1a\n")) {
			return raw, nil
		}
		return nil, fmt.Errorf("NovelAI sent something unreadable back")
	}
	for _, f := range zr.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".png") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		return io.ReadAll(io.LimitReader(rc, 64<<20))
	}
	return nil, fmt.Errorf("no image in NovelAI's response")
}

// --- how much Anlas is left --------------------------------------------

// naiAnlas reads the account's remaining Anlas.
//
// NovelAI reports it as "training steps": a fixed monthly allowance that
// refills, plus any bought outright. What people call their Anlas balance
// is the two added together, so that is what this returns - along with the
// halves, since "you have 300 but 280 of them refill on the 4th" is a
// different situation from "you have 300 and that is all there is".
type AnlasBalance struct {
	Total     int  `json:"total"`
	Fixed     int  `json:"fixed"`
	Purchased int  `json:"purchased"`
	Known     bool `json:"known"`
	// Why the figure is missing, when it is. Shown as the tooltip rather
	// than swallowed, because "—" with no explanation is the thing that
	// wasted an evening.
	Reason string `json:"reason,omitempty"`

	// What the account is, and what it gets for nothing.
	//
	// NovelAI's own documentation says Opus generates free when the image
	// is one at a time, no larger than a Normal size, at most 28 steps, not
	// worked from another picture, and on a V4.5-or-lower model. Those
	// conditions are the published ones; the numbers behind them come from
	// the account itself where the response carries them, so a change at
	// their end does not leave this app quoting a stale rule.
	Tier           int    `json:"tier"`
	TierName       string `json:"tierName,omitempty"`
	FreeGeneration bool   `json:"freeGeneration"`
	FreeMaxPixels  int    `json:"freeMaxPixels,omitempty"`
	FreeMaxSteps   int    `json:"freeMaxSteps,omitempty"`
}

// Opus's published free-generation limits, used when the account response
// does not spell them out itself.
const (
	opusFreeMaxPixels = 1024 * 1024
	opusFreeMaxSteps  = 28
)

func tierName(tier int) string {
	switch tier {
	case 0:
		return "Paper"
	case 1:
		return "Tablet"
	case 2:
		return "Scroll"
	case 3:
		return "Opus"
	}
	return ""
}

func naiFetchAnlas(endpoint, token string) (AnlasBalance, error) {
	var out AnlasBalance
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", appName+"/"+appVersion)

	res, err := (&http.Client{Timeout: updateTimeout}).Do(req)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return out, naiError(res.StatusCode, nil)
	}

	// Pointers, so an absent field and a zero can be told apart.
	//
	// This is the whole bug: the balance used to count as "known" only when
	// one of the two numbers was above zero, so an account that genuinely
	// has nothing left - or an Opus subscription, where the ordinary sizes
	// are free and the fixed allowance really does sit at zero - displayed
	// as "Anlas —" and looked broken. Zero is an answer. Only a missing
	// field is not.
	var raw struct {
		Subscription *struct {
			Tier              *int `json:"tier"`
			TrainingStepsLeft *struct {
				Fixed     *int `json:"fixedTrainingStepsLeft"`
				Purchased *int `json:"purchasedTrainingSteps"`
			} `json:"trainingStepsLeft"`
			Perks *struct {
				UnlimitedImageGeneration *bool `json:"unlimitedImageGeneration"`
				// Read for its numbers rather than relied upon: where the
				// account states the size it generates free at, that is
				// better than this app's copy of the published figure.
				Limits []struct {
					Resolution *int `json:"resolution"`
					MaxPrompts *int `json:"maxPrompts"`
				} `json:"unlimitedImageGenerationLimits"`
			} `json:"perks"`
		} `json:"subscription"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return out, err
	}
	if raw.Subscription != nil {
		out.Tier = -1
		if raw.Subscription.Tier != nil {
			out.Tier = *raw.Subscription.Tier
			out.TierName = tierName(out.Tier)
		}
		p := raw.Subscription.Perks
		if p != nil && p.UnlimitedImageGeneration != nil {
			out.FreeGeneration = *p.UnlimitedImageGeneration
		} else {
			out.FreeGeneration = out.Tier == 3
		}
		if p != nil {
			for _, l := range p.Limits {
				if l.Resolution != nil && *l.Resolution > out.FreeMaxPixels {
					out.FreeMaxPixels = *l.Resolution
				}
			}
		}
		if out.FreeGeneration {
			if out.FreeMaxPixels == 0 {
				out.FreeMaxPixels = opusFreeMaxPixels
			}
			out.FreeMaxSteps = opusFreeMaxSteps
		}
	}
	if raw.Subscription == nil || raw.Subscription.TrainingStepsLeft == nil {
		out.Reason = "NovelAI did not report a balance for this account"
		return out, nil
	}
	steps := raw.Subscription.TrainingStepsLeft
	if steps.Fixed == nil && steps.Purchased == nil {
		out.Reason = "NovelAI did not report a balance for this account"
		return out, nil
	}
	if steps.Fixed != nil {
		out.Fixed = *steps.Fixed
	}
	if steps.Purchased != nil {
		out.Purchased = *steps.Purchased
	}
	out.Total = out.Fixed + out.Purchased
	out.Known = true
	return out, nil
}

// --- working from an existing image ------------------------------------

// inpaintModelFor returns the model that can repaint part of a picture.
//
// NovelAI trains a separate inpainting model per family, and asking the
// ordinary one to infill simply fails. Deriving it from the base model
// means this is never a choice anyone has to get right: pick the model you
// want the picture to look like, and the matching inpainting model is used
// when there is a mask.
func inpaintModelFor(model string) string {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return ""
	}
	if strings.HasSuffix(m, "-inpainting") {
		return m // already one
	}
	switch m {
	// The furry models are the exception: theirs is not named after the
	// base model the way every other family's is.
	case "nai-diffusion-furry", "nai-diffusion-furry-3":
		return "furry-diffusion-inpainting"
	}
	return m + "-inpainting"
}

// generationAction reports what NovelAI is being asked to do.
//
//	generate - a new picture from nothing
//	img2img  - the same picture again, changed by Strength
//	infill   - repaint only what the mask covers
func generationAction(g GenerateRequest) string {
	if g.Image == "" {
		return "generate"
	}
	if g.Mask != "" {
		return "infill"
	}
	return "img2img"
}

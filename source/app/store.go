package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Storage for the gallery.
//
// Images are plain files on disk named by record id; metadata lives in a
// single JSON index. No embedded database, so there is nothing to migrate
// and the user's images stay ordinary files they can copy out at any time.
// Writes are atomic (temp file + rename) so a crash mid-write can't leave a
// corrupt index behind.

type Source struct {
	URL        string `json:"url,omitempty"`
	CapturedBy string `json:"capturedBy,omitempty"`
}

type Record struct {
	ID       string   `json:"id"`
	Filename string   `json:"filename"`
	Hash     string   `json:"hash"`
	Bytes    int      `json:"bytes"`
	AddedAt  string   `json:"addedAt"`
	Source   *Source  `json:"source"`
	Favorite bool     `json:"favorite"`
	Pinned   bool     `json:"pinned"`
	Folders  []string `json:"folders"`
	Notes    string   `json:"notes"`
	Meta     Meta     `json:"meta"`

	// What the classifier decided from the prompt, and the user's own
	// decision if they made one. NSFWManual is a pointer so "not set" is
	// distinct from "explicitly marked safe".
	NSFWAuto   bool  `json:"nsfwAuto"`
	NSFWManual *bool `json:"nsfwManual,omitempty"`

	// A colour label, like the ones a file manager puts on files. Empty
	// means none. Stored as the hex the UI offered, so the palette can
	// change without rewriting every record.
	Color string `json:"color,omitempty"`

	// Lowercased searchable text, built on demand and never serialised.
	searchCache string
	searchGen   int
}

type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Empty parent means a top-level folder. Order is the position among
	// siblings; together they're the whole shape of the tree.
	ParentID  string   `json:"parentId,omitempty"`
	Order     int      `json:"order"`
	Tags      []string `json:"tags"`
	CreatedAt string   `json:"createdAt"`
}

type Settings struct {
	Theme         string `json:"theme"`
	CardSize      int    `json:"cardSize"`
	InspectorOpen bool   `json:"inspectorOpen"`
	CaptureMode   string `json:"captureMode"`
	Onboarded     bool   `json:"onboarded"`
	// Layout: grid | justified | waterfall | list
	Layout string `json:"layout"`
	// Sort: newest | oldest | prompt | model | largest | smallest
	Sort string `json:"sort"`
	// MetaView: how prompts are shown - "tags" (default) or "raw" text
	MetaView string `json:"metaView"`
	// FlagNSFW: blur explicit images in the gallery behind a reveal.
	FlagNSFW bool `json:"flagNsfw"`
	// SidebarWidth in pixels, dragged by the handle beside the sidebar.
	SidebarWidth int `json:"sidebarWidth"`
	// InterceptDownloads: when saving an image on NovelAI, keep it here
	// instead of letting the browser write a file.
	InterceptDownloads bool `json:"interceptDownloads"`
	// AutoUpdate: fetch and install a new build without asking first. Off
	// by default - replacing the program someone is in the middle of using
	// is not something to do behind their back unless they asked for it.
	AutoUpdate bool `json:"autoUpdate"`
	// LastUpdateCheck is the date (YYYY-MM-DD) of the last automatic check,
	// which is what makes the prompt appear once on the first open of the
	// day. The app writes it, not the settings screen, so UpdateSettings
	// keeps the stored value rather than whatever the UI echoed back.
	LastUpdateCheck string `json:"lastUpdateCheck"`
}

func defaultSettings() Settings {
	return Settings{
		Theme:    "midnight",
		CardSize: 190,
		// The details panel duplicates what the large view already shows,
		// so it starts out of the way and is one click back.
		InspectorOpen: false,
		// 'generated' -> only images from a new generation (default)
		// 'all'       -> also import the existing NovelAI history backlog
		// 'download'  -> only when you save/download on NovelAI
		CaptureMode:  "generated",
		Onboarded:    false,
		Layout:       "waterfall",
		Sort:         "newest",
		MetaView:     "tags",
		FlagNSFW:     true,
		SidebarWidth: 232,
	}
}

type Store struct {
	mu sync.RWMutex

	dir       string
	imagesDir string

	records  []*Record
	byID     map[string]*Record
	byHash   map[string]*Record
	folders  []*Folder
	settings Settings

	// Colour label (lowercased hex) -> the name the user gave it, so a
	// palette swatch can mean "needs work" and be searchable as that.
	colorNames map[string]string
	// Bumped whenever folders or tags change, so cached search text that
	// includes folder names is rebuilt rather than going stale.
	folderGen int

	undoStack []undoEntry
	redoStack []undoEntry
}

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	// RFC-4122-ish; only needs to be unique locally.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func NewStore(dir string) (*Store, error) {
	s := &Store{
		dir:        dir,
		imagesDir:  filepath.Join(dir, "images"),
		byID:       map[string]*Record{},
		byHash:     map[string]*Record{},
		colorNames: map[string]string{},
		settings:   defaultSettings(),
	}
	if err := os.MkdirAll(s.imagesDir, 0o755); err != nil {
		return nil, err
	}

	s.loadJSON(s.indexPath(), &s.records)
	s.loadJSON(s.foldersPath(), &s.folders)
	s.loadJSON(s.settingsPath(), &s.settings)
	s.loadJSON(s.tagsPath(), &s.colorNames)
	if s.colorNames == nil {
		s.colorNames = map[string]string{}
	}

	for _, r := range s.records {
		if r == nil {
			continue
		}
		s.byID[r.ID] = r
		s.byHash[r.Hash] = r
	}

	// Anything still in the trash belongs to an undo history that didn't
	// survive the last shutdown, so it can never be restored now.
	s.sweepTrash()
	return s, nil
}

func (s *Store) indexPath() string    { return filepath.Join(s.dir, "index.json") }
func (s *Store) foldersPath() string  { return filepath.Join(s.dir, "folders.json") }
func (s *Store) settingsPath() string { return filepath.Join(s.dir, "settings.json") }
func (s *Store) tagsPath() string     { return filepath.Join(s.dir, "color-labels.json") }

func (s *Store) loadJSON(path string, dst any) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	if err := json.Unmarshal(b, dst); err != nil {
		// Preserve the unreadable file instead of silently discarding it.
		os.Rename(path, fmt.Sprintf("%s.corrupt-%d", path, time.Now().Unix()))
	}
}

func writeJSONAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) saveIndex()    { writeJSONAtomic(s.indexPath(), s.records) }
func (s *Store) saveFolders()  { writeJSONAtomic(s.foldersPath(), s.folders) }
func (s *Store) saveSettings() { writeJSONAtomic(s.settingsPath(), s.settings) }
func (s *Store) saveTags()     { writeJSONAtomic(s.tagsPath(), s.colorNames) }

func (s *Store) ImagePath(r *Record) string { return filepath.Join(s.imagesDir, r.Filename) }

func (s *Store) FindByHash(h string) *Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byHash[h]
}

func (s *Store) Get(id string) *Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byID[id]
}

func (s *Store) Insert(data []byte, src *Source) (*Record, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing := s.byHash[hash]; existing != nil {
		return existing, nil
	}

	id := newID()
	filename := id + ".png"
	if err := os.WriteFile(filepath.Join(s.imagesDir, filename), data, 0o644); err != nil {
		return nil, err
	}

	r := &Record{
		ID:       id,
		Filename: filename,
		Hash:     hash,
		Bytes:    len(data),
		// Fixed-width to the nanosecond: RFC3339Nano trims trailing zeros,
		// which would break the string comparison the orderings rely on.
		AddedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z"),
		Source:  src,
		Folders: []string{},
		Meta:    extractMetadata(data),
	}
	r.NSFWAuto = classifyNSFW(r.Meta)

	s.records = append(s.records, r)
	s.byID[id] = r
	s.byHash[hash] = r
	s.saveIndex()

	// Make the thumbnail off the hot path. Decoding a 3 MB PNG while
	// holding the store lock would stall every other request for as long as
	// it took, and the capture itself is already safely on disk by here.
	go func() { _, _ = s.EnsureThumb(r) }()

	return r, nil
}

type Patch struct {
	Favorite *bool     `json:"favorite"`
	Pinned   *bool     `json:"pinned"`
	Folders  *[]string `json:"folders"`
	Notes    *string   `json:"notes"`
	// nsfw sets a manual mark; nsfwClear drops back to the automatic one.
	NSFW      *bool   `json:"nsfw"`
	NSFWClear bool    `json:"nsfwClear"`
	Color     *string `json:"color"`
}

func (s *Store) Update(id string, p Patch) *Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.byID[id]
	if r == nil {
		return nil
	}

	before := snapshotOf(r)
	label := "Change image"
	if p.Favorite != nil {
		r.Favorite = *p.Favorite
		label = "Favorite"
		if !*p.Favorite {
			label = "Remove from favorites"
		}
	}
	if p.Pinned != nil {
		r.Pinned = *p.Pinned
		label = "Pin"
		if !*p.Pinned {
			label = "Unpin"
		}
	}
	if p.Folders != nil {
		r.Folders = *p.Folders
		label = "Move image"
	}
	if p.Notes != nil {
		r.Notes = *p.Notes
		r.searchCache = "" // notes are searchable, so the cache is stale
		label = "Edit note"
	}
	if p.Color != nil {
		r.Color = *p.Color
		r.searchCache = ""
		label = "Colour label"
		if *p.Color == "" {
			label = "Remove colour label"
		}
	}
	if p.NSFWClear {
		r.NSFWManual = nil
		label = "Reset NSFW mark"
	} else if p.NSFW != nil {
		v := *p.NSFW
		r.NSFWManual = &v
		label = "Mark as NSFW"
		if !v {
			label = "Remove NSFW mark"
		}
	}
	after := snapshotOf(r)
	s.pushUndo(undoEntry{
		label: label,
		undo:  func() { applySnapshot(s.byID[id], before) },
		redo:  func() { applySnapshot(s.byID[id], after) },
	})

	s.saveIndex()
	return r
}

// A record's editable state, small enough to keep two copies of per undo
// entry. The image bytes and metadata are untouched by any of this.
type recordSnapshot struct {
	favorite   bool
	pinned     bool
	folders    []string
	notes      string
	color      string
	nsfwManual *bool
}

func snapshotOf(r *Record) recordSnapshot {
	snap := recordSnapshot{
		favorite: r.Favorite,
		pinned:   r.Pinned,
		notes:    r.Notes,
		color:    r.Color,
		folders:  append([]string(nil), r.Folders...),
	}
	if r.NSFWManual != nil {
		v := *r.NSFWManual
		snap.nsfwManual = &v
	}
	return snap
}

func applySnapshot(r *Record, snap recordSnapshot) {
	if r == nil {
		return
	}
	r.Favorite = snap.favorite
	r.Pinned = snap.pinned
	r.Notes = snap.notes
	r.Color = snap.color
	r.Folders = append([]string(nil), snap.folders...)
	r.NSFWManual = snap.nsfwManual
	r.searchCache = ""
}

func (s *Store) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deleteLocked([]string{id}, "Delete image") > 0
}

// deleteLocked removes images and records how to bring them back. The
// files move to the trash rather than being unlinked, because an undo
// that can't restore the picture isn't an undo.
func (s *Store) deleteLocked(ids []string, label string) int {
	type gone struct {
		rec   *Record
		index int
	}

	drop := make(map[string]bool, len(ids))
	for _, id := range ids {
		drop[id] = true
	}

	var removed []gone
	out := s.records[:0]
	for i, r := range s.records {
		if r == nil {
			continue
		}
		if !drop[r.ID] {
			out = append(out, r)
			continue
		}
		removed = append(removed, gone{rec: r, index: i})
		delete(s.byID, r.ID)
		delete(s.byHash, r.Hash)
		s.trashFile(r.Filename)
	}
	s.records = out
	if len(removed) == 0 {
		return 0
	}
	s.saveIndex()

	if len(removed) > 1 {
		label = fmt.Sprintf("Delete %d images", len(removed))
	}
	s.pushUndo(undoEntry{
		label: label,
		undo: func() {
			// Put each record back where it was, oldest position first so
			// the indices stay meaningful as the slice grows.
			for i := len(removed) - 1; i >= 0; i-- {
				g := removed[i]
				s.restoreFile(g.rec.Filename)
				at := g.index
				if at > len(s.records) {
					at = len(s.records)
				}
				s.records = append(s.records, nil)
				copy(s.records[at+1:], s.records[at:])
				s.records[at] = g.rec
				s.byID[g.rec.ID] = g.rec
				s.byHash[g.rec.Hash] = g.rec
			}
		},
		redo: func() {
			for _, g := range removed {
				out := s.records[:0]
				for _, r := range s.records {
					if r.ID != g.rec.ID {
						out = append(out, r)
					}
				}
				s.records = out
				delete(s.byID, g.rec.ID)
				delete(s.byHash, g.rec.Hash)
				s.trashFile(g.rec.Filename)
			}
		},
		discard: func() {
			for _, g := range removed {
				s.purgeTrashed(g.rec.Filename)
			}
		},
	})
	return len(removed)
}

// BulkOp applies one change to many images in a single pass, so a
// hundred-image selection costs one index write instead of a hundred.
type BulkOp struct {
	IDs           []string `json:"ids"`
	Favorite      *bool    `json:"favorite"`
	Pinned        *bool    `json:"pinned"`
	AddFolders    []string `json:"addFolders"`
	RemoveFolders []string `json:"removeFolders"`
	NSFW          *bool    `json:"nsfw"`
	Color         *string  `json:"color"`
}

func (s *Store) BulkUpdate(op BulkOp) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	before := map[string]recordSnapshot{}
	changed := 0
	for _, id := range op.IDs {
		r := s.byID[id]
		if r == nil {
			continue
		}
		before[id] = snapshotOf(r)

		if op.Favorite != nil {
			r.Favorite = *op.Favorite
		}
		if op.Pinned != nil {
			r.Pinned = *op.Pinned
		}
		if op.NSFW != nil {
			v := *op.NSFW
			r.NSFWManual = &v
		}
		if op.Color != nil {
			r.Color = *op.Color
		}
		for _, add := range op.AddFolders {
			has := false
			for _, f := range r.Folders {
				if f == add {
					has = true
					break
				}
			}
			if !has {
				r.Folders = append(r.Folders, add)
			}
		}
		for _, rem := range op.RemoveFolders {
			out := r.Folders[:0]
			for _, f := range r.Folders {
				if f != rem {
					out = append(out, f)
				}
			}
			r.Folders = out
		}
		r.searchCache = ""
		changed++
	}
	if changed == 0 {
		return 0
	}

	after := map[string]recordSnapshot{}
	for id := range before {
		if r := s.byID[id]; r != nil {
			after[id] = snapshotOf(r)
		}
	}

	label := fmt.Sprintf("Change %d images", changed)
	switch {
	case len(op.AddFolders) > 0:
		label = fmt.Sprintf("Move %d images", changed)
	case op.Favorite != nil:
		label = fmt.Sprintf("Favorite %d images", changed)
	case op.Pinned != nil:
		label = fmt.Sprintf("Pin %d images", changed)
	case op.NSFW != nil:
		label = fmt.Sprintf("Mark %d images", changed)
	case op.Color != nil:
		label = fmt.Sprintf("Colour %d images", changed)
	}
	if changed == 1 {
		label = strings.TrimSuffix(strings.Replace(label, " 1 images", "", 1), " ")
	}

	s.pushUndo(undoEntry{
		label: label,
		undo: func() {
			for id, snap := range before {
				applySnapshot(s.byID[id], snap)
			}
		},
		redo: func() {
			for id, snap := range after {
				applySnapshot(s.byID[id], snap)
			}
		},
	})

	s.saveIndex()
	return changed
}

func (s *Store) BulkDelete(ids []string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deleteLocked(ids, "Delete images")
}

func (s *Store) ClearAll() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	ids := make([]string, 0, len(s.records))
	for _, r := range s.records {
		if r != nil {
			ids = append(ids, r.ID)
		}
	}
	n := s.deleteLocked(ids, "Clear the gallery")
	// deleteLocked labels multi-image deletes by count; this one has a
	// name of its own worth keeping.
	if n > 0 {
		s.undoStack[len(s.undoStack)-1].label = fmt.Sprintf("Clear the gallery (%d images)", n)
	}
	return n
}

// RescanNSFW re-runs the classifier over the whole library. Called when
// the setting is switched on or off, so a toggle applies to images that
// were saved before the feature existed - or before the word list last
// changed. Manual marks are left alone; they are the user's answer, not
// the classifier's.
func (s *Store) RescanNSFW() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	changed := 0
	for _, r := range s.records {
		if r == nil {
			continue
		}
		was := r.NSFWAuto
		r.NSFWAuto = classifyNSFW(r.Meta)
		if was != r.NSFWAuto {
			changed++
		}
	}
	s.saveIndex()
	return changed
}

type ListOpts struct {
	Query    string
	Favorite bool
	Pinned   bool
	Folder   string
	// Colour of a folder tag: shows images filed under any folder
	// carrying a tag of that colour.
	Color  string
	Sort   string
	Limit  int
	Offset int
}

type ListResult struct {
	Total int       `json:"total"`
	Items []*Record `json:"items"`
}

func anyToString(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%v", v)
}

// Everything about an image that search should look at.
//
// The prompt on a V4 image is not one string: the base caption, each
// character's caption, the undesired content and each character's
// undesired content are separate fields inside the embedded JSON. Only
// the base one used to be searched, so a tag that belonged to a character
// found nothing - and clicking that very tag in the details panel, which
// searches for it, came back empty.
//
// Rather than hardcoding the V4 field names (which I can't verify against
// a live account, and which have already changed once between prompt
// formats), this walks the stored JSON and takes the text out of any field
// whose name looks like a caption or a prompt. A rename to
// "character_captions" or similar keeps working.
func collectCaptions(v any, depth int, out *[]string) {
	if depth > 6 || len(*out) > 400 {
		return
	}
	switch t := v.(type) {
	case string:
		if len(t) > 0 && len(t) < 20000 {
			*out = append(*out, t)
		}
	case []any:
		for _, item := range t {
			collectCaptions(item, depth+1, out)
		}
	case map[string]any:
		for k, item := range t {
			lk := strings.ToLower(k)
			// Descend through containers, collect from anything that
			// reads like prompt text.
			if strings.Contains(lk, "caption") || strings.Contains(lk, "prompt") ||
				lk == "uc" || lk == "text" || lk == "char" || lk == "characters" {
				collectCaptions(item, depth+1, out)
			} else if _, nested := item.(map[string]any); nested {
				collectCaptions(item, depth+1, out)
			} else if _, arr := item.([]any); arr {
				collectCaptions(item, depth+1, out)
			}
		}
	}
}

func buildSearchText(r *Record, folderText, colorName string) string {
	parts := []string{
		r.Meta.Prompt, r.Meta.NegativePrompt, r.Meta.Model, r.Meta.Sampler,
		anyToString(r.Meta.Seed), r.Notes, r.Filename, folderText, colorName,
	}
	if r.Meta.Comment != nil {
		var captions []string
		collectCaptions(r.Meta.Comment, 0, &captions)
		parts = append(parts, captions...)
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

// searchText memoises the above: a library of a few thousand images would
// otherwise rebuild every haystack on every keystroke. The cache also
// carries folder names and tags, so it's rebuilt whenever those change.
func (s *Store) searchText(r *Record) string {
	if r.searchCache == "" || r.searchGen != s.folderGen {
		r.searchCache = buildSearchText(r, s.folderTextFor(r), s.colorNames[strings.ToLower(r.Color)])
		r.searchGen = s.folderGen
	}
	return r.searchCache
}

// The names and tags of every folder an image is in, walking up to the
// root as it goes.
//
// Ancestors count: an image filed in Projects/Sketches/Rough is inside
// Projects as far as the sidebar count and the colour filter are
// concerned, so searching "Projects" has to find it too. Leaving them out
// made search the odd one out.
func (s *Store) folderTextFor(r *Record) string {
	if len(r.Folders) == 0 {
		return ""
	}
	var parts []string
	seen := map[string]bool{}
	for _, id := range r.Folders {
		for cur := id; cur != "" && !seen[cur]; {
			seen[cur] = true
			f := s.folderByID(cur)
			if f == nil {
				break
			}
			parts = append(parts, f.Name)
			parts = append(parts, f.Tags...)
			cur = f.ParentID
		}
	}
	return strings.Join(parts, " ")
}

// pixels is used by the size orderings; a missing IHDR falls back to the
// file size so an image never sorts as "zero".
func pixels(r *Record) int {
	if r.Meta.Width > 0 && r.Meta.Height > 0 {
		return r.Meta.Width * r.Meta.Height
	}
	return r.Bytes
}

// Several images can land inside the same second - a batch import, or one
// generation returning four pictures - and older records were stamped to
// the second, so timestamps alone can't order them. Insertion order is the
// tiebreaker, which is what makes "oldest first" an exact mirror of
// "newest first" rather than an approximate one.
func sortRecords(out []*Record, mode string, pos map[*Record]int) {
	older := func(i, j int) bool {
		if out[i].AddedAt != out[j].AddedAt {
			return out[i].AddedAt < out[j].AddedAt
		}
		return pos[out[i]] < pos[out[j]]
	}
	newer := func(i, j int) bool {
		if out[i].AddedAt != out[j].AddedAt {
			return out[i].AddedAt > out[j].AddedAt
		}
		return pos[out[i]] > pos[out[j]]
	}

	switch mode {
	case "oldest":
		sort.SliceStable(out, older)
	case "prompt":
		sort.SliceStable(out, func(i, j int) bool {
			a := strings.ToLower(strings.TrimSpace(out[i].Meta.Prompt))
			b := strings.ToLower(strings.TrimSpace(out[j].Meta.Prompt))
			// Images with no prompt sink to the bottom rather than
			// occupying the whole first screen.
			if (a == "") != (b == "") {
				return b == ""
			}
			if a == b {
				return newer(i, j)
			}
			return a < b
		})
	case "model":
		sort.SliceStable(out, func(i, j int) bool {
			a := strings.ToLower(strings.TrimSpace(out[i].Meta.Model))
			b := strings.ToLower(strings.TrimSpace(out[j].Meta.Model))
			if (a == "") != (b == "") {
				return b == ""
			}
			if a == b {
				return newer(i, j)
			}
			return a < b
		})
	case "largest":
		sort.SliceStable(out, func(i, j int) bool {
			if pixels(out[i]) == pixels(out[j]) {
				return newer(i, j)
			}
			return pixels(out[i]) > pixels(out[j])
		})
	case "smallest":
		sort.SliceStable(out, func(i, j int) bool {
			if pixels(out[i]) == pixels(out[j]) {
				return newer(i, j)
			}
			return pixels(out[i]) < pixels(out[j])
		})
	default: // "newest"
		sort.SliceStable(out, newer)
	}
}

func (s *Store) List(o ListOpts) ListResult {
	// A write lock, despite this being a read: searchText memoises into
	// the record it is given, so two concurrent listings - the periodic
	// refresh and a click, say - would otherwise race on that field.
	s.mu.Lock()
	defer s.mu.Unlock()

	var out []*Record
	q := strings.ToLower(strings.TrimSpace(o.Query))

	// A folder filter includes everything nested under it - that's the
	// point of being able to nest them.
	var wanted map[string]bool
	if o.Folder != "" {
		wanted = s.descendants(o.Folder)
	}
	color := strings.ToLower(strings.TrimSpace(o.Color))

	for _, r := range s.records {
		if r == nil {
			continue
		}
		if o.Favorite && !r.Favorite {
			continue
		}
		if o.Pinned && !r.Pinned {
			continue
		}
		if color != "" && strings.ToLower(r.Color) != color {
			continue
		}
		if wanted != nil {
			found := false
			for _, f := range r.Folders {
				if wanted[f] {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if q != "" && !strings.Contains(s.searchText(r), q) {
			continue
		}
		out = append(out, r)
	}

	pos := make(map[*Record]int, len(out))
	for i, r := range out {
		pos[r] = i
	}
	sortRecords(out, o.Sort, pos)

	// Pinned items float to the top of every ordering - they're the ones
	// being actively reused.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Pinned && !out[j].Pinned })

	total := len(out)
	start := o.Offset
	if start > total {
		start = total
	}
	end := start + o.Limit
	if o.Limit <= 0 || end > total {
		end = total
	}
	page := out[start:end]
	if page == nil {
		page = []*Record{}
	}
	return ListResult{Total: total, Items: page}
}

// --- Folders -----------------------------------------------------------

func (s *Store) Folders() []*Folder {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.folders == nil {
		return []*Folder{}
	}
	return s.folders
}

func (s *Store) CreateFolder(name string) (*Folder, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("Folder name required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.folders {
		if strings.EqualFold(f.Name, name) {
			return nil, fmt.Errorf("Folder already exists")
		}
	}
	f := &Folder{ID: newID(), Name: name, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	s.folders = append(s.folders, f)
	s.saveFolders()
	return f, nil
}

func (s *Store) DeleteFolder(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i, f := range s.folders {
		if f.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return false
	}
	s.folders = append(s.folders[:idx], s.folders[idx+1:]...)
	for _, r := range s.records {
		out := r.Folders[:0]
		for _, f := range r.Folders {
			if f != id {
				out = append(out, f)
			}
		}
		r.Folders = out
	}
	s.saveFolders()
	s.saveIndex()
	return true
}

// --- Settings ----------------------------------------------------------

func (s *Store) Settings() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

func (s *Store) UpdateSettings(in Settings) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	// The update bookkeeping belongs to the app, not the settings screen.
	// Carrying it over means a save from the UI can't accidentally reset
	// the daily check by echoing back a blank field.
	in.LastUpdateCheck = s.settings.LastUpdateCheck
	s.settings = in
	if s.settings.Theme == "" {
		s.settings.Theme = "midnight"
	}
	if s.settings.CardSize <= 0 {
		s.settings.CardSize = 190
	}
	if s.settings.CaptureMode == "" {
		s.settings.CaptureMode = "generated"
	}
	if s.settings.Layout == "" {
		s.settings.Layout = "grid"
	}
	if s.settings.Sort == "" {
		s.settings.Sort = "newest"
	}
	if s.settings.MetaView == "" {
		s.settings.MetaView = "tags"
	}
	s.saveSettings()
	return s.settings
}

// CheckedUpdatesToday reports whether the daily check has already run.
func (s *Store) CheckedUpdatesToday(today string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings.LastUpdateCheck == today
}

// MarkUpdateChecked records the day, so the prompt appears once rather than
// on every reopen. It is called only when a check actually succeeded: a
// failed one - no network, GitHub having a moment - should not use up the
// day and hide a real update until tomorrow.
func (s *Store) MarkUpdateChecked(today string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings.LastUpdateCheck = today
	s.saveSettings()
}

// FillMissingMeta writes prompt details onto a record that arrived without
// them.
//
// A captured image carries its prompt inside the PNG, which is where all of
// this normally comes from. An image generated through the API should too -
// but if it ever arrives without, the app already knows exactly what it
// asked for, and using that beats filing away a picture with no prompt that
// search can never find again.
func (s *Store) FillMissingMeta(id, prompt, negative, model string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	r := s.byID[id]
	if r == nil {
		return
	}
	changed := false
	if r.Meta.Prompt == "" && prompt != "" {
		r.Meta.Prompt = prompt
		changed = true
	}
	if r.Meta.NegativePrompt == "" && negative != "" {
		r.Meta.NegativePrompt = negative
		changed = true
	}
	if r.Meta.Model == "" && model != "" {
		r.Meta.Model = model
		changed = true
	}
	if !changed {
		return
	}
	// The search text is memoised per record, so it has to be invalidated
	// or the new prompt would never be found.
	r.searchCache = ""
	r.searchGen = 0
	r.NSFWAuto = classifyNSFW(r.Meta)
	s.saveIndex()
}

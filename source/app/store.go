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

	// Lowercased searchable text, built on demand and never serialised.
	searchCache string
}

type Folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
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
	// InterceptDownloads: when saving an image on NovelAI, keep it here
	// instead of letting the browser write a file.
	InterceptDownloads bool `json:"interceptDownloads"`
}

func defaultSettings() Settings {
	return Settings{
		Theme:         "midnight",
		CardSize:      190,
		InspectorOpen: true,
		// 'generated' -> only images from a new generation (default)
		// 'all'       -> also import the existing NovelAI history backlog
		// 'download'  -> only when you save/download on NovelAI
		CaptureMode: "generated",
		Onboarded:   false,
		Layout:      "grid",
		Sort:        "newest",
		MetaView:    "tags",
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
		dir:       dir,
		imagesDir: filepath.Join(dir, "images"),
		byID:      map[string]*Record{},
		byHash:    map[string]*Record{},
		settings:  defaultSettings(),
	}
	if err := os.MkdirAll(s.imagesDir, 0o755); err != nil {
		return nil, err
	}

	s.loadJSON(s.indexPath(), &s.records)
	s.loadJSON(s.foldersPath(), &s.folders)
	s.loadJSON(s.settingsPath(), &s.settings)

	for _, r := range s.records {
		if r == nil {
			continue
		}
		s.byID[r.ID] = r
		s.byHash[r.Hash] = r
	}
	return s, nil
}

func (s *Store) indexPath() string    { return filepath.Join(s.dir, "index.json") }
func (s *Store) foldersPath() string  { return filepath.Join(s.dir, "folders.json") }
func (s *Store) settingsPath() string { return filepath.Join(s.dir, "settings.json") }

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
	s.records = append(s.records, r)
	s.byID[id] = r
	s.byHash[hash] = r
	s.saveIndex()
	return r, nil
}

type Patch struct {
	Favorite *bool     `json:"favorite"`
	Pinned   *bool     `json:"pinned"`
	Folders  *[]string `json:"folders"`
	Notes    *string   `json:"notes"`
}

func (s *Store) Update(id string, p Patch) *Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.byID[id]
	if r == nil {
		return nil
	}
	if p.Favorite != nil {
		r.Favorite = *p.Favorite
	}
	if p.Pinned != nil {
		r.Pinned = *p.Pinned
	}
	if p.Folders != nil {
		r.Folders = *p.Folders
	}
	if p.Notes != nil {
		r.Notes = *p.Notes
		r.searchCache = "" // notes are searchable, so the cache is stale
	}
	s.saveIndex()
	return r
}

func (s *Store) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.byID[id]
	if r == nil {
		return false
	}
	out := s.records[:0]
	for _, x := range s.records {
		if x.ID != id {
			out = append(out, x)
		}
	}
	s.records = out
	delete(s.byID, id)
	delete(s.byHash, r.Hash)
	os.Remove(filepath.Join(s.imagesDir, r.Filename))
	s.saveIndex()
	return true
}

// BulkOp applies one change to many images in a single pass, so a
// hundred-image selection costs one index write instead of a hundred.
type BulkOp struct {
	IDs           []string `json:"ids"`
	Favorite      *bool    `json:"favorite"`
	Pinned        *bool    `json:"pinned"`
	AddFolders    []string `json:"addFolders"`
	RemoveFolders []string `json:"removeFolders"`
}

func (s *Store) BulkUpdate(op BulkOp) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	changed := 0
	for _, id := range op.IDs {
		r := s.byID[id]
		if r == nil {
			continue
		}
		if op.Favorite != nil {
			r.Favorite = *op.Favorite
		}
		if op.Pinned != nil {
			r.Pinned = *op.Pinned
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
		changed++
	}
	if changed > 0 {
		s.saveIndex()
	}
	return changed
}

func (s *Store) BulkDelete(ids []string) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	drop := make(map[string]bool, len(ids))
	for _, id := range ids {
		drop[id] = true
	}

	deleted := 0
	out := s.records[:0]
	for _, r := range s.records {
		if r == nil {
			continue
		}
		if !drop[r.ID] {
			out = append(out, r)
			continue
		}
		delete(s.byID, r.ID)
		delete(s.byHash, r.Hash)
		os.Remove(filepath.Join(s.imagesDir, r.Filename))
		deleted++
	}
	s.records = out
	if deleted > 0 {
		s.saveIndex()
	}
	return deleted
}

// ClearAll empties the library: every image file is removed along with its
// record. Folders and settings survive deliberately - the user asked to
// clear their images, not to reset the app.
func (s *Store) ClearAll() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	n := 0
	for _, r := range s.records {
		if r == nil {
			continue
		}
		os.Remove(filepath.Join(s.imagesDir, r.Filename))
		n++
	}
	s.records = nil
	s.byID = map[string]*Record{}
	s.byHash = map[string]*Record{}
	s.saveIndex()
	return n
}

type ListOpts struct {
	Query    string
	Favorite bool
	Pinned   bool
	Folder   string
	Sort     string
	Limit    int
	Offset   int
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

func buildSearchText(r *Record) string {
	parts := []string{
		r.Meta.Prompt, r.Meta.NegativePrompt, r.Meta.Model, r.Meta.Sampler,
		anyToString(r.Meta.Seed), r.Notes, r.Filename,
	}
	if r.Meta.Comment != nil {
		var captions []string
		collectCaptions(r.Meta.Comment, 0, &captions)
		parts = append(parts, captions...)
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

// searchText memoises the above: a library of a few thousand images would
// otherwise rebuild every haystack on every keystroke.
func searchText(r *Record) string {
	if r.searchCache == "" {
		r.searchCache = buildSearchText(r)
	}
	return r.searchCache
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
	s.mu.RLock()
	defer s.mu.RUnlock()

	var out []*Record
	q := strings.ToLower(strings.TrimSpace(o.Query))

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
		if o.Folder != "" {
			found := false
			for _, f := range r.Folders {
				if f == o.Folder {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if q != "" && !strings.Contains(searchText(r), q) {
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

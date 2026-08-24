package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Generated images that haven't been kept yet.
//
// Generating no longer files things away automatically. An image lands
// here first, is shown on the Generate page, and only joins the library if
// you say so - which is the difference between a gallery and a dumping
// ground.
//
// They are written to disk rather than held in the page, because a browser
// tab holding a dozen multi-megabyte data URLs is how a window starts
// stuttering, and because switching tabs must not lose your last hour.
// They are swept at startup: an unkept image is by definition one nobody
// decided to keep.

type Pending struct {
	ID        string `json:"id"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Bytes     int    `json:"bytes"`
	Prompt    string `json:"prompt"`
	Negative  string `json:"negative"`
	Model     string `json:"model"`
	Seed      string `json:"seed"`
	CreatedAt string `json:"createdAt"`
	// SavedID is the gallery record this became, empty until it is kept.
	SavedID string `json:"savedId"`
}

type pendingStore struct {
	mu    sync.RWMutex
	dir   string
	items []*Pending
	byID  map[string]*Pending
}

func newPendingStore(dataDir string) *pendingStore {
	p := &pendingStore{
		dir:  filepath.Join(dataDir, "generated"),
		byID: map[string]*Pending{},
	}
	// Anything left from last time was never kept, so it goes.
	os.RemoveAll(p.dir)
	os.MkdirAll(p.dir, 0o755)
	return p
}

func (p *pendingStore) path(id string) string {
	return filepath.Join(p.dir, id+".png")
}

func (p *pendingStore) Add(png []byte, meta Pending) (*Pending, error) {
	id := newID()
	if err := os.WriteFile(p.path(id), png, 0o644); err != nil {
		return nil, err
	}

	meta.ID = id
	meta.Bytes = len(png)
	meta.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if m := extractMetadata(png); m.Width > 0 {
		meta.Width, meta.Height = m.Width, m.Height
		// NovelAI stamps the seed it actually used into the PNG, which is
		// the only way to learn it when one wasn't asked for.
		if s := anyToString(m.Seed); s != "" {
			meta.Seed = s
		}
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	// Newest first, matching the order they are shown in.
	p.items = append([]*Pending{&meta}, p.items...)
	p.byID[id] = &meta
	return &meta, nil
}

func (p *pendingStore) List() []*Pending {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]*Pending, len(p.items))
	copy(out, p.items)
	return out
}

func (p *pendingStore) Get(id string) *Pending {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.byID[id]
}

func (p *pendingStore) Read(id string) ([]byte, error) {
	if p.Get(id) == nil {
		return nil, fmt.Errorf("no such image")
	}
	return os.ReadFile(p.path(id))
}

// MarkSaved records which gallery record a generation became, so the strip
// can show that it is already in the library rather than offering to keep
// it twice.
func (p *pendingStore) MarkSaved(id, recordID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if it := p.byID[id]; it != nil {
		it.SavedID = recordID
	}
}

// Discard removes one from the strip. The file goes with it: it was never
// in the library, so there is nothing to undo back to.
func (p *pendingStore) Discard(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.byID[id] == nil {
		return false
	}
	delete(p.byID, id)
	for i, it := range p.items {
		if it.ID == id {
			p.items = append(p.items[:i], p.items[i+1:]...)
			break
		}
	}
	os.Remove(p.path(id))
	return true
}

func (p *pendingStore) Clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.items = nil
	p.byID = map[string]*Pending{}
	os.RemoveAll(p.dir)
	os.MkdirAll(p.dir, 0o755)
}

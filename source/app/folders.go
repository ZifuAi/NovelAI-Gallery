package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Folders form a tree. Each one knows its parent and its position among
// its siblings, which is enough to render, reorder and re-parent without
// storing the shape of the tree anywhere else.
//
// Tags are plain strings on a folder; colours live in one map keyed by tag
// name, so renaming a colour in one place changes it everywhere the tag is
// used rather than leaving folders disagreeing about what "wip" looks
// like.

// FolderNode is a folder plus the things the UI needs but shouldn't have
// to work out for itself.
type FolderNode struct {
	*Folder
	Depth int `json:"depth"`
	Count int `json:"count"` // images in this folder and below
}

func (s *Store) folderByID(id string) *Folder {
	for _, f := range s.folders {
		if f.ID == id {
			return f
		}
	}
	return nil
}

func (s *Store) childrenOf(parent string) []*Folder {
	var out []*Folder
	for _, f := range s.folders {
		if f.ParentID == parent {
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// descendants returns a folder and everything nested under it. Filtering
// the gallery by a folder includes its subfolders, which is the whole
// point of being able to nest them.
func (s *Store) descendants(id string) map[string]bool {
	out := map[string]bool{id: true}
	for {
		grew := false
		for _, f := range s.folders {
			if f.ParentID != "" && out[f.ParentID] && !out[f.ID] {
				out[f.ID] = true
				grew = true
			}
		}
		if !grew {
			return out
		}
	}
}

// wouldCycle reports whether moving `id` under `parent` would make the
// tree eat itself.
func (s *Store) wouldCycle(id, parent string) bool {
	if parent == "" {
		return false
	}
	if id == parent {
		return true
	}
	return s.descendants(id)[parent]
}

// FolderTree is the sidebar's view of the world: depth-first, in display
// order, with a running image count per folder.
func (s *Store) FolderTree() []FolderNode {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Direct membership first, then roll subfolder counts upward.
	direct := map[string]int{}
	for _, r := range s.records {
		if r == nil {
			continue
		}
		for _, id := range r.Folders {
			direct[id]++
		}
	}

	var out []FolderNode
	var walk func(parent string, depth int)
	walk = func(parent string, depth int) {
		for _, f := range s.childrenOf(parent) {
			count := 0
			for id := range s.descendants(f.ID) {
				count += direct[id]
			}
			out = append(out, FolderNode{Folder: f, Depth: depth, Count: count})
			walk(f.ID, depth+1)
		}
	}
	walk("", 0)

	if out == nil {
		out = []FolderNode{}
	}
	return out
}

func (s *Store) nextOrder(parent string) int {
	max := -1
	for _, f := range s.folders {
		if f.ParentID == parent && f.Order > max {
			max = f.Order
		}
	}
	return max + 1
}

// FolderProps is what a folder passes on: its name, its text tags, the
// colour label its images take, and whether they count as NSFW. Every
// field is a pointer so "leave this alone" is distinct from "set it to
// nothing" - clearing a colour and not mentioning it are different asks.
type FolderProps struct {
	Name  *string   `json:"name"`
	Tags  *[]string `json:"tags"`
	Color *string   `json:"color"`
	NSFW  *bool     `json:"nsfw"`
}

// SetFolderProps updates a folder and passes the inherited parts on to the
// images filed directly in it. It returns how many images changed.
//
// Direct members only, not the whole subtree: a subfolder has properties of
// its own, and quietly overwriting them from a parent would lose a choice
// somebody made deliberately.
func (s *Store) SetFolderProps(id string, p FolderProps) (int, error) {
	if p.Name != nil {
		if err := s.RenameFolder(id, *p.Name); err != nil {
			return 0, err
		}
	}
	if p.Tags != nil {
		if err := s.SetFolderTags(id, *p.Tags); err != nil {
			return 0, err
		}
	}

	s.mu.Lock()
	f := s.folderByID(id)
	if f == nil {
		s.mu.Unlock()
		return 0, fmt.Errorf("No such folder")
	}
	if p.Color != nil {
		f.Color = strings.TrimSpace(*p.Color)
	}
	if p.NSFW != nil {
		f.NSFW = *p.NSFW
	}
	if p.Color != nil || p.NSFW != nil {
		s.folderGen++
		s.saveFolders()
	}
	color, nsfw := f.Color, f.NSFW
	s.mu.Unlock()

	if p.Color == nil && p.NSFW == nil {
		return 0, nil
	}
	return s.applyFolderProps(id, color, nsfw, p.Color != nil, p.NSFW != nil), nil
}

// applyFolderProps writes a folder's inherited properties onto the images
// filed directly in it. It goes through BulkUpdate, so it lands in the undo
// history as one step - the same as doing it by hand would.
func (s *Store) applyFolderProps(id, color string, nsfw, setColor, setNSFW bool) int {
	s.mu.Lock()
	ids := []string{}
	for _, r := range s.records {
		if r == nil {
			continue
		}
		for _, fid := range r.Folders {
			if fid == id {
				ids = append(ids, r.ID)
				break
			}
		}
	}
	s.mu.Unlock()
	if len(ids) == 0 {
		return 0
	}

	op := BulkOp{IDs: ids}
	if setColor {
		c := color
		op.Color = &c
	}
	// Only ever marks. Clearing a folder's flag leaves what is inside
	// marked rather than declaring a pile of pictures safe on the strength
	// of a checkbox - that is the mistake you cannot spot by looking.
	if setNSFW && nsfw {
		v := true
		op.NSFW = &v
	}
	if op.Color == nil && op.NSFW == nil {
		return 0
	}
	return s.BulkUpdate(op)
}

// InheritFolderProps applies a folder's colour and NSFW flag to images that
// have just been filed into it, so a folder's rules hold for what arrives
// later as well as for what was there when they were set.
func (s *Store) InheritFolderProps(folderID string, ids []string) int {
	s.mu.Lock()
	f := s.folderByID(folderID)
	if f == nil {
		s.mu.Unlock()
		return 0
	}
	color, nsfw := f.Color, f.NSFW
	s.mu.Unlock()

	if color == "" && !nsfw {
		return 0
	}
	op := BulkOp{IDs: ids}
	if color != "" {
		c := color
		op.Color = &c
	}
	if nsfw {
		v := true
		op.NSFW = &v
	}
	return s.BulkUpdate(op)
}

func (s *Store) CreateFolderIn(name, parent string) (*Folder, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("Folder name required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if parent != "" && s.folderByID(parent) == nil {
		return nil, fmt.Errorf("No such parent folder")
	}
	// Names only have to be unique among siblings - "sketches" inside two
	// different projects is a reasonable thing to want.
	for _, f := range s.childrenOf(parent) {
		if strings.EqualFold(f.Name, name) {
			return nil, fmt.Errorf("A folder called %q is already here", name)
		}
	}

	f := &Folder{
		ID:        newID(),
		Name:      name,
		ParentID:  parent,
		Order:     s.nextOrder(parent),
		Tags:      []string{},
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	s.folders = append(s.folders, f)
	s.folderGen++
	s.saveFolders()

	id := f.ID
	s.pushUndo(undoEntry{
		label: "New folder",
		undo:  func() { s.removeFolderTree(id) },
		redo:  func() { s.folders = append(s.folders, f); s.folderGen++ },
	})
	return f, nil
}

func (s *Store) RenameFolder(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("Folder name required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	f := s.folderByID(id)
	if f == nil {
		return fmt.Errorf("No such folder")
	}
	for _, sib := range s.childrenOf(f.ParentID) {
		if sib.ID != id && strings.EqualFold(sib.Name, name) {
			return fmt.Errorf("A folder called %q is already here", name)
		}
	}

	was := f.Name
	f.Name = name
	s.folderGen++
	s.saveFolders()
	s.pushUndo(undoEntry{
		label: "Rename folder",
		undo:  func() { setFolderName(s.folderByID(id), was); s.folderGen++ },
		redo:  func() { setFolderName(s.folderByID(id), name); s.folderGen++ },
	})
	return nil
}

func setFolderName(f *Folder, name string) {
	if f != nil {
		f.Name = name
	}
}

// MoveFolder re-parents a folder and/or changes its position among its
// siblings. index < 0 means "put it last".
func (s *Store) MoveFolder(id, parent string, index int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	f := s.folderByID(id)
	if f == nil {
		return fmt.Errorf("No such folder")
	}
	if parent != "" && s.folderByID(parent) == nil {
		return fmt.Errorf("No such parent folder")
	}
	if s.wouldCycle(id, parent) {
		return fmt.Errorf("A folder can't be moved inside itself")
	}
	for _, sib := range s.childrenOf(parent) {
		if sib.ID != id && strings.EqualFold(sib.Name, f.Name) {
			return fmt.Errorf("A folder called %q is already there", f.Name)
		}
	}

	before := s.snapshotOrder()
	f.ParentID = parent
	s.reorderSibling(f, index)
	s.folderGen++
	s.saveFolders()

	after := s.snapshotOrder()
	s.pushUndo(undoEntry{
		label: "Move folder",
		undo:  func() { s.applyOrder(before); s.folderGen++ },
		redo:  func() { s.applyOrder(after); s.folderGen++ },
	})
	return nil
}

// reorderSibling drops f into position `index` among its new siblings and
// renumbers the row so the ordering stays dense.
func (s *Store) reorderSibling(f *Folder, index int) {
	sibs := s.childrenOf(f.ParentID)
	rest := make([]*Folder, 0, len(sibs))
	for _, sib := range sibs {
		if sib.ID != f.ID {
			rest = append(rest, sib)
		}
	}
	if index < 0 || index > len(rest) {
		index = len(rest)
	}
	rest = append(rest, nil)
	copy(rest[index+1:], rest[index:])
	rest[index] = f
	for i, sib := range rest {
		sib.Order = i
	}
}

type folderPlacement struct {
	id     string
	parent string
	order  int
}

func (s *Store) snapshotOrder() []folderPlacement {
	out := make([]folderPlacement, 0, len(s.folders))
	for _, f := range s.folders {
		out = append(out, folderPlacement{f.ID, f.ParentID, f.Order})
	}
	return out
}

func (s *Store) applyOrder(snap []folderPlacement) {
	for _, p := range snap {
		if f := s.folderByID(p.id); f != nil {
			f.ParentID = p.parent
			f.Order = p.order
		}
	}
}

func (s *Store) SetFolderTags(id string, tags []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	f := s.folderByID(id)
	if f == nil {
		return fmt.Errorf("No such folder")
	}

	clean := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		seen[strings.ToLower(t)] = true
		clean = append(clean, t)
	}

	was := append([]string(nil), f.Tags...)
	f.Tags = clean
	s.folderGen++
	s.saveFolders()
	s.pushUndo(undoEntry{
		label: "Change folder tags",
		undo:  func() { setFolderTags(s.folderByID(id), was); s.folderGen++ },
		redo:  func() { setFolderTags(s.folderByID(id), clean); s.folderGen++ },
	})
	return nil
}

func setFolderTags(f *Folder, tags []string) {
	if f != nil {
		f.Tags = append([]string(nil), tags...)
	}
}

// SetColorLabelName gives a palette colour a name, so a swatch can mean
// "needs work" rather than just "red" - and be searchable as that.
func (s *Store) SetColorLabelName(color, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := strings.ToLower(strings.TrimSpace(color))
	if key == "" {
		return
	}
	if s.colorNames == nil {
		s.colorNames = map[string]string{}
	}
	name = strings.TrimSpace(name)
	if name == "" {
		delete(s.colorNames, key)
	} else {
		s.colorNames[key] = name
	}
	s.folderGen++ // the names are searchable, so cached text is stale
	s.saveTags()
}

func (s *Store) ColorLabels() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]string{}
	for k, v := range s.colorNames {
		out[k] = v
	}
	return out
}

// ColorCounts reports how many images carry each colour label, so the
// filter can hide colours nothing uses.
func (s *Store) ColorCounts() map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]int{}
	for _, r := range s.records {
		if r != nil && r.Color != "" {
			out[strings.ToLower(r.Color)]++
		}
	}
	return out
}

// TagsInUse lists every tag on every folder and how many folders carry
// it. Folder tags are plain words - they're for searching and grouping;
// colour labels are a separate thing that lives on images.
type TagInfo struct {
	Name    string `json:"name"`
	Folders int    `json:"folders"`
}

func (s *Store) TagsInUse() []TagInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	byKey := map[string]*TagInfo{}
	var order []string
	for _, f := range s.folders {
		for _, t := range f.Tags {
			key := strings.ToLower(t)
			if byKey[key] == nil {
				byKey[key] = &TagInfo{Name: t}
				order = append(order, key)
			}
			byKey[key].Folders++
		}
	}
	sort.Strings(order)
	out := make([]TagInfo, 0, len(order))
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	return out
}

// removeFolderTree deletes a folder and everything under it, and takes
// those folders off every image. Caller holds the lock.
func (s *Store) removeFolderTree(id string) []string {
	doomed := s.descendants(id)

	out := s.folders[:0]
	for _, f := range s.folders {
		if !doomed[f.ID] {
			out = append(out, f)
		}
	}
	s.folders = out

	var touched []string
	for _, r := range s.records {
		if r == nil {
			continue
		}
		kept := r.Folders[:0]
		changed := false
		for _, fid := range r.Folders {
			if doomed[fid] {
				changed = true
				continue
			}
			kept = append(kept, fid)
		}
		if changed {
			r.Folders = kept
			r.searchCache = ""
			touched = append(touched, r.ID)
		}
	}
	s.folderGen++
	return touched
}

func (s *Store) DeleteFolderTree(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.folderByID(id) == nil {
		return false
	}

	doomed := s.descendants(id)
	removed := make([]*Folder, 0, len(doomed))
	for _, f := range s.folders {
		if doomed[f.ID] {
			removed = append(removed, f)
		}
	}
	// Which images were in which folder, so undo can put them back.
	membership := map[string][]string{}
	for _, r := range s.records {
		if r == nil {
			continue
		}
		for _, fid := range r.Folders {
			if doomed[fid] {
				membership[r.ID] = append(membership[r.ID], fid)
			}
		}
	}

	s.removeFolderTree(id)
	s.saveAll()

	label := "Delete folder"
	if len(removed) > 1 {
		label = fmt.Sprintf("Delete folder (%d folders)", len(removed))
	}
	s.pushUndo(undoEntry{
		label: label,
		undo: func() {
			s.folders = append(s.folders, removed...)
			for rid, fids := range membership {
				if r := s.byID[rid]; r != nil {
					r.Folders = append(r.Folders, fids...)
					r.searchCache = ""
				}
			}
			s.folderGen++
		},
		redo: func() { s.removeFolderTree(id) },
	})
	return true
}

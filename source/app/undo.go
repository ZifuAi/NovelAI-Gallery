package main

import (
	"os"
	"path/filepath"
)

// Undo / redo.
//
// Every mutation that a person could plausibly regret records how to
// reverse itself. The entries are closures rather than serialised diffs:
// the store is small enough to hold the "before" state directly, and a
// closure can't drift out of step with the operation it belongs to the way
// a separate replay format can.
//
// The stack lives in memory only. Undoing across restarts sounds nice but
// would mean keeping every deleted image forever, and a history that
// silently expires is worse than one that visibly starts fresh.
//
// Deletes are the reason this needs care. An undoable delete cannot throw
// the bytes away, so files move to a trash folder instead and are removed
// for real only when the entry falls off the end of the stack. Everything
// in the trash at startup is unreachable - the stack that referenced it is
// gone - so it is swept then.

const undoDepth = 50

type undoEntry struct {
	label string
	// Both run with the store lock already held.
	undo func()
	redo func()
	// Called when the entry is discarded: the last chance to release
	// anything it was keeping alive, such as trashed image files.
	discard func()
}

// pushUndo records an operation and drops the redo history, which is what
// every editor does - once you take a new action, the branch you undid is
// no longer reachable.
func (s *Store) pushUndo(e undoEntry) {
	s.undoStack = append(s.undoStack, e)
	for len(s.undoStack) > undoDepth {
		if d := s.undoStack[0].discard; d != nil {
			d()
		}
		s.undoStack = s.undoStack[1:]
	}
	for _, r := range s.redoStack {
		if r.discard != nil {
			r.discard()
		}
	}
	s.redoStack = nil
}

func (s *Store) Undo() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.undoStack) == 0 {
		return "", false
	}
	e := s.undoStack[len(s.undoStack)-1]
	s.undoStack = s.undoStack[:len(s.undoStack)-1]
	e.undo()
	s.redoStack = append(s.redoStack, e)
	s.saveAll()
	return e.label, true
}

func (s *Store) Redo() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.redoStack) == 0 {
		return "", false
	}
	e := s.redoStack[len(s.redoStack)-1]
	s.redoStack = s.redoStack[:len(s.redoStack)-1]
	e.redo()
	s.undoStack = append(s.undoStack, e)
	s.saveAll()
	return e.label, true
}

type UndoState struct {
	CanUndo   bool   `json:"canUndo"`
	CanRedo   bool   `json:"canRedo"`
	UndoLabel string `json:"undoLabel"`
	RedoLabel string `json:"redoLabel"`
}

func (s *Store) UndoState() UndoState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	st := UndoState{CanUndo: len(s.undoStack) > 0, CanRedo: len(s.redoStack) > 0}
	if st.CanUndo {
		st.UndoLabel = s.undoStack[len(s.undoStack)-1].label
	}
	if st.CanRedo {
		st.RedoLabel = s.redoStack[len(s.redoStack)-1].label
	}
	return st
}

func (s *Store) saveAll() {
	s.saveIndex()
	s.saveFolders()
}

// --- the trash ---------------------------------------------------------

func (s *Store) trashPath(filename string) string {
	return filepath.Join(s.dir, "trash", filename)
}

// trashFile moves an image out of the library without destroying it, so a
// delete can still be undone.
func (s *Store) trashFile(filename string) {
	os.MkdirAll(filepath.Join(s.dir, "trash"), 0o755)
	os.Rename(filepath.Join(s.imagesDir, filename), s.trashPath(filename))
}

func (s *Store) restoreFile(filename string) {
	os.Rename(s.trashPath(filename), filepath.Join(s.imagesDir, filename))
}

func (s *Store) purgeTrashed(filenames ...string) {
	for _, f := range filenames {
		os.Remove(s.trashPath(f))
	}
}

// sweepTrash empties the trash at startup. Nothing there can be undone any
// more, because the stack that knew about it did not survive the restart.
func (s *Store) sweepTrash() {
	os.RemoveAll(filepath.Join(s.dir, "trash"))
}

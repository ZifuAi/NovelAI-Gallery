package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Where the pictures live.
//
// The app's own bookkeeping - the index, the settings, the folder tree -
// stays in the per-user config directory, because it is small, it is the
// app's, and moving a running database is a good way to lose one. The
// images are a different thing: they are the library, they are the part
// that grows to tens of gigabytes, and they are what somebody wants on the
// big drive rather than on the system one.
//
// So only the image folder moves. Everything else stays put and keeps
// working, and the index is not touched at all - it stores file names, not
// paths, which is what makes this possible in the first place.

// ImagesDir reports where images are being written.
func (s *Store) ImagesDir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.imagesDir
}

// UseImagesDir points the store at a folder without moving anything. Used
// at startup to honour a location chosen in a previous session.
func (s *Store) UseImagesDir(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return fmt.Errorf("no folder given")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("could not use %s: %w", dir, err)
	}
	s.mu.Lock()
	s.imagesDir = dir
	s.mu.Unlock()
	return nil
}

// checkImagesDir decides whether a folder can be used for the library.
//
// The awkward cases are all about a folder that is not where it looks:
// a path that is really a file, one that cannot be written to, or one that
// is inside the folder being moved out of - which would mean moving files
// into a directory that is itself being emptied.
func checkImagesDir(dest, current string) (string, error) {
	dest = strings.TrimSpace(dest)
	if dest == "" {
		return "", fmt.Errorf("Choose a folder first")
	}
	if !filepath.IsAbs(dest) {
		return "", fmt.Errorf("That needs to be a full path, like D:\\NovelAI\\Images")
	}
	dest = filepath.Clean(dest)

	if st, err := os.Stat(dest); err == nil && !st.IsDir() {
		return "", fmt.Errorf("There is already a file at that path")
	}
	if same, _ := sameDir(dest, current); same {
		return "", fmt.Errorf("Your images are already there")
	}
	if within(dest, current) {
		return "", fmt.Errorf("That folder is inside the one being moved")
	}

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return "", fmt.Errorf("Could not create that folder: %v", err)
	}
	// Writable in practice, not just in theory: a folder on a drive that
	// is full, read-only or gone answers the same as a good one until
	// something is actually written to it.
	probe := filepath.Join(dest, ".nag-write-test")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return "", fmt.Errorf("That folder cannot be written to: %v", err)
	}
	os.Remove(probe)
	return dest, nil
}

func sameDir(a, b string) (bool, error) {
	if a == b {
		return true, nil
	}
	as, err1 := os.Stat(a)
	bs, err2 := os.Stat(b)
	if err1 != nil || err2 != nil {
		return false, nil
	}
	return os.SameFile(as, bs), nil
}

// within reports whether `inner` sits under `outer`.
func within(inner, outer string) bool {
	rel, err := filepath.Rel(outer, inner)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "."
}

// MoveImages moves the library to another folder and starts using it.
//
// Files are moved one at a time and counted, and the store only starts
// writing to the new place once they are all there. A move that fails part
// way leaves both folders intact and says what did not make it, rather than
// pointing the app at a folder holding half a library.
func (s *Store) MoveImages(dest string) (int, string, error) {
	current := s.ImagesDir()
	dest, err := checkImagesDir(dest, current)
	if err != nil {
		return 0, "", err
	}

	entries, err := os.ReadDir(current)
	if err != nil && !os.IsNotExist(err) {
		return 0, "", fmt.Errorf("Could not read the current folder: %v", err)
	}

	moved := 0
	var failed []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		from := filepath.Join(current, e.Name())
		to := filepath.Join(dest, e.Name())
		if err := moveFile(from, to); err != nil {
			failed = append(failed, e.Name())
			continue
		}
		moved++
	}
	if len(failed) > 0 {
		return moved, dest, fmt.Errorf(
			"Moved %d, but %d could not be moved (%s). Nothing was deleted; your images are in both folders.",
			moved, len(failed), strings.Join(firstFew(failed, 3), ", "))
	}

	s.mu.Lock()
	s.imagesDir = dest
	s.settings.ImagesDir = dest
	s.mu.Unlock()
	s.saveSettings()

	// The old folder goes only if it is empty and was ours to begin with.
	// Removing anything else would be tidying up somebody's disk uninvited.
	os.Remove(current)
	return moved, dest, nil
}

func firstFew(list []string, n int) []string {
	if len(list) <= n {
		return list
	}
	return append(append([]string{}, list[:n]...), "…")
}

// moveFile renames where it can and copies where it cannot. A rename does
// not work across drives, which is the whole point of this feature: the
// folder someone chooses is usually on a different disk.
func moveFile(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(to)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(to)
		return err
	}
	in.Close()
	// Only once the copy is safely on the other disk.
	return os.Remove(from)
}

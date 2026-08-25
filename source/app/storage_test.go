package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Moving the library is moving real files. What matters is that they all
// arrive, that the app then writes to the new place, and that a refusal
// leaves everything where it was.
func TestMoveImagesTakesEverythingWithIt(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "store"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.png", "b.png", "c.png"} {
		if err := os.WriteFile(filepath.Join(s.ImagesDir(), name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	dest := filepath.Join(dir, "elsewhere", "images")
	moved, at, err := s.MoveImages(dest)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 3 {
		t.Errorf("moved %d files, want 3", moved)
	}
	if at != dest || s.ImagesDir() != dest {
		t.Fatalf("images dir = %q, want %q", s.ImagesDir(), dest)
	}
	for _, name := range []string{"a.png", "b.png", "c.png"} {
		if _, err := os.Stat(filepath.Join(dest, name)); err != nil {
			t.Errorf("%s did not arrive: %v", name, err)
		}
	}
	// And it is remembered, or the next launch would look in the old place.
	if s.Settings().ImagesDir != dest {
		t.Errorf("settings hold %q, want %q", s.Settings().ImagesDir, dest)
	}
}

func TestMoveImagesRefusesImpossiblePlaces(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "store"))
	if err != nil {
		t.Fatal(err)
	}
	before := s.ImagesDir()

	file := filepath.Join(dir, "a-file")
	os.WriteFile(file, []byte("x"), 0o644)

	for _, c := range []struct{ name, dest string }{
		{"a file, not a folder", file},
		{"nothing at all", ""},
		{"a relative path", "images/here"},
		{"where they already are", before},
		{"inside the folder being moved", filepath.Join(before, "nested")},
	} {
		if _, _, err := s.MoveImages(c.dest); err == nil {
			t.Errorf("%s was accepted", c.name)
		}
	}
	if s.ImagesDir() != before {
		t.Errorf("a refused move changed the folder to %q", s.ImagesDir())
	}
}

// The settings screen must not be able to write this field: it holds
// whatever it was given at load, and saving a form would otherwise point
// the app at a folder nothing was moved to.
func TestSavingSettingsCannotRelocateTheLibrary(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "store"))
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "chosen")
	if _, _, err := s.MoveImages(dest); err != nil {
		t.Fatal(err)
	}

	in := s.Settings()
	in.ImagesDir = filepath.Join(dir, "somewhere-else")
	out := s.UpdateSettings(in)
	if out.ImagesDir != dest {
		t.Errorf("settings moved the library to %q on their own", out.ImagesDir)
	}
	if s.ImagesDir() != dest {
		t.Errorf("the store followed it to %q", s.ImagesDir())
	}
}

// A saved location is picked up at the next launch.
func TestSavedLocationIsUsedOnStartup(t *testing.T) {
	dir := t.TempDir()
	storeDir := filepath.Join(dir, "store")
	s, err := NewStore(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "chosen")
	if _, _, err := s.MoveImages(dest); err != nil {
		t.Fatal(err)
	}

	again, err := NewStore(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.Settings().ImagesDir; got != dest {
		t.Fatalf("the location was not remembered: %q", got)
	}
	if err := again.UseImagesDir(again.Settings().ImagesDir); err != nil {
		t.Fatal(err)
	}
	if again.ImagesDir() != dest {
		t.Errorf("images dir = %q, want %q", again.ImagesDir(), dest)
	}
}

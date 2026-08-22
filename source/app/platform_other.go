//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Non-Windows stubs. The shipped product is Windows-only; these exist so
// the same code can be built and exercised on Linux during development.

type BrowserInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

func detectBrowsers() []BrowserInfo {
	var found []BrowserInfo
	for _, c := range []struct{ id, name, bin string }{
		{"brave", "Brave", "brave-browser"},
		{"chrome", "Chrome", "google-chrome"},
		{"chromium", "Chromium", "chromium"},
	} {
		if p, err := exec.LookPath(c.bin); err == nil {
			found = append(found, BrowserInfo{ID: c.id, Name: c.name, Path: p})
		}
	}
	return found
}

func revealInFileManager(path string) error {
	if _, err := exec.LookPath("xdg-open"); err != nil {
		return fmt.Errorf("no file manager available")
	}
	return exec.Command("xdg-open", path).Start()
}

// revealFile is Windows' "show the file in Explorer, selected". Elsewhere
// the best equivalent is opening the folder that holds it.
func revealFile(path string) error {
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("that image file is missing from disk")
	}
	return revealInFileManager(filepath.Dir(path))
}

func launchBrowserWithExtension(browserID, extDir string) (bool, error) {
	browsers := detectBrowsers()
	if len(browsers) == 0 {
		return false, fmt.Errorf("no Chromium-based browser found")
	}
	target := browsers[0]
	for _, b := range browsers {
		if b.ID == browserID {
			target = b
			break
		}
	}
	cmd := exec.Command(target.Path, "--load-extension="+extDir, "chrome://extensions")
	if err := cmd.Start(); err != nil {
		return false, err
	}
	return true, nil
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

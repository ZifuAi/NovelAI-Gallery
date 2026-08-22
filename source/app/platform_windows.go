//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Windows-specific helpers for the extension-setup flow.

type BrowserInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// Candidate install locations, most-preferred first. Brave leads because
// that's what this is primarily built for.
var browserCandidates = []struct {
	id, name string
	rel      []string
}{
	{"brave", "Brave", []string{
		`BraveSoftware\Brave-Browser\Application\brave.exe`,
	}},
	{"chrome", "Chrome", []string{
		`Google\Chrome\Application\chrome.exe`,
	}},
	{"edge", "Edge", []string{
		`Microsoft\Edge\Application\msedge.exe`,
	}},
}

func searchRoots() []string {
	var roots []string
	for _, env := range []string{"PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"} {
		if v := os.Getenv(env); v != "" {
			roots = append(roots, v)
		}
	}
	return roots
}

// detectBrowsers returns the Chromium-family browsers actually present, so
// the UI can offer real choices rather than guessing.
func detectBrowsers() []BrowserInfo {
	var found []BrowserInfo
	for _, c := range browserCandidates {
		for _, root := range searchRoots() {
			for _, rel := range c.rel {
				p := filepath.Join(root, rel)
				if st, err := os.Stat(p); err == nil && !st.IsDir() {
					found = append(found, BrowserInfo{ID: c.id, Name: c.name, Path: p})
					goto next
				}
			}
		}
	next:
	}
	return found
}

func extensionsPageFor(id string) string {
	switch id {
	case "brave":
		return "brave://extensions"
	case "edge":
		return "edge://extensions"
	default:
		return "chrome://extensions"
	}
}

// revealInFileManager opens Explorer at the extension folder so the user
// can point "Load unpacked" straight at it.
func revealInFileManager(path string) error {
	cmd := exec.Command("explorer.exe", filepath.Clean(path))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	// Explorer returns a non-zero exit code even on success, so its error
	// is deliberately not treated as a failure.
	_ = cmd.Start()
	return nil
}

// explorerPath finds File Explorer. It is normally on PATH, but the app
// shouldn't depend on that when %WINDIR% says exactly where it lives.
func explorerPath() string {
	if windir := os.Getenv("WINDIR"); windir != "" {
		candidate := filepath.Join(windir, "explorer.exe")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "explorer.exe"
}

// revealFile opens the folder holding a file with that file selected,
// rather than just opening the folder - the point of "open in folder" is
// to land on the picture you were looking at.
//
// The command line is set through SysProcAttr.CmdLine, which Go passes to
// CreateProcess verbatim; see explorerSelectCmdLine for why building it by
// hand is the whole point. Errors are returned rather than swallowed, so a
// failure shows up in the UI instead of a toast claiming success.
func revealFile(path string) error {
	clean := filepath.Clean(path)
	if _, err := os.Stat(clean); err != nil {
		return fmt.Errorf("that image file is missing from disk")
	}

	exe := explorerPath()

	cmd := exec.Command(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: explorerSelectCmdLine(exe, clean)}
	if err := cmd.Start(); err == nil {
		// Explorer hands off to the running shell and exits with a
		// non-zero code even on success, so its exit status says nothing.
		// Reap it in the background rather than leaking the handle.
		go func() { _ = cmd.Wait() }()
		return nil
	}

	// Couldn't launch it at all: settle for opening the folder.
	dir := filepath.Dir(clean)
	fallback := exec.Command(exe)
	fallback.SysProcAttr = &syscall.SysProcAttr{CmdLine: explorerOpenCmdLine(exe, dir)}
	if err := fallback.Start(); err != nil {
		return fmt.Errorf("could not open File Explorer: %v", err)
	}
	go func() { _ = fallback.Wait() }()
	return nil
}

// launchBrowserWithExtension starts the browser on its extensions page.
//
// It also passes --load-extension, which historically side-loads an
// unpacked extension automatically. Recent Chromium builds ignore or
// reject that flag, so the return value only reports that the attempt was
// made - the UI always shows the manual steps as well, rather than
// claiming an install happened that may not have.
func launchBrowserWithExtension(browserID, extDir string) (bool, error) {
	browsers := detectBrowsers()
	if len(browsers) == 0 {
		return false, fmt.Errorf("no Chromium-based browser found on this PC")
	}

	target := browsers[0]
	if browserID != "" {
		for _, b := range browsers {
			if b.ID == browserID {
				target = b
				break
			}
		}
	}

	args := []string{
		"--load-extension=" + filepath.Clean(extDir),
		extensionsPageFor(target.ID),
	}
	cmd := exec.Command(target.Path, args...)
	if err := cmd.Start(); err != nil {
		return false, err
	}
	return true, nil
}

// fatal shows a real message box rather than dying silently, since a GUI
// build has no console for the user to read.
func fatal(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	title, _ := syscall.UTF16PtrFromString(appName)
	text, _ := syscall.UTF16PtrFromString(msg)
	messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
	os.Exit(1)
}

package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

const appVersion = "1.1"
const appName = "NovelAI Tools"

// The folder the library lives in keeps its original name. Renaming it
// would orphan every existing library on disk - the app would start up
// looking at an empty folder while the user's images sat in the old one -
// and there is nothing to gain from moving them.
const dataDirName = "NovelAI Gallery"

//go:embed all:web
var embeddedWeb embed.FS

//go:embed all:extension
var embeddedExtension embed.FS

// webFS exposes the embedded gallery UI at the filesystem root, so
// "/" serves web/index.html.
func webFS() fs.FS {
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		log.Fatal(err)
	}
	return sub
}

func hashOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

type App struct {
	DataDir      string
	ExtensionDir string
}

// dataDir returns a per-user writable location. The installed program
// directory is read-only for a normal user, so nothing may be written
// beside the executable.
func dataDir() string {
	if dir := os.Getenv("NOVELAI_GALLERY_DATA"); dir != "" {
		return dir
	}
	base, err := os.UserConfigDir() // %APPDATA% on Windows
	if err != nil || base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, dataDirName)
}

// unpackExtension writes the bundled extension next to the user's data so
// they have a real folder to point the browser at. Rewritten on every
// launch so an app update always ships a matching extension.
func unpackExtension(dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return fs.WalkDir(embeddedExtension, "extension", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel("extension", p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := embeddedExtension.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

func main() {
	data := dataDir()
	if err := os.MkdirAll(data, 0o755); err != nil {
		fatal("Could not create the data folder:\n" + err.Error())
	}

	app := &App{
		DataDir:      data,
		ExtensionDir: filepath.Join(data, "extension"),
	}

	if err := unpackExtension(app.ExtensionDir); err != nil {
		// Not fatal: the gallery still works, only the one-click extension
		// setup would be unavailable.
		log.Println("could not unpack extension:", err)
	}

	store, err := NewStore(filepath.Join(data, "gallery-storage"))
	if err != nil {
		fatal("Could not open your gallery storage:\n" + err.Error())
	}

	srv := &Server{
		store:   store,
		app:     app,
		updater: NewUpdater(data),
		reuseCh: make(chan string, 1),
	}
	ln, err := srv.Listen()
	if err != nil {
		fatal("Could not start the gallery:\n" + err.Error())
	}

	go func() {
		if err := http.Serve(ln, srv.routes()); err != nil {
			log.Println("serve:", err)
		}
	}()

	// Bring an existing library up to date in the background. New captures
	// get a thumbnail as they arrive; this is for everything from before
	// thumbnails existed. Nothing waits on it - a missing thumbnail is
	// generated on demand anyway, this just means the second scroll through
	// an old library is fast rather than the tenth.
	go store.BackfillThumbs()

	url := fmt.Sprintf("http://127.0.0.1:%d/", srv.port)
	log.Println("gallery running at", url)

	runWindow(url)
}

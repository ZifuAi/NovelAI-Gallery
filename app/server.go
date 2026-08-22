package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The app's local HTTP layer. Bound to 127.0.0.1 only - it exists so the
// browser extension has somewhere to hand images to, and so the WebView
// window has something to load. It is not reachable from the network and
// is not a separate process the user has to run.

const basePort = 8756
const portRange = 8

// ReuseStatus is the outcome the extension reports back after trying to
// hand an image to NovelAI, so the gallery can show what actually
// happened rather than assuming success.
type ReuseStatus struct {
	State   string `json:"state"`   // "delivered" | "no-tab" | "error" | ""
	Message string `json:"message"` // human-readable detail
	ID      string `json:"id"`
	At      int64  `json:"at"`
}

type Server struct {
	store *Store
	app   *App
	port  int

	// Buffered so a Reuse click doesn't block if the extension happens to
	// be between long-polls; capacity 1 because only the most recent
	// request is meaningful.
	reuseCh     chan string
	reuseMu     sync.Mutex
	reuseStatus ReuseStatus
}

func (s *Server) requestReuse(id string) {
	s.reuseMu.Lock()
	s.reuseStatus = ReuseStatus{State: "pending", ID: id, At: time.Now().UnixMilli()}
	s.reuseMu.Unlock()

	// Drop any stale queued request so the newest click wins.
	select {
	case <-s.reuseCh:
	default:
	}
	select {
	case s.reuseCh <- id:
	default:
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// cors keeps the extension's fetches simple. Only localhost can reach this
// listener in the first place, so this is not widening any real surface.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": appVersion})
	})

	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, 200, s.store.Settings())
		case http.MethodPut:
			var in Settings
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			writeJSON(w, 200, s.store.UpdateSettings(in))
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// The window's title bar is the OS's to draw, so the page hands its
	// theme colors over here whenever the theme changes.
	mux.HandleFunc("/api/window/chrome", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		var c WindowChrome
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			writeErr(w, 400, "Invalid JSON")
			return
		}
		applyWindowChrome(c)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	// --- extension setup helpers (called from the UI) ------------------
	mux.HandleFunc("/api/extension/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"path":     s.app.ExtensionDir,
			"browsers": detectBrowsers(),
		})
	})

	mux.HandleFunc("/api/extension/reveal", func(w http.ResponseWriter, r *http.Request) {
		if err := revealInFileManager(s.app.ExtensionDir); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	// Launches the chosen browser straight onto its extensions page, with
	// the unpacked extension pre-loaded where the browser still supports
	// that flag. Falls back to just opening the page.
	mux.HandleFunc("/api/extension/launch", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Browser string `json:"browser"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		loaded, err := launchBrowserWithExtension(body.Browser, s.app.ExtensionDir)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "autoLoaded": loaded})
	})

	// --- "reuse prompt" rendezvous ---------------------------------------
	//
	// The gallery UI can't talk to the browser extension directly, so the
	// app acts as the meeting point. The extension holds a long-poll open
	// on /api/reuse/wait; clicking Reuse in the UI completes it instantly,
	// rather than the extension busy-polling for something that happens
	// once in a while.
	mux.HandleFunc("/api/reuse", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			writeErr(w, 400, "Missing image id")
			return
		}
		if s.store.Get(body.ID) == nil {
			writeErr(w, 404, "No such image")
			return
		}
		s.requestReuse(body.ID)
		writeJSON(w, 202, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/reuse/wait", func(w http.ResponseWriter, r *http.Request) {
		select {
		case id := <-s.reuseCh:
			writeJSON(w, 200, map[string]any{
				"id":  id,
				"url": fmt.Sprintf("http://127.0.0.1:%d/api/images/%s/file", s.port, id),
			})
		case <-r.Context().Done():
			return // client hung up
		case <-time.After(25 * time.Second):
			w.WriteHeader(http.StatusNoContent) // nothing pending; caller re-polls
		}
	})

	// The extension reports back what happened so the UI can say something
	// truthful instead of just "sent".
	mux.HandleFunc("/api/reuse/status", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			s.reuseMu.Lock()
			st := s.reuseStatus
			s.reuseMu.Unlock()
			writeJSON(w, 200, st)
		case http.MethodPost:
			var st ReuseStatus
			if err := json.NewDecoder(r.Body).Decode(&st); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			st.At = time.Now().UnixMilli()
			s.reuseMu.Lock()
			s.reuseStatus = st
			s.reuseMu.Unlock()
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// --- images ---------------------------------------------------------
	mux.HandleFunc("/api/images", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			q := r.URL.Query()
			limit, _ := strconv.Atoi(q.Get("limit"))
			if limit <= 0 {
				limit = 60
			}
			offset, _ := strconv.Atoi(q.Get("offset"))
			writeJSON(w, 200, s.store.List(ListOpts{
				Query:    q.Get("q"),
				Favorite: q.Get("favorite") == "true",
				Pinned:   q.Get("pinned") == "true",
				Folder:   q.Get("folder"),
				Sort:     q.Get("sort"),
				Limit:    limit,
				Offset:   offset,
			}))

		case http.MethodPost:
			// 64 MiB ceiling on an individual capture.
			if err := r.ParseMultipartForm(64 << 20); err != nil {
				writeErr(w, 400, "Invalid upload")
				return
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				writeErr(w, 400, "Missing file field")
				return
			}
			defer file.Close()
			data, err := io.ReadAll(file)
			if err != nil {
				writeErr(w, 400, "Could not read upload")
				return
			}
			if !isPNG(data) {
				writeErr(w, 400, "Not a valid PNG file")
				return
			}

			var src *Source
			if raw := r.FormValue("source"); raw != "" {
				var parsed Source
				if json.Unmarshal([]byte(raw), &parsed) == nil {
					src = &parsed
				}
			}

			existing := s.store.FindByHash(hashOf(data))
			rec, err := s.store.Insert(data, src)
			if err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			if existing != nil {
				writeJSON(w, 200, map[string]any{"deduped": true, "record": rec})
				return
			}
			writeJSON(w, 201, map[string]any{"deduped": false, "record": rec})

		case http.MethodDelete:
			// Clear the whole library. Deliberately a distinct verb+path
			// from deleting one image, so it can't happen by accident from
			// a malformed id.
			n := s.store.ClearAll()
			writeJSON(w, 200, map[string]any{"ok": true, "deleted": n})

		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// Bulk actions for a multi-image selection: one index write for the
	// whole set rather than one per image.
	mux.HandleFunc("/api/images/bulk", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		var body struct {
			Action string `json:"action"` // "delete" | "update"
			BulkOp
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "Invalid JSON")
			return
		}
		if len(body.IDs) == 0 {
			writeErr(w, 400, "No images selected")
			return
		}
		if body.Action == "delete" {
			writeJSON(w, 200, map[string]any{"ok": true, "deleted": s.store.BulkDelete(body.IDs)})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "updated": s.store.BulkUpdate(body.BulkOp)})
	})

	mux.HandleFunc("/api/images/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/images/")
		parts := strings.SplitN(rest, "/", 2)
		id := parts[0]
		if id == "" {
			writeErr(w, 404, "Not found")
			return
		}
		rec := s.store.Get(id)
		if rec == nil {
			writeErr(w, 404, "Not found")
			return
		}

		if len(parts) == 2 && parts[1] == "file" {
			http.ServeFile(w, r, s.store.ImagePath(rec))
			return
		}

		// Every captured image is an ordinary .png on disk, so "open in
		// folder" can hand the user straight to it.
		if len(parts) == 2 && parts[1] == "reveal" {
			if err := revealFile(s.store.ImagePath(rec)); err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true, "path": s.store.ImagePath(rec)})
			return
		}

		switch r.Method {
		case http.MethodGet:
			writeJSON(w, 200, rec)
		case http.MethodPatch:
			var p Patch
			if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			writeJSON(w, 200, s.store.Update(id, p))
		case http.MethodDelete:
			s.store.Delete(id)
			w.WriteHeader(204)
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// Where the library lives on disk. The UI shows this so it's obvious
	// the images are real files, not something locked inside the app.
	mux.HandleFunc("/api/storage", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"dataDir":   s.app.DataDir,
			"imagesDir": s.store.imagesDir,
		})
	})

	// --- folders ---------------------------------------------------------
	mux.HandleFunc("/api/folders", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, 200, s.store.Folders())
		case http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			f, err := s.store.CreateFolder(body.Name)
			if err != nil {
				writeErr(w, 400, err.Error())
				return
			}
			writeJSON(w, 201, f)
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	mux.HandleFunc("/api/folders/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/folders/")
		if r.Method != http.MethodDelete {
			writeErr(w, 405, "Method not allowed")
			return
		}
		if !s.store.DeleteFolder(id) {
			writeErr(w, 404, "Not found")
			return
		}
		w.WriteHeader(204)
	})

	// --- static UI --------------------------------------------------------
	mux.Handle("/", http.FileServer(http.FS(webFS())))

	return cors(mux)
}

// Listen binds the first free port in a small range. A single hardcoded
// port is a real failure mode on a personal machine - something else may
// already own it - and the extension probes this same range, so discovery
// stays automatic.
func (s *Server) Listen() (net.Listener, error) {
	var lastErr error
	for i := 0; i < portRange; i++ {
		port := basePort + i
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			s.port = port
			return ln, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("could not bind any port in %d-%d: %w", basePort, basePort+portRange-1, lastErr)
}

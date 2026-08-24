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
	store   *Store
	app     *App
	updater *Updater
	tokens  *tokenStore
	pending *pendingStore
	port    int
	// naiEndpoint overrides NovelAI's address. Set only by tests; the
	// client refuses any host but NovelAI's regardless.
	naiEndpoint string
	naiUserData string

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
				Color:    q.Get("color"),
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

		// The gallery grid loads this instead of the original, which is the
		// difference between a large library scrolling smoothly and the
		// browser decoding thousands of full-resolution PNGs. If a
		// thumbnail can't be made for any reason the original is served
		// instead: the result is slower, never broken.
		if len(parts) == 2 && parts[1] == "thumb" {
			path, err := s.store.EnsureThumb(rec)
			if err != nil {
				http.ServeFile(w, r, s.store.ImagePath(rec))
				return
			}
			// Thumbnails never change once made, so they can be cached hard.
			w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
			w.Header().Set("ETag", `"`+rec.Hash+`-t"`)
			http.ServeFile(w, r, path)
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

	// Re-run explicit-content detection over the whole library. The UI
	// calls this when the setting is toggled, so the choice applies to
	// images saved before the feature existed.
	mux.HandleFunc("/api/nsfw/rescan", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		changed := s.store.RescanNSFW()
		writeJSON(w, 200, map[string]any{"ok": true, "changed": changed})
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
			writeJSON(w, 200, s.store.FolderTree())
		case http.MethodPost:
			var body struct {
				Name   string `json:"name"`
				Parent string `json:"parentId"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			f, err := s.store.CreateFolderIn(body.Name, body.Parent)
			if err != nil {
				writeErr(w, 400, err.Error())
				return
			}
			writeJSON(w, 201, f)
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// Folder tags in use - plain words, for searching and grouping.
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.store.TagsInUse())
	})

	// Colour labels: which colours are in use, how many images carry each,
	// and the names the user has given them.
	mux.HandleFunc("/api/colors", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, 200, map[string]any{
				"names":  s.store.ColorLabels(),
				"counts": s.store.ColorCounts(),
			})
		case http.MethodPost:
			var body struct {
				Color string `json:"color"`
				Name  string `json:"name"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			s.store.SetColorLabelName(body.Color, body.Name)
			writeJSON(w, 200, map[string]any{
				"names":  s.store.ColorLabels(),
				"counts": s.store.ColorCounts(),
			})
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	mux.HandleFunc("/api/folders/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/folders/")
		parts := strings.SplitN(rest, "/", 2)
		id := parts[0]
		if id == "" {
			writeErr(w, 404, "Not found")
			return
		}
		action := ""
		if len(parts) == 2 {
			action = parts[1]
		}

		switch {
		case r.Method == http.MethodDelete:
			if !s.store.DeleteFolderTree(id) {
				writeErr(w, 404, "Not found")
				return
			}
			w.WriteHeader(204)

		case r.Method == http.MethodPatch && action == "":
			var body struct {
				Name *string   `json:"name"`
				Tags *[]string `json:"tags"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			if body.Name != nil {
				if err := s.store.RenameFolder(id, *body.Name); err != nil {
					writeErr(w, 400, err.Error())
					return
				}
			}
			if body.Tags != nil {
				if err := s.store.SetFolderTags(id, *body.Tags); err != nil {
					writeErr(w, 400, err.Error())
					return
				}
			}
			writeJSON(w, 200, s.store.FolderTree())

		case r.Method == http.MethodPost && action == "move":
			var body struct {
				Parent string `json:"parentId"`
				Index  int    `json:"index"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			if err := s.store.MoveFolder(id, body.Parent, body.Index); err != nil {
				writeErr(w, 400, err.Error())
				return
			}
			writeJSON(w, 200, s.store.FolderTree())

		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// --- undo / redo ------------------------------------------------------
	mux.HandleFunc("/api/undo", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			writeJSON(w, 200, s.store.UndoState())
			return
		}
		label, ok := s.store.Undo()
		writeJSON(w, 200, map[string]any{"ok": ok, "label": label, "state": s.store.UndoState()})
	})

	mux.HandleFunc("/api/redo", func(w http.ResponseWriter, r *http.Request) {
		label, ok := s.store.Redo()
		writeJSON(w, 200, map[string]any{"ok": ok, "label": label, "state": s.store.UndoState()})
	})

	// --- generating through NovelAI's API ---------------------------------
	//
	// The second way images arrive. The extension is untouched and both
	// paths end at the same Insert, so nothing downstream knows or cares
	// which one a picture came from.

	mux.HandleFunc("/api/nai/token", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// Deliberately not the token itself. A page that can read it
			// back is a page that can leak it, and nothing in the UI needs
			// the value - only whether one is set.
			writeJSON(w, 200, map[string]any{
				"present":    s.tokens.Present(),
				"protection": secretProtection(),
			})
		case http.MethodPost:
			var body struct {
				Token string `json:"token"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			if err := s.tokens.Set(body.Token); err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			writeJSON(w, 200, map[string]any{"present": s.tokens.Present()})
		case http.MethodDelete:
			s.tokens.Set("")
			writeJSON(w, 200, map[string]any{"present": false})
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	mux.HandleFunc("/api/nai/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		token, err := s.tokens.Get()
		if err != nil {
			writeErr(w, 401, err.Error())
			return
		}
		var in GenerateRequest
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(in.Prompt) == "" {
			writeErr(w, 400, "There's no prompt to generate from")
			return
		}
		in.fill()

		// naiGenerate refuses any host but NovelAI's. The override exists so
		// tests can drive the whole flow against a stand-in, and calls
		// naiGenerateAt directly rather than widening the guard itself.
		gen := func(g GenerateRequest) ([]byte, error) {
			if s.naiEndpoint != "" {
				return naiGenerateAt(s.naiEndpoint, token, g)
			}
			return naiGenerate(naiEndpoint, token, g)
		}

		// Generated images wait here rather than joining the library. They
		// are shown on the Generate page and only filed away if you keep
		// them, so a session of experiments doesn't silently become a
		// hundred images you have to go and delete.
		var made []*Pending
		for i := 0; i < in.Count; i++ {
			png, err := gen(in)
			if err != nil {
				// Hand back exactly what was sent. When NovelAI refuses
				// something, the payload is the only evidence of why, and
				// guessing from a status code has already cost enough time.
				// It carries no token - that lives only in the header.
				sent, _ := json.MarshalIndent(naiPayload(in), "", "  ")
				if len(made) > 0 {
					// Anything already generated is kept on the page: it
					// cost Anlas whatever went wrong afterwards.
					writeJSON(w, 207, map[string]any{
						"images": made, "error": err.Error(), "request": string(sent),
					})
					return
				}
				writeJSON(w, 502, map[string]any{
					"error": err.Error(), "request": string(sent),
				})
				return
			}
			p, err := s.pending.Add(png, Pending{
				Prompt: in.Prompt, Negative: in.Negative, Model: in.Model,
			})
			if err != nil {
				writeErr(w, 500, "Generated, but could not hold onto it: "+err.Error())
				return
			}
			made = append(made, p)
		}
		writeJSON(w, 200, map[string]any{"images": made})
	})

	// Reading a PNG's prompt without keeping the file.
	//
	// Dropping a picture onto the generator is asking "what made this?",
	// not "put this in my library" - so this parses and answers, and the
	// bytes go no further.
	mux.HandleFunc("/api/nai/inspect", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
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
		data, err := io.ReadAll(io.LimitReader(file, 64<<20))
		if err != nil {
			writeErr(w, 400, "Could not read that file")
			return
		}
		meta := extractMetadata(data)
		if !meta.IsNovelAI && meta.Prompt == "" {
			writeErr(w, 422, "That PNG has no NovelAI prompt in it")
			return
		}
		writeJSON(w, 200, meta)
	})

	// How much Anlas is left, so the price on the button means something.
	mux.HandleFunc("/api/nai/anlas", func(w http.ResponseWriter, r *http.Request) {
		token, err := s.tokens.Get()
		if err != nil || strings.TrimSpace(token) == "" {
			writeJSON(w, 200, AnlasBalance{
				Reason: "No NovelAI token saved — add one in Settings"})
			return
		}
		// Same rule as generating: the token only ever goes to NovelAI.
		// Tests point this elsewhere explicitly and knowingly.
		endpoint := naiUserData
		if s.naiUserData != "" {
			endpoint = s.naiUserData
		} else if !naiAllowedHost(endpoint) {
			writeJSON(w, 200, AnlasBalance{Reason: "Endpoint not allowed"})
			return
		}
		bal, err := naiFetchAnlas(endpoint, token)
		if err != nil {
			// Not being able to read the balance is not worth an error in
			// anyone's face, but it is worth saying why on hover.
			writeJSON(w, 200, AnlasBalance{Reason: err.Error()})
			return
		}
		writeJSON(w, 200, bal)
	})

	// The session's generations, newest first.
	mux.HandleFunc("/api/nai/pending", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, 200, s.pending.List())
		case http.MethodDelete:
			s.pending.Clear()
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	mux.HandleFunc("/api/nai/pending/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/nai/pending/"), "/"), "/")
		id := parts[0]
		if id == "" || s.pending.Get(id) == nil {
			writeErr(w, 404, "No such image")
			return
		}

		// The picture itself, for the preview and the history strip.
		if len(parts) == 2 && parts[1] == "file" {
			http.ServeFile(w, r, s.pending.path(id))
			return
		}

		// Keeping one: this is the only path by which a generated image
		// enters the library, and it goes through the same Insert the
		// extension uses.
		if len(parts) == 2 && parts[1] == "keep" && r.Method == http.MethodPost {
			if it := s.pending.Get(id); it != nil && it.SavedID != "" {
				// Already kept. Saying so beats quietly making a duplicate.
				writeJSON(w, 200, map[string]any{"id": it.SavedID, "already": true})
				return
			}
			png, err := s.pending.Read(id)
			if err != nil {
				writeErr(w, 404, "That image is no longer here")
				return
			}
			rec, err := s.store.Insert(png, &Source{CapturedBy: "generate"})
			if err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			// NovelAI stamps the prompt into the PNG, but if a future
			// change ever stopped doing that, the app still knows what it
			// asked for - and a saved image with no prompt is one search
			// can never find again.
			if it := s.pending.Get(id); it != nil {
				s.store.FillMissingMeta(rec.ID, it.Prompt, it.Negative, it.Model)
			}
			s.pending.MarkSaved(id, rec.ID)
			writeJSON(w, 200, map[string]any{"id": rec.ID, "record": rec})
			return
		}

		if r.Method == http.MethodDelete {
			s.pending.Discard(id)
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}

		writeErr(w, 404, "Not found")
	})

	// --- prompt generator -------------------------------------------------
	//
	// Rolling itself happens in the browser; this is the durable half.

	mux.HandleFunc("/api/promptgen", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, 200, s.store.PromptConfig())
		case http.MethodPut:
			var cfg PromptConfig
			if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
				writeErr(w, 400, "Invalid JSON")
				return
			}
			if len(cfg.Buckets) == 0 {
				writeErr(w, 400, "That would leave nothing to roll from")
				return
			}
			writeJSON(w, 200, s.store.SavePromptConfig(cfg))
		default:
			writeErr(w, 405, "Method not allowed")
		}
	})

	// The tags this library actually uses, so the pools can be built from
	// evidence rather than from a starter list someone else wrote.
	mux.HandleFunc("/api/promptgen/mine", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 {
			limit = 300
		}
		writeJSON(w, 200, s.store.MinedTags(limit))
	})

	// --- updates ----------------------------------------------------------
	//
	// Checking and downloading run in the background and report through
	// /api/update/state, which the UI polls only while something is in
	// flight. Holding the HTTP request open for a multi-megabyte download
	// would leave the window looking hung.

	mux.HandleFunc("/api/update/state", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"version":  appVersion,
			"progress": s.updater.Progress(),
			"repo":     "https://github.com/" + updateRepo,
		})
	})

	// Called once when the window loads. It answers whether this is the
	// first open of the day - the moment the prompt is meant to appear -
	// and marks the day as checked so it doesn't nag on every reopen.
	mux.HandleFunc("/api/update/daily", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		set := s.store.Settings()
		day := today()
		first := !s.store.CheckedUpdatesToday(day)
		// The day is marked from inside the check, so a failed one doesn't
		// use it up and hide a real update until tomorrow.
		mark := func(rel *Release) { s.store.MarkUpdateChecked(day) }
		if first && set.AutoUpdate {
			// Opted in: don't ask, just do it.
			s.store.MarkUpdateChecked(day)
			s.updater.AutoRun()
		} else if first {
			s.updater.CheckAsync(mark)
		}
		writeJSON(w, 200, map[string]any{
			"first":      first,
			"autoUpdate": set.AutoUpdate,
		})
	})

	mux.HandleFunc("/api/update/check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		started := s.updater.CheckAsync(nil)
		writeJSON(w, 200, map[string]any{"started": started, "progress": s.updater.Progress()})
	})

	mux.HandleFunc("/api/update/download", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		started := s.updater.DownloadAsync(nil)
		writeJSON(w, 200, map[string]any{"started": started, "progress": s.updater.Progress()})
	})

	mux.HandleFunc("/api/update/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "Method not allowed")
			return
		}
		if err := s.updater.Install(); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		// The app exits a moment after this returns, so this response is
		// the last thing the UI will hear from it.
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	// The changelog left behind by an update that has since been installed.
	// Reading it clears it, so the welcome screen appears exactly once.
	mux.HandleFunc("/api/update/welcome", func(w http.ResponseWriter, r *http.Request) {
		rel := s.updater.TakePending()
		writeJSON(w, 200, map[string]any{"release": rel})
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

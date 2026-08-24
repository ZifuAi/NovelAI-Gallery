package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.1", "1.0", 1},
		{"1.0", "1.1", -1},
		{"1.1", "1.1", 0},
		// A leading v is how tags are usually written, and must not change
		// the answer.
		{"v1.2", "1.1", 1},
		{"1.1", "v1.1", 0},
		// Different lengths: a missing part is zero, so 1.1 and 1.1.0 are
		// the same build and 1.1.1 is newer than both.
		{"1.1.0", "1.1", 0},
		{"1.1.1", "1.1", 1},
		{"1.1", "1.1.1", -1},
		// Ten is not "less than two" just because '1' sorts before '2'.
		{"1.10", "1.2", 1},
		{"2.0", "1.99", 1},
		// Nothing to compare against is not newer.
		{"", "1.1", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// The check has to pick the installer out of a release that may carry
// several attachments, and has to decide "newer" against the running build.
func TestCheckParsesRelease(t *testing.T) {
	body := `{
      "tag_name": "v9.9",
      "name": "Build 9.9",
      "body": "- something new\n- something fixed",
      "html_url": "https://example.invalid/releases/9.9",
      "assets": [
        {"name": "source.zip", "size": 10, "browser_download_url": "https://example.invalid/source.zip"},
        {"name": "NovelAI-Gallery-Setup.exe", "size": 2400000, "browser_download_url": "https://example.invalid/setup.exe"}
      ]
    }`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Error("GitHub rejects requests without a User-Agent")
		}
		w.Write([]byte(body))
	}))
	defer srv.Close()

	u := NewUpdater(t.TempDir())
	rel, err := u.checkAt(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if rel.Version != "9.9" {
		t.Errorf("version = %q, want 9.9 (the v should be stripped)", rel.Version)
	}
	if rel.AssetName != "NovelAI-Gallery-Setup.exe" {
		t.Errorf("picked %q, want the .exe installer", rel.AssetName)
	}
	if rel.AssetSize != 2400000 {
		t.Errorf("asset size = %d", rel.AssetSize)
	}
	if !rel.Newer {
		t.Errorf("9.9 should be newer than the running build %s", appVersion)
	}
	if u.Progress().State != "available" {
		t.Errorf("progress state = %q, want available", u.Progress().State)
	}
}

func TestCheckSameVersionIsNotNewer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":"v` + appVersion + `","assets":[]}`))
	}))
	defer srv.Close()

	u := NewUpdater(t.TempDir())
	rel, err := u.checkAt(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if rel.Newer {
		t.Error("the running build should not report itself as an update")
	}
	if u.Progress().State != "uptodate" {
		t.Errorf("state = %q, want uptodate", u.Progress().State)
	}
}

// A repo with no releases yet answers 404. That is the normal state of a
// fresh GitHub page and must not surface as a scary error.
func TestCheckNoReleasesIsGentle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Not Found", 404)
	}))
	defer srv.Close()

	u := NewUpdater(t.TempDir())
	if _, err := u.checkAt(srv.URL); err == nil {
		t.Fatal("expected an error")
	}
	if got := u.Progress().State; got != "uptodate" {
		t.Errorf("state = %q, want uptodate rather than error", got)
	}
}

func TestDownloadWritesInstallerAndPending(t *testing.T) {
	payload := []byte("MZ this is pretending to be an installer")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(payload)
	}))
	defer srv.Close()

	dir := t.TempDir()
	u := NewUpdater(dir)
	rel := &Release{
		Version: appVersion, Tag: "v" + appVersion, Notes: "the changelog",
		AssetURL: srv.URL, AssetName: "setup.exe", AssetSize: int64(len(payload)),
	}
	if err := u.Download(rel); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(filepath.Join(dir, "updates", "setup.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Error("the downloaded file does not match what was served")
	}
	// The .part file is the half-finished name and must not survive.
	if _, err := os.Stat(filepath.Join(dir, "updates", "setup.exe.part")); err == nil {
		t.Error("a .part file was left behind; a half download could be mistaken for a real one")
	}
	if p := u.Progress(); p.State != "ready" || p.Percent != 100 {
		t.Errorf("progress = %+v, want ready at 100%%", p)
	}

	// The changelog has to survive the restart, which is the only reason
	// it is written to disk at all.
	pending := u.TakePending()
	if pending == nil {
		t.Fatal("no pending release was recorded")
	}
	if pending.Notes != "the changelog" {
		t.Errorf("notes = %q", pending.Notes)
	}
	// And it is shown exactly once.
	if u.TakePending() != nil {
		t.Error("the welcome screen would appear on every launch")
	}
}

// A pending file describing some other build is stale - the update did not
// actually happen - so it must not produce a welcome screen for a version
// that isn't running.
func TestTakePendingIgnoresOtherVersions(t *testing.T) {
	dir := t.TempDir()
	u := NewUpdater(dir)
	b, _ := json.Marshal(Release{Version: "99.0", Notes: "not this build"})
	os.WriteFile(filepath.Join(dir, "pending-update.json"), b, 0o644)
	if u.TakePending() != nil {
		t.Error("a pending record for a different build should be ignored")
	}
}

func TestInstallWithoutDownloadFails(t *testing.T) {
	u := NewUpdater(t.TempDir())
	if err := u.Install(); err == nil {
		t.Error("installing nothing should be an error, not a silent no-op")
	}
}

// --- the daily check ----------------------------------------------------
//
// "The first time you open it that day" has to survive the window being
// closed and reopened, and a check that failed must not use up the day -
// otherwise one moment offline hides a real update until tomorrow.

func newTestServer(t *testing.T, api string) *Server {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	u := NewUpdater(t.TempDir())
	u.api = api
	return &Server{store: store, app: &App{}, updater: u, reuseCh: make(chan string, 1)}
}

func daily(t *testing.T, h http.Handler) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/update/daily", nil))
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// waitIdle lets the background check finish. It is polled rather than slept
// on so the test isn't timing-dependent.
func waitIdle(t *testing.T, u *Updater) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if s := u.Progress().State; s != "checking" && s != "idle" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the check never finished")
}

func TestDailyCheckHappensOncePerDay(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":"v9.9","assets":[{"name":"setup.exe","size":5,"browser_download_url":"http://x/setup.exe"}]}`))
	}))
	defer gh.Close()

	s := newTestServer(t, gh.URL)
	h := s.routes()

	first := daily(t, h)
	if first["first"] != true {
		t.Fatal("the first open of the day should check")
	}
	waitIdle(t, s.updater)

	second := daily(t, h)
	if second["first"] != false {
		t.Error("reopening the window should not prompt again the same day")
	}
	// And the check that did run found the update.
	if p := s.updater.Progress(); p.State != "available" {
		t.Errorf("progress state = %q, want available", p.State)
	}
}

func TestFailedDailyCheckDoesNotUseUpTheDay(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", 403)
	}))
	defer gh.Close()

	s := newTestServer(t, gh.URL)
	h := s.routes()

	if daily(t, h)["first"] != true {
		t.Fatal("expected the first check of the day")
	}
	waitIdle(t, s.updater)

	if daily(t, h)["first"] != true {
		t.Error("a failed check used up the day; a real update would stay hidden until tomorrow")
	}
}

// The settings screen sends the whole settings object back. It must not be
// able to reset the daily bookkeeping just by echoing a blank field.
func TestSavingSettingsKeepsTheUpdateBookkeeping(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store.MarkUpdateChecked("2026-01-01")

	in := store.Settings()
	in.LastUpdateCheck = ""
	in.AutoUpdate = true
	out := store.UpdateSettings(in)

	if out.LastUpdateCheck != "2026-01-01" {
		t.Errorf("lastUpdateCheck = %q, want it preserved", out.LastUpdateCheck)
	}
	if !out.AutoUpdate {
		t.Error("the toggle the user actually changed should be saved")
	}
	if !store.CheckedUpdatesToday("2026-01-01") {
		t.Error("the stored day should still count as checked")
	}
}

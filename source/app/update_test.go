package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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

// The whole update path, end to end, against a stand-in for GitHub serving
// the real installer.
//
// Everything up to launching the installer is exercised here: the check
// notices the newer build, the download writes the actual bytes, and what
// lands on disk is byte-identical to what was served. Only the final
// CreateProcess is Windows-only, and its flags are covered by
// TestInstallerFlagsMatchTheInstallerScript.
func TestFullUpdateFlowAgainstARealInstaller(t *testing.T) {
	installer, err := os.ReadFile("NovelAI-Gallery-Setup.exe")
	if err != nil {
		t.Skip("no built installer to serve; run build.sh first")
	}
	if len(installer) < 100000 {
		t.Fatalf("that installer is only %d bytes; something is wrong with the build", len(installer))
	}

	var served int
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".exe") {
			served++
			w.Header().Set("Content-Length", strconv.Itoa(len(installer)))
			w.Write(installer)
			return
		}
		w.Write([]byte(`{
			"tag_name": "v99.0",
			"name": "Build 99.0",
			"body": "### Added\n- the thing",
			"html_url": "https://example.invalid/r/99",
			"assets": [{"name":"NovelAI-Gallery-Setup.exe","size":` +
			strconv.Itoa(len(installer)) + `,"browser_download_url":"` + baseOf(r) + `/asset.exe"}]
		}`))
	}))
	defer gh.Close()

	dir := t.TempDir()
	u := NewUpdater(dir)
	u.api = gh.URL

	rel, err := u.Check()
	if err != nil {
		t.Fatal(err)
	}
	if !rel.Newer {
		t.Fatalf("99.0 should be newer than the running build %s", appVersion)
	}
	if rel.AssetSize != int64(len(installer)) {
		t.Errorf("asset size = %d, want %d", rel.AssetSize, len(installer))
	}

	if err := u.Download(rel); err != nil {
		t.Fatal(err)
	}
	if served != 1 {
		t.Errorf("the installer was fetched %d times, want once", served)
	}

	got, err := os.ReadFile(filepath.Join(dir, "updates", "NovelAI-Gallery-Setup.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, installer) {
		t.Fatalf("what was downloaded (%d bytes) does not match what was served (%d)",
			len(got), len(installer))
	}
	// A Windows executable, not an error page saved under the wrong name.
	if len(got) < 2 || got[0] != 'M' || got[1] != 'Z' {
		t.Error("the downloaded file is not a Windows executable")
	}

	if p := u.Progress(); p.State != "ready" || p.Percent != 100 {
		t.Errorf("progress = %+v, want ready at 100%%", p)
	}

	// The changelog has to survive the restart the installer is about to
	// cause; that is the only reason it is written to disk at all.
	if _, err := os.Stat(filepath.Join(dir, "pending-update.json")); err != nil {
		t.Error("no pending release was recorded; the what's-new screen would never appear")
	}
}

func baseOf(r *http.Request) string { return "http://" + r.Host }

// --- releases published as a zip ---------------------------------------

// zipWith builds an in-memory zip holding the named files.
func zipWith(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// Sorted, so the archive is the same every run and a test that depends
	// on entry order would fail honestly rather than intermittently.
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(files[n]); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestPickInstallerFromABundle(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		want  string
	}{
		{
			"the bundle as it is actually published",
			[]string{"NovelAI-Tools-Setup.exe", "source/app/main.go", "extension/background.js"},
			"NovelAI-Tools-Setup.exe",
		},
		{
			"inside a folder, as most zip tools produce",
			[]string{"NovelAI-Tools-1.2.0/NovelAI-Tools-Setup.exe", "NovelAI-Tools-1.2.0/README.md"},
			"NovelAI-Tools-1.2.0/NovelAI-Tools-Setup.exe",
		},
		{
			"the uninstaller is never the answer",
			[]string{"app/Uninstall.exe", "app/NovelAI-Tools-Setup.exe"},
			"app/NovelAI-Tools-Setup.exe",
		},
		{
			"nothing runnable in there at all",
			[]string{"source/app/main.go", "README.md"},
			"",
		},
	}
	for _, c := range cases {
		if got := pickInstaller(c.files); got != c.want {
			t.Errorf("%s: picked %q, want %q", c.name, got, c.want)
		}
	}
}

// A release published as a zip is the normal case for this project: the
// bundle carries the installer, the source and the extension together. The
// updater used to look for an .exe asset, find none, and offer an update it
// could never install.
func TestUpdateFromAZipRelease(t *testing.T) {
	installer := append([]byte{'M', 'Z'}, bytes.Repeat([]byte("installer"), 5000)...)
	bundle := zipWith(t, map[string][]byte{
		"NovelAI-Tools-Setup.exe": installer,
		"source/app/main.go":      []byte("package main\n"),
		"extension/manifest.json": []byte("{}"),
	})

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".zip") {
			w.Header().Set("Content-Length", strconv.Itoa(len(bundle)))
			w.Write(bundle)
			return
		}
		w.Write([]byte(`{
			"tag_name": "v99.0",
			"name": "Build 99.0",
			"body": "notes",
			"html_url": "https://example.invalid/r/99",
			"assets": [{"name":"NovelAI-Tools-99.0.zip","size":` +
			strconv.Itoa(len(bundle)) + `,"browser_download_url":"` + baseOf(r) + `/asset.zip"}]
		}`))
	}))
	defer gh.Close()

	dir := t.TempDir()
	u := NewUpdater(dir)
	u.api = gh.URL

	rel, err := u.Check()
	if err != nil {
		t.Fatal(err)
	}
	if rel.AssetURL == "" {
		t.Fatal("a zip release was treated as having nothing to install")
	}
	if !strings.HasSuffix(rel.AssetName, ".zip") {
		t.Fatalf("asset = %q, want the zip", rel.AssetName)
	}

	if err := u.Download(rel); err != nil {
		t.Fatal(err)
	}
	if p := u.Progress(); p.State != "ready" {
		t.Fatalf("progress = %+v, want ready", p)
	}

	u.mu.Lock()
	got := u.installerPath
	u.mu.Unlock()
	if !strings.HasSuffix(strings.ToLower(got), ".exe") {
		t.Fatalf("installer path = %q; a zip cannot be run", got)
	}
	b, err := os.ReadFile(got)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, installer) {
		t.Fatalf("the unpacked installer is %d bytes, want %d", len(b), len(installer))
	}
	// Only the installer comes out. The source tree is not written to
	// anyone's disk to get at one file inside it.
	if _, err := os.Stat(filepath.Join(dir, "updates", "unpacked", "source")); err == nil {
		t.Error("the whole bundle was unpacked, not just the installer")
	}
}

func TestZipWithNoInstallerSaysSo(t *testing.T) {
	bundle := zipWith(t, map[string][]byte{"source/app/main.go": []byte("package main\n")})
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "b.zip")
	if err := os.WriteFile(zipPath, bundle, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := extractInstaller(zipPath, filepath.Join(dir, "unpacked"))
	if err == nil {
		t.Fatal("a zip with no installer in it was accepted")
	}
	if !strings.Contains(err.Error(), "installer") {
		t.Errorf("error = %q, which does not say what is wrong", err)
	}
}

// A crafted entry name must not be able to write outside the directory it
// was given.
func TestExtractRefusesToEscapeItsDirectory(t *testing.T) {
	bundle := zipWith(t, map[string][]byte{
		"../../../escaped-setup.exe": append([]byte{'M', 'Z'}, []byte("x")...),
	})
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "b.zip")
	if err := os.WriteFile(zipPath, bundle, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := extractInstaller(zipPath, filepath.Join(dir, "unpacked"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(out) != filepath.Join(dir, "unpacked") {
		t.Fatalf("wrote to %q, outside the directory it was given", out)
	}
}

// Install must refuse anything that is not an executable, whatever left it
// on disk.
func TestInstallRefusesAZip(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "b.zip")
	if err := os.WriteFile(zipPath, []byte("PK"), 0o644); err != nil {
		t.Fatal(err)
	}
	u := NewUpdater(dir)
	u.installerPath = zipPath
	if err := u.Install(); err == nil {
		t.Fatal("a zip was handed to the operating system to run")
	}
}

// A release tagged with words as well as numbers.
//
// The repo's own releases are tagged "Build-1.2.0". Trimming a leading "v"
// left that whole string as the version, which compared as text against
// "1.2.1", came out greater, and told everyone already on the newest build
// that "Build Build-1.2.0" was available.
func TestVersionFromTag(t *testing.T) {
	cases := []struct{ tag, name, want string }{
		{"v1.2.1", "", "1.2.1"},
		{"1.2.1", "", "1.2.1"},
		{"Build-1.2.0", "", "1.2.0"},
		{"Build 1.2", "", "1.2"},
		{"release", "Build 1.3.0", "1.3.0"},
		{"", "", ""},
	}
	for _, c := range cases {
		if got := versionFromTag(c.tag, c.name); got != c.want {
			t.Errorf("versionFromTag(%q, %q) = %q, want %q", c.tag, c.name, got, c.want)
		}
	}
}

func TestSameBuildUnderAnotherTagIsNotAnUpdate(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{
			"tag_name": "Build-` + appVersion + `",
			"name": "Build ` + appVersion + `",
			"assets": [{"name":"s.exe","size":10,"browser_download_url":"http://x/s.exe"}]
		}`))
	}))
	defer gh.Close()

	u := NewUpdater(t.TempDir())
	u.api = gh.URL
	rel, err := u.Check()
	if err != nil {
		t.Fatal(err)
	}
	if rel.Version != appVersion {
		t.Errorf("version = %q, want %q", rel.Version, appVersion)
	}
	if rel.Newer {
		t.Error("the build already running was offered as an update")
	}
	if p := u.Progress(); p.State != "uptodate" {
		t.Errorf("state = %q, want uptodate", p.State)
	}
}

// A tag with no number in it at all must not be treated as newer either.
func TestWordyTagIsNeverNewer(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name": "nightly", "name": "nightly", "assets": []}`))
	}))
	defer gh.Close()

	u := NewUpdater(t.TempDir())
	u.api = gh.URL
	rel, err := u.Check()
	if err != nil {
		t.Fatal(err)
	}
	if rel.Newer {
		t.Errorf("%q was treated as newer than %q", rel.Version, appVersion)
	}
}

package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Updating from GitHub releases.
//
// The app asks the releases API what the newest tag is, compares it with
// the build it is running, and - if the user agrees - downloads the
// installer and runs it. The installer is the same one people download by
// hand; it already knows how to upgrade in place, so there is no second
// code path to keep working.
//
// Nothing here happens without being asked, unless automatic updates are
// switched on. The check itself is once a day at most.

const (
	updateRepo    = "ZifuAi/NovelAI-Gallery"
	updateAPI     = "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	updateTimeout = 20 * time.Second
)

// Release is the slice of GitHub's response the app actually uses.
type Release struct {
	Version   string `json:"version"`  // normalised, no leading v
	Tag       string `json:"tag"`      // as published
	Name      string `json:"name"`     // release title
	Notes     string `json:"notes"`    // the changelog body
	URL       string `json:"url"`      // the release page
	AssetURL  string `json:"assetUrl"` // the installer to download
	AssetName string `json:"assetName"`
	AssetSize int64  `json:"assetSize"`
	Newer     bool   `json:"newer"` // newer than what's running
}

type UpdateProgress struct {
	State      string   `json:"state"` // idle|checking|available|downloading|ready|installing|error|uptodate
	Message    string   `json:"message"`
	Percent    float64  `json:"percent"`
	Downloaded int64    `json:"downloaded"`
	Total      int64    `json:"total"`
	Release    *Release `json:"release,omitempty"`
}

type Updater struct {
	mu       sync.Mutex
	progress UpdateProgress
	dataDir  string
	// Where the downloaded installer is waiting.
	installerPath string
	// The release the last check found, so the UI can say "download" and
	// "install" without carrying the whole release back and forth.
	latest *Release
	// busy stops a second check or download starting on top of the first,
	// which is easy to trigger by clicking twice.
	busy bool
	// api is the releases endpoint. It is a field rather than a constant so
	// the whole flow can be driven against a test server.
	api string
}

// begin claims the updater for one operation. It returns false if another
// one is already running.
func (u *Updater) begin() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.busy {
		return false
	}
	u.busy = true
	return true
}

func (u *Updater) end() {
	u.mu.Lock()
	u.busy = false
	u.mu.Unlock()
}

func (u *Updater) Latest() *Release {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.latest
}

func NewUpdater(dataDir string) *Updater {
	return &Updater{dataDir: dataDir, api: updateAPI, progress: UpdateProgress{State: "idle"}}
}

func (u *Updater) Progress() UpdateProgress {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.progress
}

func (u *Updater) set(p UpdateProgress) {
	u.mu.Lock()
	u.progress = p
	u.mu.Unlock()
}

// versionFromTag pulls the version number out of whatever a release is
// called.
//
// Releases here have been tagged "v1.2", "1.2.0" and "Build-1.2.0", and the
// last of those is what broke it: trimming a leading "v" left the string
// "Build-1.2.0", which compared as text against "1.2.0", came out greater,
// and told everybody already on the newest build that an update was
// waiting - called, in the notice, "Build Build-1.2.0". The number is the
// only part that means anything, so the number is what is taken, from the
// tag or, failing that, from the release's title.
var versionDigits = regexp.MustCompile(`[0-9]+(?:\.[0-9]+)*`)

func versionFromTag(tag, name string) string {
	for _, s := range []string{tag, name} {
		if v := versionDigits.FindString(s); v != "" {
			return v
		}
	}
	// Nothing numeric anywhere. Returned as-is so the release still has a
	// name to show; whether it is newer is decided separately, and a
	// version with no number in it is never treated as one.
	return strings.TrimPrefix(strings.TrimSpace(tag), "v")
}

// compareVersions returns -1, 0 or 1 comparing dotted numeric versions.
// Anything non-numeric is compared as text, so "1.2-beta" still orders
// sensibly against "1.2".
func compareVersions(a, b string) int {
	clean := func(v string) []string {
		v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "v"))
		if v == "" {
			return nil
		}
		return strings.Split(v, ".")
	}
	as, bs := clean(a), clean(b)
	for i := 0; i < len(as) || i < len(bs); i++ {
		// A part the shorter version doesn't have counts as zero, so "1.1"
		// and "1.1.0" are the same build rather than the longer one always
		// winning.
		ap, bp := "0", "0"
		if i < len(as) {
			ap = as[i]
		}
		if i < len(bs) {
			bp = bs[i]
		}
		an, aerr := strconv.Atoi(ap)
		bn, berr := strconv.Atoi(bp)
		if aerr == nil && berr == nil {
			if an != bn {
				if an < bn {
					return -1
				}
				return 1
			}
			continue
		}
		if ap != bp {
			if ap < bp {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Check asks GitHub for the latest release.
func (u *Updater) Check() (*Release, error) { return u.checkAt(u.api) }

// checkAt is Check with the endpoint spelled out, so the parsing can be
// exercised against a local server rather than the real GitHub.
func (u *Updater) checkAt(endpoint string) (*Release, error) {
	u.set(UpdateProgress{State: "checking", Message: "Checking for updates…"})

	client := &http.Client{Timeout: updateTimeout}
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	// GitHub wants a User-Agent, and the explicit API version keeps the
	// response shape stable.
	req.Header.Set("User-Agent", "NovelAI-Gallery/"+appVersion)
	req.Header.Set("Accept", "application/vnd.github+json")

	res, err := client.Do(req)
	if err != nil {
		u.set(UpdateProgress{State: "error", Message: "Could not reach GitHub: " + err.Error()})
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode == 404 {
		// A repo with no published release yet is not an error worth alarming
		// anyone about.
		u.set(UpdateProgress{State: "uptodate", Message: "No releases published yet"})
		return nil, fmt.Errorf("no releases published yet")
	}
	if res.StatusCode != 200 {
		// GitHub's unauthenticated limit is per-IP and generous, but a
		// shared address can still exhaust it. That isn't a fault worth
		// showing a status code for - it just means "later".
		msg := fmt.Sprintf("GitHub answered %d", res.StatusCode)
		if res.StatusCode == 403 || res.StatusCode == 429 {
			msg = "GitHub is busy right now — try again later"
			if res.Header.Get("X-RateLimit-Remaining") == "0" {
				msg = "Too many update checks for now — try again in an hour"
			}
		}
		u.set(UpdateProgress{State: "error", Message: msg})
		return nil, fmt.Errorf("%s", msg)
	}

	var raw struct {
		TagName string `json:"tag_name"`
		Name    string `json:"name"`
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
		Draft   bool   `json:"draft"`
		Assets  []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		u.set(UpdateProgress{State: "error", Message: "Could not read the release"})
		return nil, err
	}

	rel := &Release{
		Tag:     raw.TagName,
		Version: versionFromTag(raw.TagName, raw.Name),
		Name:    raw.Name,
		Notes:   raw.Body,
		URL:     raw.HTMLURL,
	}
	// A bare .exe is the installer and needs nothing doing to it. A .zip is
	// the other way releases here are published - the installer alongside
	// the source and the extension - and the installer has to be dug back
	// out of it before it can be run. Either is accepted, the .exe first
	// because it is one less step that can fail.
	for _, a := range raw.Assets {
		if strings.HasSuffix(strings.ToLower(a.Name), ".exe") {
			rel.AssetURL = a.URL
			rel.AssetName = a.Name
			rel.AssetSize = a.Size
			break
		}
	}
	if rel.AssetURL == "" {
		for _, a := range raw.Assets {
			if strings.HasSuffix(strings.ToLower(a.Name), ".zip") {
				rel.AssetURL = a.URL
				rel.AssetName = a.Name
				rel.AssetSize = a.Size
				break
			}
		}
	}
	// A release has to carry a real version number to be newer than this
	// build. Without this, a tag that is only words compares as text, comes
	// out greater than "1.2.1", and nags everybody who is already up to
	// date - which is exactly what happened.
	rel.Newer = versionDigits.MatchString(rel.Version) &&
		compareVersions(rel.Version, appVersion) > 0

	u.mu.Lock()
	u.latest = rel
	u.mu.Unlock()

	if rel.Newer {
		u.set(UpdateProgress{State: "available", Message: "Build " + rel.Version + " is available", Release: rel})
	} else {
		u.set(UpdateProgress{State: "uptodate", Message: "You're on the latest build", Release: rel})
	}
	return rel, nil
}

// Download fetches the installer, reporting progress as it goes.
func (u *Updater) Download(rel *Release) error {
	if rel == nil || rel.AssetURL == "" {
		err := fmt.Errorf("that release has no installer attached")
		u.set(UpdateProgress{State: "error", Message: err.Error(), Release: rel})
		return err
	}

	u.set(UpdateProgress{State: "downloading", Message: "Downloading…", Total: rel.AssetSize, Release: rel})

	client := &http.Client{Timeout: 10 * time.Minute}
	req, _ := http.NewRequest("GET", rel.AssetURL, nil)
	req.Header.Set("User-Agent", "NovelAI-Gallery/"+appVersion)

	res, err := client.Do(req)
	if err != nil {
		u.set(UpdateProgress{State: "error", Message: "Download failed: " + err.Error(), Release: rel})
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		err := fmt.Errorf("download answered %d", res.StatusCode)
		u.set(UpdateProgress{State: "error", Message: err.Error(), Release: rel})
		return err
	}

	dir := filepath.Join(u.dataDir, "updates")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		u.set(UpdateProgress{State: "error", Message: err.Error(), Release: rel})
		return err
	}
	// Download to a partial name and rename on success, so a half-finished
	// file can never be mistaken for a usable installer.
	target := filepath.Join(dir, rel.AssetName)
	partial := target + ".part"
	out, err := os.Create(partial)
	if err != nil {
		u.set(UpdateProgress{State: "error", Message: err.Error(), Release: rel})
		return err
	}

	total := rel.AssetSize
	if total <= 0 {
		total = res.ContentLength
	}
	var done int64
	buf := make([]byte, 64*1024)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				out.Close()
				os.Remove(partial)
				u.set(UpdateProgress{State: "error", Message: werr.Error(), Release: rel})
				return werr
			}
			done += int64(n)
			pct := 0.0
			if total > 0 {
				pct = float64(done) / float64(total) * 100
			}
			u.set(UpdateProgress{
				State: "downloading", Message: "Downloading…",
				Percent: pct, Downloaded: done, Total: total, Release: rel,
			})
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			os.Remove(partial)
			u.set(UpdateProgress{State: "error", Message: rerr.Error(), Release: rel})
			return rerr
		}
	}
	out.Close()

	if err := os.Rename(partial, target); err != nil {
		u.set(UpdateProgress{State: "error", Message: err.Error(), Release: rel})
		return err
	}

	// A zip is not something that can be run. The installer inside it is,
	// so it comes out here rather than at the moment someone presses
	// Install: a release packaged the wrong way should fail while it is
	// still downloading, not after the window has said "ready".
	installer := target
	if strings.HasSuffix(strings.ToLower(target), ".zip") {
		u.set(UpdateProgress{
			State: "downloading", Message: "Unpacking…",
			Percent: 100, Downloaded: done, Total: total, Release: rel,
		})
		found, xerr := extractInstaller(target, filepath.Join(dir, "unpacked"))
		if xerr != nil {
			u.set(UpdateProgress{State: "error", Message: xerr.Error(), Release: rel})
			return xerr
		}
		installer = found
	}

	u.mu.Lock()
	u.installerPath = installer
	u.mu.Unlock()

	// Remember what's being installed so the changelog can be shown once
	// the new build starts up.
	u.writePending(rel)

	u.set(UpdateProgress{
		State: "ready", Message: "Ready to install",
		Percent: 100, Downloaded: done, Total: total, Release: rel,
	})
	return nil
}

// --- getting the installer out of a zip --------------------------------

// The largest thing worth unpacking. An installer is a few megabytes; a
// number far above that is a runaway or a hostile archive, and either way
// not something to write to someone's disk.
const maxInstallerBytes = 512 << 20

// pickInstaller chooses the installer from a zip's contents.
//
// The bundles published for this app hold the setup .exe next to the source
// and the extension, so "the only .exe" is not a safe assumption and
// neither is "the first one". A name that says setup or install wins;
// failing that, the biggest .exe, an installer being far larger than
// anything else that might be shipped beside it. Uninstall.exe is excluded
// by name, because it is an .exe that says "install" and running it would
// remove the app rather than update it.
func pickInstaller(names []string) string {
	best, bestScore := "", -1
	for _, n := range names {
		low := strings.ToLower(path.Base(n))
		if !strings.HasSuffix(low, ".exe") {
			continue
		}
		if strings.HasPrefix(low, "uninstall") || strings.Contains(low, "uninst") {
			continue
		}
		score := 0
		if strings.Contains(low, "setup") || strings.Contains(low, "install") {
			score = 2
		} else if strings.Contains(low, "novelai") {
			score = 1
		}
		if score > bestScore {
			best, bestScore = n, score
		}
	}
	return best
}

// extractInstaller pulls the installer out of a downloaded zip and returns
// the path it was written to. Only that one file is unpacked: the rest of
// the bundle is source and an extension, and writing all of it to someone's
// disk to reach one file would be rude as well as slow.
func extractInstaller(zipPath, destDir string) (string, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", fmt.Errorf("the downloaded file is not a readable zip: %w", err)
	}
	defer zr.Close()

	names := make([]string, 0, len(zr.File))
	byName := map[string]*zip.File{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		names = append(names, f.Name)
		byName[f.Name] = f
	}

	// Sorted, so an archive listing its files in a different order does not
	// produce a different choice between two equally-named candidates.
	sort.Strings(names)
	choice := pickInstaller(names)
	if choice == "" {
		return "", fmt.Errorf("that release's zip has no installer in it")
	}
	src := byName[choice]
	if src.UncompressedSize64 > maxInstallerBytes {
		return "", fmt.Errorf("the installer inside that zip is implausibly large")
	}

	// Fresh each time: a stale installer from a previous update left lying
	// around is the kind of thing that gets run by accident.
	os.RemoveAll(destDir)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", err
	}
	// Only the base name is used, so a crafted entry like ../../evil.exe
	// cannot write outside the directory it was given.
	out := filepath.Join(destDir, filepath.Base(filepath.FromSlash(choice)))

	rc, err := src.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()

	f, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return "", err
	}
	written, err := io.Copy(f, io.LimitReader(rc, maxInstallerBytes))
	cerr := f.Close()
	if err != nil {
		os.Remove(out)
		return "", err
	}
	if cerr != nil {
		os.Remove(out)
		return "", cerr
	}
	if written == 0 {
		os.Remove(out)
		return "", fmt.Errorf("the installer inside that zip is empty")
	}
	return out, nil
}

// pendingPath holds the release notes between downloading an update and
// the new build starting, which is the only way the changelog can survive
// the restart.
func (u *Updater) pendingPath() string {
	return filepath.Join(u.dataDir, "pending-update.json")
}

func (u *Updater) writePending(rel *Release) {
	writeJSONAtomic(u.pendingPath(), rel)
}

// TakePending returns the release notes left by an update that has since
// been installed, and clears them so the changelog is shown once.
func (u *Updater) TakePending() *Release {
	b, err := os.ReadFile(u.pendingPath())
	if err != nil {
		return nil
	}
	var rel Release
	if json.Unmarshal(b, &rel) != nil {
		os.Remove(u.pendingPath())
		return nil
	}
	// Only interesting if the running build is the one it described.
	if compareVersions(rel.Version, appVersion) != 0 {
		return nil
	}
	os.Remove(u.pendingPath())
	return &rel
}

// Install runs the downloaded installer and asks it to bring the app back
// afterwards. It returns once the installer has been started; the app is
// expected to exit immediately so its files can be replaced.
func (u *Updater) Install() error {
	u.mu.Lock()
	exe := u.installerPath
	u.mu.Unlock()

	if exe == "" {
		return fmt.Errorf("nothing has been downloaded yet")
	}
	if _, err := os.Stat(exe); err != nil {
		return fmt.Errorf("the downloaded installer is missing")
	}
	// Belt and braces: a zip reaching this point would be handed to the
	// operating system to run, which does nothing useful and says nothing
	// helpful about why.
	if !strings.HasSuffix(strings.ToLower(exe), ".exe") {
		return fmt.Errorf("what was downloaded is not an installer")
	}

	u.set(UpdateProgress{State: "installing", Message: "Installing…"})
	return runInstaller(exe)
}

// --- driving it from the UI --------------------------------------------
//
// Checking and downloading both take long enough that holding an HTTP
// request open for them would leave the window looking frozen. They run in
// the background instead and report through Progress(), which the UI polls
// while anything is in flight.

// CheckAsync starts a check. It reports false if one is already running.
func (u *Updater) CheckAsync(then func(*Release)) bool {
	if !u.begin() {
		return false
	}
	go func() {
		defer u.end()
		rel, err := u.Check()
		if err == nil && then != nil {
			then(rel)
		}
	}()
	return true
}

// DownloadAsync fetches the release found by the last check.
func (u *Updater) DownloadAsync(then func(error)) bool {
	rel := u.Latest()
	if rel == nil {
		u.set(UpdateProgress{State: "error", Message: "Check for updates first"})
		return false
	}
	if !u.begin() {
		return false
	}
	go func() {
		defer u.end()
		err := u.Download(rel)
		if then != nil {
			then(err)
		}
	}()
	return true
}

// AutoRun is the automatic path: check, and if there's something newer,
// fetch it and install it without asking. The person opted into this in
// settings; the alternative - a prompt - is what happens when they didn't.
func (u *Updater) AutoRun() {
	u.CheckAsync(func(rel *Release) {
		if rel == nil || !rel.Newer || rel.AssetURL == "" {
			return
		}
		u.DownloadAsync(func(err error) {
			if err == nil {
				_ = u.Install()
			}
		})
	})
}

// today is the date the daily check is keyed on. Local time, because "the
// first time you open it today" means the user's today.
func today() string {
	return time.Now().Format("2006-01-02")
}

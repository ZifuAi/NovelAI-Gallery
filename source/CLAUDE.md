# NovelAI Gallery — working notes for Claude Code

Read this first. It is the context you would otherwise have to rebuild by
reading the whole tree.

## What this is

A fully local Windows app (Go + WebView2, ~2.6 MB installer) plus a
Brave/Chrome MV3 extension. The extension catches images generated on
NovelAI along with the prompt metadata embedded in their PNGs; the app is
a searchable gallery for them, and can hand an image back to NovelAI to
reuse its prompt.

Current version: **Build 1.1** (Build 1.0 is the released one).
Repo it updates from: `https://github.com/ZifuAi/NovelAI-Gallery`

## Layout

```
app/            Go app. ./build.sh builds the .exe and installer.
  main.go         startup, data dir, extension unpacking, appVersion
  server.go       loopback HTTP layer + the whole JSON API
  store.go        records, search, filtering, settings, atomic saves
  folders.go      folder tree: nesting, reordering, tags
  undo.go         undo/redo stack + the trash behind deletes
  nsfw.go         decides what counts as explicit, from the prompt
  update.go       GitHub releases check, download, install
  png.go          reads NovelAI's embedded PNG metadata
  installer.nsi   NSIS installer (upgrades in place)
  third_party/    vendored go-webview2, so builds need no network
ui/             The interface. Plain HTML/CSS/JS, no build step.
  app.js          ~3300 lines, everything
  index.html      all markup including every modal
  styles.css      themes as CSS variables
  prompt.js       parses NovelAI prompt shapes into sections
extension/      MV3 extension (background.js, content.js, inject.js)
tests/          Go tests live in app/; browser suites live here
docs/           MANUAL.md (full feature docs), HANDOFF.md (what is next)
README.md       Short, for the GitHub page. The long one is docs/MANUAL.md.
```

`ui/` and `extension/` are copied into `app/web` and `app/extension` by
`build.sh` and compiled into the binary with `go:embed`. **Editing `ui/`
alone changes nothing until you rebuild** — that has cost real debugging
time more than once.

`app/web` and `app/extension` are generated and not checked in. On a fresh
clone nothing compiles — not even `go test` — until they exist, because the
failure is at the `go:embed` directive rather than in a test. Run
`./tests/run.sh` (which syncs them first) or `cd app && ./build.sh` before
anything else.

## Building

```bash
cd app && ./build.sh              # needs Go 1.24+; makensis for the installer
```

Cross-compiles from Linux:
```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-H windowsgui -s -w"
```

`RCEDIT=/path/to/rcedit.exe` stamps the icon and version info (run under
wine on Linux). Check afterwards that resource types 3, 14 and 16 are
present in the .exe — rcedit fails silently under wine, and a build once
shipped with a generic icon because of it.

**Never leave `app/novelai-gallery` (the Linux binary) in the tree.**
`go build ./...` drops it there, `build.sh` copies the directory into the
bundle, and a release once went out 10 MB heavier for exactly that reason.

## Testing

```bash
./tests/run.sh                    # everything
./tests/run.sh folderui           # one suite
```

Go tests are in `app/*_test.go` and run with `-race`. The browser suites in
`tests/` use Playwright + a headless build of the real app; each starts its
own copy with a throwaway data directory, seeds it with generated PNGs
carrying real NovelAI metadata, and drives the actual interface.

One rule earned the hard way: **drive the UI, not the API.** An earlier
suite created folders by calling `POST /api/folders`, and so never noticed
that the New Folder button called a `createFolder()` that did not exist.
Every folder in the app was un-creatable and the tests were green.

## Things that are the way they are for a reason

- **The HTTP layer is embedded and loopback-only.** It binds the first free
  port from 8756 up; the extension probes the same range and refuses any
  address that is not on this machine. There is no separate backend and the
  user does not want one.
- **Download interception is scoped to NovelAI hosts only**, by URL,
  referrer, or the origin inside a `blob:` URL.
- **Undesired content is never read as evidence by the NSFW classifier.**
  It lists what the user asked the model to *avoid*, so scanning it would
  flag precisely the people trying hardest to avoid explicit output.
- **Explorer's `/select,` needs quotes around the path only**, not the whole
  argument — hence `SysProcAttr.CmdLine` and `explorerSelectCmdLine`.
- **The window icon is set with `ExtractIconExW` + `WM_SETICON`**, because
  the webview class loads `IDI_APPLICATION` and rcedit files the icon under
  resource id 0.
- **`Store.List` takes a write lock**, not a read lock: it memoises search
  text into the records it walks.
- **Cards are reconciled on one `badgeKey()` fingerprint.** It used to be
  written in `card()` and compared in `render()`, the two drifted, and NSFW
  covers rebuilt on every refresh. One function, used by both.
- **`patchRecord(id, patch)` updates every copy of a record** — the list,
  the open image, the details panel. They are separate objects once a
  background refresh has replaced the list, and patching only the list is
  what made the NSFW switch appear stuck.
- **No `window.prompt` / `window.confirm`.** They ignore the theme. Use
  `askText()` and `confirmDialog()` in `ui/app.js`.

## Constraints from the user

- Everything stays on the machine. No accounts, no cloud, nothing running
  in the background.
- Be honest about what is verified versus reasoned. There was no Windows
  machine and no logged-in NovelAI account in the sessions that built this,
  so the title bar, window icon, Explorer integration, the installer, and a
  real end-to-end update are all *untested* — say so rather than implying
  otherwise.
- Version scheme: Build 1.0 and 1.1 released, **Build 1.2.0 current**.
  `appVersion` in `app/main.go` and `APP_VERSION` in `app/installer.nsi`
  must match, and `defaultModel` in `app/novelai.go` must match
  `GEN_DEFAULT_MODEL` in `ui/generate.js` (a test enforces it).

## Build 1.2.0 — what landed

- Automatic updates from GitHub's public releases API (no server of any
  kind), plus **Install Latest** in Settings ▸ About, which reinstalls
  whatever is published now even when it is not newer than this build.
- Thumbnails (640px JPEG cache) for gallery speed.
- Rebrand to **NovelAI Tools** with three tools: Image Generation, Gallery,
  Prompt Generator.
- Prompt Generator: Danbooru-preferring pools, scenes, series characters,
  tags↔prose slider, presets, collapsible groups.
- Image Generation against NovelAI's official API: V5/V4.5 models,
  characters with positions, img2img, inpainting with a mask painter, an
  import dialog matching NovelAI's, Anlas balance and per-generation cost.

Known-good as of the last run: 299 checks across the seven suites in
`tests/`, all passing.

## What to do next

- Vibe Transfer and Precise Reference are deliberately greyed out — they
  are the obvious next features in the generator.
- Still *unverified here*: the title bar, window icon, Explorer
  integration, a real end-to-end update against the real repo, and any real
  NovelAI generation. The installer itself has been run under wine (fresh
  install and in-place upgrade).

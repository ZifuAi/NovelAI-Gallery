# NovelAI Gallery

A local gallery for your NovelAI images and their prompts. Everything stays
on your PC — no account, no cloud, nothing to run in the background.

## Install

Run **`NovelAI-Gallery-Setup.exe`** (2 MB). It installs for your user only,
so there's no admin prompt, and it adds Start-menu and desktop shortcuts.

The first time you open it, a short setup walks through the things worth
deciding once — theme, how prompts read, what gets saved — and finishes on
the one step that matters: installing the browser extension, which is what
actually fills the gallery. Every choice is applied as you make it, and all
of them live in Settings afterwards. Skip it with the × if you'd rather not.

Uninstalling asks whether to delete your images and settings too. Answer
**No** and the library survives for a reinstall; answer **Yes** and nothing
is left behind.

> Windows SmartScreen will warn you the first time, because the installer
> isn't code-signed (certificates are a paid yearly thing). Click
> **More info → Run anyway**.

Your images and settings live in `%APPDATA%\NovelAI Gallery`. Uninstalling
deliberately leaves them alone.

### The title bar

Windows draws the caption, not the page, so a themed app with a stock
white title bar looks half-finished. The app hands its theme colours to
the desktop window manager, which colours the caption, its text and the
window border to match. This keeps the real minimise/maximise/close
buttons and everything that comes with them — snap layouts, keyboard
handling, accessibility — rather than reimplementing them badly.

Windows 11 takes the exact colours. Windows 10 has no caption-colour
setting, so there it only follows light/dark, which at least avoids a
white bar above a dark app.

### Why it's small

It uses the Edge WebView2 runtime already built into Windows 10 and 11
rather than bundling a whole browser engine, so the installer is 2 MB
instead of ~80 MB. If WebView2 is ever missing, the app says so and points
you at Microsoft's free runtime installer.

## Using it

**Search** covers every part of a prompt — the base prompt, each
character's prompt, undesired content and per-character undesired content —
plus seeds, models, samplers, filenames and your own notes. Clicking any prompt
tag searches for that tag.

**Favorites / Pinned / Folders** are in the left sidebar; pinned images
float to the top of every view. **Drag images straight onto a folder** to
file them there — drag one, or drag any card that's part of a selection to
move the whole lot. Favorites and Pinned accept drops too.

**Layout** (top right) switches between four gallery styles:

| Layout | What it's for |
|---|---|
| Grid | Even tiles, one size, easy to scan |
| Justified | Rows of equal height that fill the width, like a contact sheet |
| Waterfall | Columns of varying height, nothing wasted on tall or wide images |
| List | One row per image with prompt, model, size, seed and date |

Images are shown **whole** in every layout, and in the large view — nothing
is cropped to fit a square. Opening an image sizes the window to that
picture's own proportions, so a tall image isn't stranded in a wide black
box and a wide one gets no letterbox it didn't need.

**Sort** by newest, oldest, prompt A–Z, model A–Z, or largest/smallest.
Whatever you pick, pinned images stay at the top.

**The zoom slider** (top right) resizes thumbnails live — it sets the row
height in justified view and the column width in waterfall.

**The details panel** on the right shows the selected image's prompt and
settings inline. Clicking an image still opens the large view as well.

**Right-click** anything for the actions that apply to it: an image offers
open, select, move to a folder, pin, favorite, reuse, copy prompt, open in
folder and delete; a folder in the sidebar offers open and delete; the
gallery background offers import, refresh, select all and new folder.
Right-clicking one image of a selection acts on the whole selection.

**The expand button** in the bottom-left corner of the large view opens the
picture full-window, where scrolling zooms, dragging pans, double-click
toggles fit and 100%, and **Back** returns. `F` opens it, `0` fits, `1` is
actual size, `Esc` goes back.

**Prompt sections start collapsed** — an image can carry four of them and a
hundred tags, and expanded by default that buries the generation settings.
The count on each header tells you what's inside.

**Prompts render as tags** by default — split on commas and periods,
grouped into collapsible sections: base prompt, per-character prompts,
undesired content, and per-character undesired content. Clicking a tag
searches for it. Settings → *How prompts are shown* switches this to plain
text boxes instead, one per section, if you'd rather select and copy a
whole prompt in one go.

**Open in folder** (in the large view) shows the picture in File Explorer
with the file selected. Every captured image — including one saved with
"keep saved images here" — is an ordinary `.png` in
`%APPDATA%\NovelAI Gallery\gallery-storage\images`, and the large view
prints that path under the metadata; click it to copy.

**Import** (arrow icon, top right) adds PNGs by hand — or just drag files
anywhere onto the window. Prompt and settings are read from each file the
same way as an automatic capture.

**Reuse prompt in NovelAI** (in the large view) hands the image to an open
NovelAI tab exactly as if you'd dragged the file in, so NovelAI reads the
prompt and settings back out of it. The button reports what actually
happened — delivered, no tab open, or refused — rather than just claiming
success, and names the element that took the file.

**Deleting.** Hover any image for pin / favorite / delete buttons; the
large view has a delete button too, and Delete on the keyboard works on
whatever is open or selected. The **select** button (tick icon in the top
bar) turns on multi-select — click images to tick them, shift-click for a
range, Ctrl+A for everything — then use the bar at the bottom to pin,
favorite, move to a folder or delete the lot at once. Every delete asks
first and says exactly how many images are going.

**Clear the whole gallery** lives at the bottom of Settings. It tells you
how many images it's about to delete, keeps your folders and settings, and
never touches copies you saved elsewhere on your PC.

**Settings** (gear icon) holds 10 dark + 10 light themes, the extension
setup button, and the capture mode:

- *Only save images as I generate them* (default) — new generations land
  here; your existing history is left alone.
- *Save everything, including my existing history* — also imports the
  backlog the first time it runs.
- *Only save images I save or download* — nothing is saved automatically;
  a copy lands here whenever you save an image, either with NovelAI's own
  save button or with the browser's right-click → **Save image as**. Your
  download still goes to your Downloads folder as normal.

There's also a **Keep saved images here instead of downloading them**
switch. With it on, saving an image on NovelAI files it in the gallery and
writes no file at all. A save from the page itself is stopped before the
browser starts anything — no dialog, no file. A download the browser began
on its own (right-click → Save image as) can only be undone after the fact,
so it is cancelled and cleared from the downloads list once the image is
safely stored; if your browser is set to *ask where to save each file*,
that dialog still appears first, because extensions get no say before it.
Only NovelAI downloads are ever touched.

Right-clicking any image on NovelAI → **Save image to NovelAI Gallery**
always works, in any mode. The extension popup also has a **Stop/Start
automatic saving** switch and an **Import NovelAI history now** button.

### Supported sites

Every NovelAI image page the extension knows about is covered; the exact
host patterns are in `extension/manifest.json` if you ever need to check
or extend them.

## If images aren't showing up

The extension now has five independent ways of catching images, and a
Diagnostics panel so a failure can be read rather than guessed at.

1. Open a NovelAI tab and **reload it once** after installing the
   extension (content scripts only attach on page load).
2. Click the extension's toolbar icon. It tells you two things directly:
   whether the gallery app is reachable, and whether the extension is
   actually running on your NovelAI tab.
3. Press **Import NovelAI history now**. This reads what NovelAI has
   already stored in your browser, so it works on images generated before
   you ever installed this.
4. If it's still empty, open **Diagnostics**, hit **Copy diagnostics**, and
   send me that. It reports which strategies fired, how many records were
   read from NovelAI's storage, and any error.

### How capture works

Six strategies, so no single site change breaks everything:

| Strategy | Depends on |
|---|---|
| IndexedDB history scan | only that images are in browser storage — the sturdy one |
| fetch interception | the site using `fetch` |
| XHR interception | the site using `XMLHttpRequest` |
| DOM scan | images being displayed on the page |
| download watcher | you saving an image, by any route |
| save-picker hook | the site using `showSaveFilePicker` |

**On catching a save.** Right-click → *Save image as* is a browser action:
no click handler fires, no anchor is involved, and a content script cannot
see it at all. The only place it shows up is the browser's downloads list,
so that is what the extension watches — which catches NovelAI's own save
button too, since that ends up in the same list. What it sees for a
generated image is usually a `blob:` URL, readable only by the page that
made it and often revoked immediately, so the page keeps the last few
blobs alive for exactly this lookup. The scope is deliberately narrow: a
download has to come from NovelAI, by its own URL, its referrer, or the
origin inside a `blob:` URL, or it is ignored entirely.

The IndexedDB scan searches records *structurally* — it looks for PNG bytes
wherever they sit in a stored record, rather than relying on field names I
can't verify. It handles Blobs, ArrayBuffers nested inside objects, and
base64 data-URL strings, all of which I tested.

### How "reuse prompt" delivers a file

Dispatching dragenter/dragover/drop back to back works on some builds of
the site and not others, and the reason is timing rather than aim: a build
that mounts its import overlay *in response to* a drag starting never sees
a drop fired in the same tick, because nothing is listening yet.

So the extension now announces the drag first, gives the page several real
frames to react, then re-aims at whatever is under the cursor by then and
drops there — following open shadow roots to find the deepest element, so
the event bubbles past every handler on the way up. If that's refused it
tries named drop containers, then any file input, then a paste. Only a
`preventDefault` on the **drop itself** counts as success: a page that
merely blocks the browser's default file handling on dragover hasn't taken
the file, and saying otherwise would be a lie.

Delivery also targets the top frame explicitly. Without that, the message
goes to every frame at once and whichever answers first wins — a coin toss
on any page carrying a third-party iframe.

### Still unverified

I have no logged-in NovelAI account, so I can't confirm which network
request returns a generated image, or the exact V4 character-prompt field
names in `ui/prompt.js`. Both fail soft — if a guess is wrong, the other
strategies still work, and for the prompt fields you'd still get the base
prompt and undesired content, just not the per-character split.

## Layout

```
novelai-gallery/
  app/          The Windows app (Go + WebView2). ./build.sh rebuilds it.
    main.go       startup, data dir, extension unpacking
    server.go     local HTTP layer + JSON API
    store.go      storage, search, folders, settings
    png.go        reads NovelAI's embedded PNG metadata
    installer.nsi the installer script
    third_party/  vendored Go deps, so builds need no network
  ui/           The gallery interface (plain HTML/CSS/JS, no build step)
  extension/    The Brave/Chrome extension
```

`ui/` and `extension/` are compiled into the .exe, and the app unpacks the
extension to `%APPDATA%\NovelAI Gallery\extension` on launch so the browser
has a real folder to load.

The app has a small HTTP layer bound to `127.0.0.1` only, so the extension
has somewhere to hand images to. It's part of the app process — not
something you install or expose to the network. It takes the first free
port from 8756 up and the extension probes that same range, so a port
conflict can't quietly break anything. The extension refuses any address
that isn't on this machine.

### Building

```
cd app && ./build.sh
```

Needs Go 1.24+. Add `makensis` for the installer, and optionally set
`RCEDIT=/path/to/rcedit.exe` to stamp the icon.

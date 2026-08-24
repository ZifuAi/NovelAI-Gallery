# NovelAI Gallery

A local gallery for your NovelAI images and their prompts. Everything stays on
your PC — a small Windows app plus a browser extension that feeds it.

<!-- Add a screenshot at docs/screenshot.png and uncomment:
![NovelAI Gallery](docs/screenshot.png)
-->

## Features

- Saves every image you generate, automatically
- Keeps the prompt, seed, model and settings with each one
- Search every part of the prompt, including character prompts
- Four layouts: grid, justified, waterfall and list
- Nested folders you can rename, tag and drag around
- Colour labels on individual images, with a filter to match
- Undo and redo for anything that changes your library
- Favorites and pins — drag images to file them
- Explicit images blurred behind a Reveal button, with a switch to turn it off
- Send an image back to NovelAI to reuse its prompt
- Full-size view with zoom and pan
- Right-click menus, multi-select and bulk actions
- Import your own PNGs by dragging them in
- Updates itself from this page's releases, if you let it
- 20 themes, dark and light
- Images stay ordinary `.png` files you can open and back up

## Install

**1.** Download `NovelAI-Gallery-Setup.exe` from the
[latest release](../../releases/latest) and run it.

> SmartScreen will warn you because the installer isn't code-signed. Click
> **More info** → **Run anyway**. No admin prompt.

**2.** Open the app and follow the setup it shows you.

**3.** Install the browser extension. It isn't on the Chrome Web Store, so it
loads from a folder:

1. In Brave, Chrome or Edge, open the Extensions page
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose:
   ```
   %APPDATA%\NovelAI Gallery\extension
   ```

**4.** Reload your NovelAI tab, then generate something. It'll appear in the
gallery within a few seconds.

## Updates

The app checks this page's releases once a day and offers the new build in the
corner of the window. Say yes and it downloads the installer, installs it,
reopens itself and shows you what changed. **Settings ▸ About** has a manual
**Check for updates** button and a switch to make it automatic.

Nothing is downloaded until you agree, and there is no server involved —
it reads this repository's releases directly.

## Where your images go

```
%APPDATA%\NovelAI Gallery\gallery-storage\images
```

The large view has an **Open in folder** button that takes you straight to any
image. Uninstalling asks whether to delete your library or keep it.

## Requirements

- Windows 10 or 11
- Brave, Chrome or Edge
- [Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
  (already on most Windows installs)

## Not working?

Click the extension's toolbar icon. It tells you whether the app is reachable
and whether the extension is running on your NovelAI tab. **Copy diagnostics**
in that popup gives you something to paste into an issue.

## Building

```bash
cd app && ./build.sh          # needs Go 1.24+; makensis for the installer
./tests/run.sh                # Go tests + the browser suites
```

## More

- [`docs/MANUAL.md`](docs/MANUAL.md) — every feature in detail, and how the
  capture strategies work
- [`docs/HANDOFF.md`](docs/HANDOFF.md) — project state and what is next
- [`CLAUDE.md`](CLAUDE.md) — conventions and the traps worth knowing

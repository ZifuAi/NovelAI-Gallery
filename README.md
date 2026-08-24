
# NovelAI Gallery

A local gallery for NovelAI images and prompts. Images are saved automatically with full metadata (prompt, seed, model, sampler, etc.) so you can search, organise, and reuse them.

No account, no cloud, nothing running in the background. Small Windows app + browser extension.

<img width="1166" height="739" alt="Screenshot 2026-08-24 170221" src="https://github.com/user-attachments/assets/080266fb-df7d-40fc-b558-057b59e6f5c5" />

## Features

- Auto-saves every generation with prompt + settings baked into the PNG
- Full-text search (prompt, character prompts, UC, model, seed, notes, filename)
- 4 layouts (grid, justified, waterfall, list) + sorting
- Folders, favorites, pins, multi-select
- One-click “Reuse prompt in NovelAI”
- Full-size viewer with zoom/pan
- Manual import (drag & drop or file picker)
- 20 themes
- Files stay as normal PNGs — nothing locked in a database

## Requirements

- Windows 10/11
- Chromium browser (Chrome, Edge, Brave)
- Edge WebView2 (usually already installed)

## Install

1. Download `NovelAI-Gallery-Setup.exe` from the [latest release]((https://github.com/ZifuAi/NovelAI-Gallery/releases)) and run it (~2.4 MB, per-user, no admin). 
2. Complete the short first-run setup.
3. Load the extension (unpacked):
   - Path: `%APPDATA%\NovelAI Gallery\extension`
   - Go to `chrome://extensions` → enable Developer mode → **Load unpacked** → select that folder
   - Reload your NovelAI tab
4. Generate something — it should appear within a few seconds.

Click the extension icon to check connection status or import previous history.

## Locations

| Item       | Path                                        |
|------------|---------------------------------------------|
| Images     | `%APPDATA%\NovelAI Gallery\gallery-storage` |
| Settings   | `%APPDATA%\NovelAI Gallery\settings.json`   |
| Extension  | `%APPDATA%\NovelAI Gallery\extension`       |
| App        | `%LOCALAPPDATA%\Programs\NovelAI Gallery`   |

## Troubleshooting

- Reload the NovelAI tab after installing the extension
- Check the extension popup for connection status
- Use **Import NovelAI history now** for older images
- Still empty? Open Diagnostics → Copy diagnostics → open an issue

## How it works

Small Go + WebView2 app (~2.4 MB). Local HTTP only on `127.0.0.1`. Extension captures images via multiple methods (history, network, DOM, downloads).

## Build from source

```bash
cd app && ./build.sh

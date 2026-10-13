# OmePilot

Ome.tv autopilot userscript: country skip, face/gender filters, auto-greet, and a face-snap gallery.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or any userscript manager).
2. Create a new userscript and paste the contents of [`omepilot.user.js`](omepilot.user.js).
3. Save, then open [ome.tv](https://ome.tv) and hit **Start**.

## Features

- **Country auto-skip** — pick blocked countries from the list (Albania, Greece, …) or add any custom 2-letter code (e.g. `XK`). The live country badge is shown in the console and the on-screen panel.
- **Face / gender filters** — auto-skip males, no-face feeds, frozen cameras, and black screens.
- **Female auto-greet** — sends your custom message (default `hi`) when a female is detected, with optional auto-pause.
- **Peace-sign skip** — ✌️ detection via MediaPipe.
- **Face-snap gallery** — Save Mode captures faces with country flags, chat text, and one-click / bulk download.
- **Video layout tools** — drag, resize, and persist your local/remote camera positions.
- **Hotkeys** — skip/start (`d`), stop (`s`), pause/resume (`x`), all remappable.

## Screenshots

### Block countries
![Block countries](screenshots/block-countries.png)

### Settings
![Settings](screenshots/settings.png)

### Save faces instantly into the gallery
![Gallery](screenshots/gallery.png)

## Notes

- Runs on `ome.tv` via Tampermonkey.
- Detection models load from CDN on first run (needs internet).
- If the page feels slow, disable Peace detection first — it's the heaviest filter.

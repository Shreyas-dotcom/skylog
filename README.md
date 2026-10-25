# Skylog ✈️

A private, offline flight log. It's one HTML file with your flights on a map, stats about your flying, and checks that catch mistakes in your log. No account, no server, no install. Your data never leaves your computer.

Works great with a **myFlightradar24 export**: import the CSV and your whole history shows up.

## Get started
1. Download [`dist/Skylog.html`](dist/Skylog.html) (click **Download raw file**).
2. Double-click it. It opens in your browser and works offline.
3. Click **Import** and pick your myFlightradar24 CSV (export it from your my.flightradar24.com account settings), or add flights by hand.

**Optional, Windows:** to open Skylog in its own app window from a Desktop icon, clone or download this repo, then right-click [`tools/make-shortcut.ps1`](tools/make-shortcut.ps1) and choose **Run with PowerShell**.

## Features
- **Map and globe** with great-circle routes. The flat map centers itself on *your* routes so long-haul arcs aren't split at the edge, and dragging spins the world. You can color routes by how often or how recently you flew them, and clicking a route or airport filters everything.
- **Replay**: animates every flight in order, with a running distance counter. On the globe, the camera follows the plane.
- **Year in review**: pick a year for its new airports, countries, airlines and aircraft, plus the change from the previous year.
- **Data health**, rechecked on every change:
  - logged duration vs. the local times converted through each airport's time zone
  - impossible block speeds
  - overlapping flights and impossible hops between flights
  - return legs that were logged as a copy of the outbound
  - duplicates and unknown airports

  Many findings have a one-click fix, and everything can be undone (Ctrl+Z).
- **Journeys**: legs joined by connections within 24 h, showing door-to-door time and how far each trip was from a direct route.
- **Stats**: records (longest, farthest north…), activity heatmap, seat, class, alliance and aircraft breakdowns, tail numbers, and a rough CO₂ estimate.
- **Achievements**: Moonshot, Time traveller, Superjumbo, Five continents, and more.
- Airport autocomplete with distance and expected flight time. Duration fills in automatically from local times and time zones. Custom airports can be added.

## Your data
- Everything is saved in your browser's local storage, on your machine only.
- Click **Set up backup file** (Chrome/Edge) to also mirror every change to a JSON file you choose. If browser data is cleared, Skylog restores itself from that file.
- **Export** saves your log as myFlightradar24-compatible CSV or a full JSON backup. **Import** merges new flights in, skipping duplicates.

## Building from source
Requires Node 18+. There are no dependencies to install.

```
node tools/build.mjs --clean   # -> dist/Skylog.html (empty, shareable)
node tools/build.mjs           # -> Skylog.html, pre-loaded from data/seed.csv if present (git-ignored)
```

`public/` holds the source (vanilla JS modules, with D3 for the map). `tools/build.mjs` inlines it, the libraries in `vendor/`, and the world map into a single file. To pre-load your own flights into a personal build, put your export at `data/seed.csv`. Both `data/` and the personal `Skylog.html` are git-ignored.

## License
MIT. Bundled third-party files are listed in [`vendor/NOTICE.md`](vendor/NOTICE.md).

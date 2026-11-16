# Skylog ✈️

A private flight log you host yourself on GitHub Pages. It shows a world map of every route you've flown, colored by how often, plus statistics about your flying and a checker that catches mistakes in your log. **Your log is encrypted in your browser with your password, so only you can read it**, even though the site and repository are public.

Works great with a **myFlightradar24 export**: import the CSV and your whole history shows up.

## Set up your own (about 5 minutes)
1. **Fork** this repository, or create a new public repo and upload `index.html`.
2. In the repo, go to **Settings → Pages**, set **Source: Deploy from a branch**, branch `main`, folder `/ (root)`, and click **Save**. Your site will be at `https://<your-username>.github.io/<repo>/`.
3. Create a **fine-grained access token** at <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: *Only select repositories* → your Skylog repo
   - Permissions → Repository → **Contents: Read and write**
4. Open your site. Choose a password, paste the token, and optionally pick your myFlightradar24 CSV. That's it.

On any other device, open the same URL and enter your password.

## How your data is protected
- The whole log is encrypted **in your browser** with AES-256-GCM, using a key derived from your password (PBKDF2-SHA256, 600,000 iterations). Only that ciphertext is saved, as `vault.json` in your repo. GitHub, visitors to your site, and anyone browsing the repo see random bytes.
- Without the password, the site shows only a lock screen. **There is no password reset**, so keep the password in a password manager.
- The GitHub token is stored *inside* the encrypted log, so it is never visible either. It can only write to this one repository.
- **What is public:** that a log exists, roughly how large it is, and when you saved changes (commit times). Use a strong password. Since the encrypted file is public, a weak password could be guessed offline.

## Why it doesn't lose data
- Every save is a git commit, so every version of your log is kept in the repo's history and can be restored.
- Changes are kept, encrypted, on your device until GitHub confirms the save. If you're offline or close the tab, nothing is lost: they upload next time.
- If two devices edit at the same time, Skylog notices and asks which version to keep instead of silently overwriting.
- **Menu → Export** gives you a myFlightradar24-compatible CSV or a full JSON backup at any time.

## Features
- **Map** in a classic road-map style, with great-circle routes colored by times flown and pins on every airport. Dragging spins the world, and there's also a **globe** view.
- **Replay** animates your flights in order.
- **Stats**: totals (flights, distance, time, CO₂), class, seat, reason and continent breakdowns, plus top airports, airlines, aircraft, routes and countries. Click ↗ on a card for a full comparison chart by flights, distance or time. Flights are also charted per year, month and weekday. **Select a year** to see just that year.
- **Data check** compares logged durations against local times and time zones, and flags:
  - impossible speeds
  - overlapping flights
  - return legs logged as a copy of the outbound
  - duplicates

  Many findings have a one-click fix, and Ctrl+Z undoes.
- Airport autocomplete. Duration is filled in from local times and time zones. Custom airports can be added.

## Offline / local use
`index.html` also works on its own: download it and double-click. Opened that way (not on GitHub Pages), it stores the log in that browser instead, without a password. On Windows, [`tools/make-shortcut.ps1`](tools/make-shortcut.ps1) adds a Desktop icon that opens it in its own window.

## Building from source
Requires Node 18+. There are no dependencies to install.

```
node tools/build.mjs --clean   # -> index.html (the published site, no flights)
node tools/build.mjs           # -> Skylog.html: offline copy pre-loaded from data/seed.csv (git-ignored)
node tools/build.mjs --test && node tools/mock-github.mjs   # try hosted mode locally: http://127.0.0.1:5199/app/
```

`public/` holds the source (vanilla JS modules, with D3 for the map). `tools/build.mjs` inlines it, the libraries in `vendor/`, and the world map into one file.

## License
MIT. Bundled third-party files are listed in [`vendor/NOTICE.md`](vendor/NOTICE.md). Not affiliated with Flightradar24.

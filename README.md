# ghost radio

A minimal browser radio player for streaming ambient, dub, and underground
radio stations. No build step, no framework — static HTML/CSS/JS.

Live at [radio.renderg.host](https://radio.renderg.host).

## Run locally

Serve the folder with any static file server, e.g.:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Controls

- Play/Stop, Previous, and Next transport buttons cycle through all
  configured stations (wraps around at either end)
- Keyboard shortcuts: `Space` to play/stop, `←`/`→` to change station
- A live frequency visualizer runs while playing, using the Web Audio API.
  Most streams don't send CORS headers, so the player first tries a
  CORS-enabled load (needed for the analyser to read audio data) and
  silently falls back to plain playback — audio still plays, but the bars
  stay flat — if that fails
- Media Session integration for OS/lock-screen/hardware media controls

## Stations

Edit `stations.json` in the project root. Each entry has a `title`, a direct
`streamUrl`, and an optional `location` (shown under the station name):

```json
{ "title": "Station Name", "streamUrl": "https://example.com/stream.mp3", "location": "City, Country" }
```

There's no fixed limit on the number of stations — the transport buttons
cycle through however many are listed, and the display shows the current
position (e.g. "3 of 14"). Direct MP3/AAC Icecast/Shoutcast streams play via
a plain `<audio>` element; some HLS (`.m3u8`) streams are included and play
in browsers with native HLS support (e.g. Safari) but are not guaranteed to
work everywhere.

## Display mode

Light / dark / system, toggled in the UI and remembered in `localStorage`.
System follows the OS colour scheme automatically.

## Architecture

- `index.html` — structure, plus Open Graph/Twitter card metadata
- `styles.css` — all styling, theme colours as CSS custom properties on `:root`
  and `html[data-theme="dark"]`
- `app.js` — a single `state` object plus a `render()` function; no framework,
  no build step. Intended to be easy to extend by hand.
- `stations.json` — the station list
- `CNAME` — custom domain for GitHub Pages

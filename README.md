# ghost-radio

A minimal browser radio player. No build step, no framework — static HTML/CSS/JS.

## Run locally

Serve the folder with any static file server, e.g.:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Stations

Edit `stations.json` in the project root — up to 10 entries, each with a `title`
and a direct `streamUrl`. First version targets direct MP3/AAC Icecast/Shoutcast
streams (plain `<audio>` playback); HLS is not supported yet.

```json
{ "title": "Station Name", "streamUrl": "https://example.com/stream.mp3" }
```

Stations map in order to the 10 preset buttons. Fewer than 10 entries leaves the
remaining presets empty and disabled.

## Display mode

Light / dark / system, toggled in the UI and remembered in `localStorage`.
System follows the OS colour scheme automatically.

## Architecture

- `index.html` — structure
- `styles.css` — all styling, theme colours as CSS custom properties on `:root`
  and `html[data-theme="dark"]`
- `app.js` — a single `state` object plus a `render()` function; no framework,
  no build step. Intended to be easy to extend by hand.

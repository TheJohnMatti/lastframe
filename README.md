# lastframe

A local-first watch tracker with a player that wraps embeddable players from sites you choose.

Search a movie or show, press play, and lastframe remembers where you are: which episode, how far in, what's next. Those embed sites go down all the time, so every title has a list of fallbacks. Unreachable sites are skipped, a player that never loads is dropped, and lastframe remembers which source worked for each title.

There's no account and no server. Your history lives in your browser.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5178. The port is fixed on purpose, because your library is stored per origin.

## Sources

lastframe ships with **no streaming sources**. You add the sites you use. Each source is a URL template for a site's embeddable player:

```
https://{host}/embed/movie/{imdb}
https://{host}/embed/tv/{imdb}/{season}/{episode}
```

| Variable | Value |
| --- | --- |
| `{host}` | each mirror in the source's hosts list, tried in order |
| `{imdb}` / `{tmdb}` | the title's IMDb or TMDB id |
| `{season}` / `{episode}` | episode numbers |
| `{t}` | seconds to resume from, for sites that accept a start time |
| `{type}` | `movie` or `tv` |
| `{title}` / `{slug}` / `{year}` | for sites that use names in URLs |

You can add sources in three ways:

- **Sources page**: add, reorder, enable and disable sources. Each one shows a preview URL and whether its hosts are reachable.
  You rarely need to write a template by hand. Under **Fill in from an example**, paste the site's player address for *The Dark Knight* and for *Breaking Bad* S3E7. lastframe turns the ids, season and episode numbers and any start-time parameter into placeholders, and adds the domain as a host. If a site keeps changing domains, list the others under Hosts and they're tried in order.
- **`public/sources.local.json`**: gitignored. Its contents are loaded on first run, or again from the Sources page. The format is in [`sources.example.json`](sources.example.json).
- **Import JSON**: load a list you keep somewhere private.

To try lastframe without a real source, use the demo source in `sources.example.json`. It points at `public/demo/player.html`, a stand-in player that plays nothing but reports its time the way real embeds do.

### How fallback works

1. Sources are tried in this order: the one that last played this title, then the one that last played anything, then your list order. Sources that failed on this title go last.
2. Every host is probed when the player opens. Hosts that don't answer (DNS failure, refused connection, timeout) are skipped. The result is cached for a few minutes.
3. A player that hasn't loaded after 20 seconds is dropped. You can change this in Settings.
4. **Not playing? Next source** skips every mirror of that source for this title and moves on.

The probe can tell that a site is up. It can't tell that a title plays there. That's what the button is for.

Sources are sandboxed by default, which blocks popups, new tabs and redirects out of the player. Turn the sandbox off for any site that refuses to play inside one.

## How tracking works

The page can't see inside another site's player, so lastframe gets your position in one of three ways:

- **Synced**: many embed players send playback events with `postMessage`. lastframe looks for a position and duration in any message from the player's frames, without knowing any particular site. When it finds them, tracking is exact.
- **Clock**: if a player is silent, lastframe starts a clock when you click into the player and counts from your last spot. Pause the clock when you pause the video. You can turn this off in Settings.
- **By hand**: ±1 or ±5 minutes, type a time, or mark watched.

At 90% of the runtime an episode counts as watched (you can change this in Settings), and the next one is offered. On a show's page you can tick episodes or use **up to here** to mark everything before an episode as watched. That's how you bring in what you've already seen.

Resuming passes your spot, minus a few seconds, to sources whose templates use `{t}`. For other sources, lastframe shows you where to seek.

## Your data

- History, watchlist, sources and settings are kept in `localStorage` for `localhost:5178`. A different browser or port starts empty.
- **Settings → Export backup** saves everything as JSON. Import merges into what's there (newer progress wins) or replaces it.
- Titles, posters and episode lists come from [Cinemeta](https://v3-cinemeta.strem.io/manifest.json), Stremio's free metadata service. It needs no API key.

## Build

```bash
npm run build     # static files in dist/, served from any path
npm run preview   # serve dist/ on the same port
```

## Disclaimer

lastframe hosts no media, links to no media, and comes with no streaming sources. It's a tracker and a frame. What you load into it is up to you, and so is following the copyright law where you live.

## License

MIT

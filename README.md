# lastframe

A local-first watch tracker for the video sites you choose.

Search a movie or show, press play, and lastframe opens it on one of your sites in a new tab. Its browser extension follows the video in that tab and remembers where you are: which episode, how far in, what's next. Press play again later and it resumes there. Sites go down all the time, so every title has a list of fallbacks, and lastframe remembers which source worked for each title.

There's no account and no server. Your history lives in your browser.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5178. The port is fixed on purpose, because your library is stored per origin.

To use it from your phone as well, start it with `npm run phone` instead (see [On your phone](#on-your-phone)).

## The browser extension

Pages can't see inside other sites' tabs, so the tracking is done by a small extension in [`extension/`](extension). Install it once in Chrome (or another Chromium browser):

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. Reload lastframe. **Settings → Browser extension** says when it's connected.

What it does:

- When you press play in lastframe, the extension opens the site in a new tab and remembers which title and episode that tab is for.
- A script in every frame of that tab, including the site's player frame, finds the long video that's playing and reports its position every 10 seconds, on pause, and when you leave. Previews and ads (anything under four minutes, or far shorter than the title) are ignored.
- On reopening, it waits for the real video to start, seeks to where you stopped (minus the rewind from Settings), checks the seek held, and offers a **Jump there** button if the player fights back.
- If you move to another episode on the site itself, it reads the new season and episode from the page's address (the source's template, run backwards) and carries on with that episode.
- At the watched point it offers **Up next** in the tab: one click opens the next episode on the same site and the same mirror.
- Its toolbar button shows what a tab is being tracked as. For a page you opened yourself, search the title there, pick the episode (it guesses from the page title) and click **Track this tab**; tick **Remember this page** and that page is tracked by itself next time. **Wrong title?** relinks a tab.
- It reports nothing for tabs lastframe didn't open or you didn't link, and keeps everything in your browser. lastframe's page reads the progress through a script that only runs on `localhost:5178`.

After pulling changes to `extension/`, press the reload arrow on its card in `chrome://extensions`. Without the extension, lastframe still opens sites in tabs; you set your place by hand.

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
| `{title}` / `{q}` / `{slug}` / `{year}` | for sites that use names in URLs (`{q}` has spaces as `+`, like most search boxes) |

You can add sources in three ways:

- **Sources page**: add, reorder, enable and disable sources. Each one shows a preview URL and whether its hosts are reachable.
  The easiest way to add a source is the **Grab for lastframe** bookmark on the Sources page. Drag it to your bookmarks bar once. On a site, open *The Dark Knight*, press play and click the bookmark, then do the same on *Breaking Bad* S3E7. The bookmark reads the players embedded in the page, including ones nested in frames and on pages that block right-click, and lastframe adds the source by itself.
  You rarely need to write a template by hand. Under **Fill in from an example**, paste the site's player address for *The Dark Knight* and for *Breaking Bad* S3E7. lastframe turns the ids, season and episode numbers and any start-time parameter into placeholders, and adds the domain as a host. If a site keeps changing domains, list the others under Hosts and they're tried in order.
- **`public/sources.local.json`**: gitignored. Its contents are loaded on first run, or again from the Sources page. The format is in [`sources.example.json`](sources.example.json).
- **Import JSON**: load a list you keep somewhere private.

To try lastframe without a real source, enable the demo source in `sources.example.json`. It turns itself off once you grab a real site. It points at `public/demo/player.html`, a stand-in player with a blank, silent 75-minute video that the extension follows like any other.

### Sites whose players use their own codes

Some sites address their players with per-title codes instead of the IMDb or TMDB id, so there's nothing to turn into a template. lastframe doesn't try to crack those. For such a site, search it for *The Dark Knight* and click the bookmark on the results page. The source then works in **search mode**: playing anything opens the site's own search for that title in a tab, you click the right episode there, and the extension still knows which title the tab is for.

### How fallback works

1. Sources are tried in this order: the one that last played this title, then the one that last played anything, then your list order. Sources that failed on this title go last.
2. Every host is probed when you open a title. Hosts that don't answer (DNS failure, refused connection, timeout) are passed over, unless nothing better is left.
3. **Didn't play? Next source** skips every mirror of that source for this title and moves on.
4. When the extension sees a title actually play on a source, that source goes first for the title next time.

You can still play a site inside lastframe (**Play it inside lastframe instead**). Many sites refuse to be shown inside another page, block logins there, or never finish loading, which is why tabs are the default. Sandboxed sources can't redirect lastframe's tab while playing inside it.

## How tracking works

- **In a tab, with the extension**: exact. See [The browser extension](#the-browser-extension).
- **Inside lastframe**: players that announce their time with `postMessage` are followed exactly; for silent ones a clock starts when you click into the player. You can turn the clock off in Settings.
- **By hand**: ±1 or ±5 minutes, type a time, or mark watched.

At 90% of the runtime an episode counts as watched (you can change this in Settings), and the next one is offered. On a show's page you can tick episodes or use **up to here** to mark everything before an episode as watched. That's how you bring in what you've already seen.

Resuming passes your spot, minus a few seconds, to sources whose templates use `{t}`, and the extension seeks there in any case.

## On your phone

Phones can't run browser extensions, so on a phone lastframe opens sites in a new tab and you set your place by hand (or play inside lastframe, where players that announce their time are followed). Your history, watchlist and sources are shared with the Mac either way.

1. On the Mac, start lastframe with `npm run phone`. It listens on your Wi-Fi as well as on `localhost`. If macOS asks whether node may accept incoming connections, allow it.
2. Open **Settings → Use it on your phone** on the Mac and scan the code with your phone's camera.
3. The phone opens lastframe already paired. Add it to your home screen if you like.

The Mac keeps one merged copy in `.lastframe/state.json` (gitignored), and every device sends its changes and takes the merge back every 30 seconds, on changes, and when you come back to the page. The newer change wins; a title you forget on one device is forgotten on all of them unless you watch it again afterwards. The code holds a key: devices on your network without it get nothing, and only the Mac itself can show the key. The phone has to be on the same Wi-Fi as the Mac.

## Your data

- History, watchlist, sources and settings are kept in `localStorage` for `localhost:5178`. A different browser or port starts empty, unless it's synced through `npm run phone` (settings stay per device).
- **Settings → Export backup** saves everything as JSON. Import merges into what's there (newer progress wins) or replaces it.
- Titles, posters and episode lists come from [Cinemeta](https://v3-cinemeta.strem.io/manifest.json), Stremio's free metadata service. It needs no API key.

## Build

```bash
npm run build     # static files in dist/, served from any path
npm run preview   # serve dist/ on the same port
```

## Disclaimer

lastframe hosts no media, links to no media, and comes with no streaming sources. It's a tracker and a launcher. What you load into it is up to you, and so is following the copyright law where you live.

## License

MIT

# main-site

What Vercel deploys, served at <https://rps.uwuapps.org>. No build step: the
files are served as they are, and `api/` holds the serverless functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The shared not-found page. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `css/theme.css` | The uwuapps theme, verbatim from `uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout, the hands, the picks and the replay. |
| `js/` | ES modules, below. |
| `api/` | The leaderboard API, below. |
| `images/` | Manifest screenshots, at the sizes `manifest.json` gives. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. `rules.js` is pure, with no DOM, and the API imports it too, so the
browser and the server always agree on a game.

| File | What it does |
| --- | --- |
| `rules.js` | Who wins a round, when a best-of is over, and rounds as digits. |
| `game.js` | The game screen: setup, play, undo, result, submit, sharing, saving. |
| `replay.js` | The instant replay. |
| `net.js` | Pairing over PeerJS, STUN only, from `STUN-p2p-spec.md`. |
| `multiplayer.js` | Network games on top of `net.js`: hosting, joining, sealed picks. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, and boot. |

## The game

**Modes.** Against the computer: you pick first, then the computer picks at
random. Or two devices on one network, one hosting with a six character
code, a link or a QR code, and the other joining. The host picks the rules.

**Best of.** 1, 3, 5, or any odd number from 1 to 99: first to more than
half wins. A drawn round is played again and does not count, which is why
the number is odd; best of 4 could end two all.

**Rounds.** A pick is 0 rock, 1 paper, 2 scissors, and a round is one digit,
the first side's pick times three plus the second side's. The first side is
the player against the computer, or the host. A game is its best-of and its
digits: that is what is saved, sent between devices, put in replay links and
submitted.

**Scoring.** A point for every round won, nothing else. The score grows as
the game goes on, and shows beside the chips while it does.

**Leaderboard or practice.** Chosen before each game. Leaderboard games have
no undo. Practice games have unlimited undo and are not scored. A
leaderboard game that cannot reach the server at the start, or loses it
partway through and is played on, becomes an unscored game with undo.

**Undo.** Takes back the last round, and reopens a finished game. In a
network game it asks the other player, who accepts or declines.

**Replay.** When a game ends it shows the last round, then plays back from
the start by itself (a setting turns this off), with play, pause, a step back
or forward, a slider and the round list. It plays at 0.5x, 1x, 2x or 4x,
remembered in this browser.

**Sharing a replay.** Share replay makes a link such as
`/?watch=8351&bo=3&vs=n`, through the device's share sheet where it has one
and the clipboard otherwise. The link is the whole game: the round digits,
the best-of, and `vs` `c` for the computer or `n` for a network game. A link
must hold a finished game exactly, or the page says it is damaged. Nothing
is stored, and a link opens offline once the site has been visited. A shared
replay shows no score, since a link can be edited.

## The leaderboard and anti-cheat

One board: rounds won, added up per name, with games won and played. Games
against the computer and network games count; practice games do not. A game
counts only if it started while online, from a ticket `/api/game/start`
hands out.

**Against the computer,** each round of a scored game is thrown through
`/api/game/throw`. The server picks the computer's hand after the player's
has arrived and records the round itself, so a page cannot see the pick
coming or rewrite a result, and the submit uses the server's rounds. A throw
repeated after a lost reply gets the round as it was first played.

**Network games** are sealed: each side sends a SHA-256 hash of its pick
and a random salt, and only once both hashes are in does either open its
pick, which the other checks against the hash. Neither device learns the
other's pick early or can change its own after seeing it. Both sides submit
their own rounds, and the database refuses:

| Code | When |
| --- | --- |
| `not_yours` | a computer game or host side from a browser other than the one that started it |
| `same_device` | a guest side from the host's own browser |
| `mismatch` | rounds different from the server's, or from the other side's |
| `too_fast` | a network game under a second a round, or five seconds in all |
| `same_name` | both sides of one network game under one name |
| `unfinished` | a computer game the server has not seen end |

Requests are rate limited per address. None of this stops one person
playing both sides of a network game from two browsers; it stops forged
results and a page that knows the computer's pick.

## Network games

Per `STUN-p2p-spec.md`: STUN only, no TURN relay. **Both devices have to be
on the same network**: the same wifi, or one sharing a hotspot with the
other. PeerJS loads from cdnjs only when somebody hosts or joins, and is
never cached. The host holds the game and sends it in full 20 times a
second; the guest sends its sealed picks, their openings and undo requests.
A guest that reloads mid-round keeps its sealed pick in this browser, so the
round can still finish. Leaving on purpose retires the code.

## Offline and updates

Everything the page loads is precached, the Jua font included, so the site
opens and plays with no connection. Only the leaderboard and network games
need the network. Nothing under `/api/` is ever cached.

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the reader asks. Bump `VERSION` in `sw.js` on
every change to anything in this directory.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/game/start` | `client_key, mode, best_of` | `game_id, created_at` |
| `POST /api/game/throw` | `game_id, client_key, round, pick` | `status, rounds` |
| `POST /api/game/submit` | `game_id, client_key, name, side, rounds?` | `name, score, outcome, total, games, won, rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | | `entries`, cached 30 s |

`mode` is `computer` or `network`. `side` is 0 for the player or host and 1
for the guest. `rounds` is the round digits, and only a network game sends
it. Errors are `{ error, message? }` with a matching status. Start is limited
to 60 an address per 10 minutes, throws to 600, and submit to 30.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |

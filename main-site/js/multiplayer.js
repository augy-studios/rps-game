// Network games: one device hosts and the other joins with a six character
// code, over net.js. The host is authoritative, per STUN-p2p-spec.md: the
// guest says what it wants, the host applies it and sends the whole game
// back, 20 times a second and on every change.
//
// Picks are sealed, so neither device learns the other's before both have
// picked, and neither can change its own after seeing the other's. Each side
// first sends a SHA-256 hash of its game, round, pick and a random salt. Once
// both hashes are in, each opens its pick with the salt, and the other side
// checks it against the hash it already has. The host can see that the guest
// has picked, and the guest that the host has, and nothing more.
//
// Messages, beyond the spec's hello, state, bye and full:
//
//   { type: "commit", game, round, hash }        guest to host, a sealed pick
//   { type: "reveal", game, round, pick, salt }  guest to host, opening it
//   { type: "takeback", game, count }            guest to host, asking to undo
//   { type: "takeback-cancel" }                  guest to host, withdrawing that
//   { type: "takeback-answer", yes }             guest to host, on the host's request
//   { type: "ping" }                             guest to host, the guest's heartbeat
//
// The host's snapshot carries its own hash for the round, whether the
// guest's is in, and `proof`, the host's pick opened with its salt once both
// hashes are in.

import { Host, Guest, generateCode, isValidCode, normaliseCode, CODE_LENGTH, PROTOCOL_VERSION } from "./net.js";
import * as game from "./game.js";
import { validPick, validBestOf, roundsFromText, tally, packRound, unpackRound, MAX_ROUNDS } from "./rules.js";
import { qrToSvg } from "./qr.js";
import { copyText, hydrateIcons, store } from "./ui.js";

const HOST_CODE_KEY = "rpsgame.hostCode";
const LAST_CODE_KEY = "rpsgame.lastCode";
// The guest's sealed pick, so a reload mid-round can still open it.
const GUEST_PICK_KEY = "rpsgame.guestPick";
const SNAPSHOT_MS = 50;
const TICK_MS = 250;
const PING_MS = 1000;
const HOST_SILENCE_MS = 8000;
// Time, not missed snapshots: at 20 a second a few missed ones is an
// ordinary wifi stall, and a background host tab only ticks once a second.
const GUEST_STALE_MS = 2000;
// How often the guest sends its commit or reveal again while the host's
// snapshots say it has not arrived.
const RESEND_MS = 600;
const HASH = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const $ = (id) => document.getElementById(id);

let role = null; // "host" | "guest" | null
let host = null;
let guest = null;
let code = "";
let plan = null; // host: { bestOf, practice }
let netGame = 0;
let startingGame = false;
let retriedTaken = false;
let lastHeard = 0;
let lastState = 0;
let reconnects = 0;
let wakeLock = null;

// Host: this round's two seals. mine is { pick, salt, hash }, theirs the
// guest's hash. proof is the host's pick opened, kept until the next one.
let hr = { game: 0, round: 0, mine: null, theirs: null };
let proof = null;

// Guest: this round's own pick, { game, round, pick, salt, hash, sentAt,
// revealedAt }, the host's hash last seen per round, and whether the host
// has been caught opening a pick it did not seal.
let gp = null;
const hostHashes = new Map();
const checked = new Set();
let cheated = false;

/* ---- sealing ---- */

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const sealText = (gameNo, round, pick, salt) => `${gameNo}:${round}:${pick}:${salt}`;

/* ---- the adapter game.js calls ---- */

const adapter = {
  connected() {
    if (role === "host") return Boolean(host && host.links.size > 0);
    if (role === "guest") return guest?.status === "connected" && Date.now() - lastState < GUEST_STALE_MS * 3;
    return false;
  },
  cheated() {
    return role === "guest" && cheated;
  },
  changed() {
    if (role === "host") broadcast();
    renderBar();
  },
  host(next) {
    startHosting(next);
  },
  pick(p) {
    if (role === "host") hostPick(p);
    else if (role === "guest") guestPick(p);
  },
  requestTakeback() {
    const g = game.current();
    if (!g || !g.rounds.length) return;
    if (role === "host") {
      game.setTakeback({ by: 0 });
      broadcast();
    } else {
      guest?.send({ type: "takeback", game: g.netGame, count: g.rounds.length });
    }
  },
  answerTakeback(yes) {
    const g = game.current();
    const pending = g?.takeback;
    if (!pending) return;
    const mine = pending.by === g.mySide;
    if (role === "host") {
      if (!mine && yes) acceptTakeback();
      else game.setTakeback(null);
      broadcast();
    } else {
      guest?.send(mine ? { type: "takeback-cancel" } : { type: "takeback-answer", yes: Boolean(yes) });
    }
  },
  leave() {
    if (role === "host") stopHosting();
    else leaveGuest();
  },
  nextGame() {
    if (role === "host" && plan) startNetworkGame();
  },
};

/* ---- hosting ---- */

function readStored(key) {
  const value = store.get(key);
  return isValidCode(value) ? normaliseCode(value) : null;
}

function joinLink(c) {
  return `${location.origin}/?join=${c}`;
}

async function startHosting(next) {
  closeAll();
  role = "host";
  plan = { bestOf: next.bestOf, practice: next.practice };
  netGame = 0;
  code = readStored(HOST_CODE_KEY) ?? generateCode();
  store.set(HOST_CODE_KEY, code);

  game.showPanel("net");
  $("hostView").classList.remove("hidden");
  $("hostCode").textContent = code;
  $("hostQr").innerHTML = qrToSvg(joinLink(code));
  $("hostRules").textContent = `Best of ${plan.bestOf}, ${plan.practice ? "practice" : "for the leaderboard"}.`;
  $("copyLinkLabel").textContent = "Copy link";
  $("newCodeBtn").classList.remove("hidden");
  $("netRetryBtn").classList.add("hidden");
  setNetStatus(navigator.onLine === false ? "Network games need a connection to pair." : "Setting up the code.");

  const mine = new Host({ maxGuests: 1 });
  host = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (host !== mine) return;
    if (detail.taken && !retriedTaken) {
      // Another tab holds it, or the broker has not let go of it yet.
      retriedTaken = true;
      restartWithFreshCode();
      return;
    }
    if (detail.status === "waiting") retriedTaken = false;
    onHostStatus(detail);
  });
  mine.addEventListener("message", ({ detail }) => {
    if (host === mine) onHostMessage(detail.message, detail.from);
  });
  mine.addEventListener("leave", () => {
    if (host === mine) game.refresh();
  });

  try {
    await mine.start(code);
  } catch {
    if (host !== mine) return;
    host = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
  }
}

function onHostStatus({ status, message }) {
  if (status === "error") {
    if (game.current()?.mode === "network") renderBar(message);
    else setNetStatus(message, true);
    return;
  }
  if (status === "waiting" && !game.current()) setNetStatus("Waiting for the other device to join.");
  if (status === "connected") acquireWakeLock();
  renderBar();
  game.refresh();
}

function restartWithFreshCode() {
  store.remove(HOST_CODE_KEY);
  startHosting(plan);
}

function stopHosting() {
  host?.close();
  host = null;
  role = null;
  releaseWakeLock();
}

// A game starts once the guest has said hello, and the next one when the
// host asks for it.
async function startNetworkGame() {
  if (startingGame) return;
  startingGame = true;
  try {
    const next = netGame + 1;
    const g = await game.launch({ mode: "network", role: "host", bestOf: plan.bestOf, practice: plan.practice, netGame: next });
    if (g) netGame = next;
    proof = null;
    syncHostRound();
  } finally {
    startingGame = false;
  }
  broadcast();
}

// The seals belong to one round of one game; a new round, a takeback or a
// new game starts them afresh.
function syncHostRound() {
  const g = game.current();
  if (!g || g.mode !== "network") return;
  if (hr.game !== g.netGame || hr.round !== g.rounds.length) {
    hr = { game: g.netGame, round: g.rounds.length, mine: null, theirs: null };
  }
  game.setLive({ myPick: hr.mine?.pick ?? null, oppPicked: Boolean(hr.theirs) });
}

async function hostPick(p) {
  const g = game.current();
  syncHostRound();
  if (!g || !validPick(p) || hr.mine || game.isOver() || g.takeback) return;
  // Set before the hash is ready, so a second tap cannot pick twice.
  const mine = { pick: p, salt: randomSalt(), hash: null };
  const seal = hr;
  seal.mine = mine;
  game.setLive({ myPick: p, oppPicked: Boolean(seal.theirs) });
  mine.hash = await sha256(sealText(seal.game, seal.round, p, mine.salt));
  if (hr !== seal) return;
  openIfReady();
  broadcast();
}

// Both sealed: the host opens its pick to the guest.
function openIfReady() {
  if (hr.mine?.hash && hr.theirs) proof = { game: hr.game, round: hr.round, pick: hr.mine.pick, salt: hr.mine.salt };
}

async function onReveal(message) {
  const seal = hr;
  if (!seal.theirs || !seal.mine?.hash || message.game !== seal.game || message.round !== seal.round) return;
  if (!validPick(message.pick) || typeof message.salt !== "string" || !SALT.test(message.salt)) return;
  const hash = await sha256(sealText(seal.game, seal.round, message.pick, message.salt));
  // A pick that does not match its seal is ignored; the round waits.
  if (hr !== seal || hash !== seal.theirs) return;
  game.commitRound(packRound(seal.mine.pick, message.pick));
  syncHostRound();
  broadcast();
}

function acceptTakeback() {
  game.takeBack();
  proof = null;
  syncHostRound();
}

function broadcast() {
  const g = game.current();
  if (role !== "host" || !host || !g || g.mode !== "network" || !g.netGame) return;
  const current = hr.game === g.netGame && hr.round === g.rounds.length;
  host.send({
    ...game.snapshot(),
    hostHash: current ? hr.mine?.hash ?? null : null,
    guestCommitted: current && Boolean(hr.theirs),
    proof,
  });
}

function onHostMessage(message, from) {
  lastHeard = Date.now();
  const g = game.current();
  const live = g && g.mode === "network" && g.netGame === netGame && !game.isOver();

  switch (message.type) {
    case "hello":
      if (message.v !== PROTOCOL_VERSION) {
        host.send({ type: "old", v: PROTOCOL_VERSION }, from);
        return;
      }
      if (!g || g.mode !== "network") startNetworkGame();
      else broadcast();
      renderBar();
      return;
    case "commit":
      syncHostRound();
      if (!live || message.game !== hr.game || message.round !== hr.round) break;
      if (typeof message.hash !== "string" || !HASH.test(message.hash)) break;
      // A fresh seal replaces an old one only while the host's pick is still
      // closed, which is the guest reloading mid-round. Once the host has
      // opened its pick, the guest's seal stands.
      if (hr.theirs && hr.mine?.hash) break;
      hr.theirs = message.hash;
      game.setLive({ myPick: hr.mine?.pick ?? null, oppPicked: true });
      openIfReady();
      break;
    case "reveal":
      if (live) onReveal(message);
      return;
    case "takeback":
      // Only games that are not scored have undo; a scored game has a gameId.
      if (g?.mode === "network" && !g.takeback && !g.gameId && g.rounds.length > 0 && message.count === g.rounds.length) {
        game.setTakeback({ by: 1 });
      }
      break;
    case "takeback-cancel":
      if (g?.takeback?.by === 1) game.setTakeback(null);
      break;
    case "takeback-answer":
      if (g?.takeback?.by === 0) {
        if (message.yes === true) acceptTakeback();
        else game.setTakeback(null);
      }
      break;
    case "bye":
      // Leaving on purpose: this code is spent, and the game with it.
      store.remove(HOST_CODE_KEY);
      game.endGame();
      startHosting(plan);
      setNetStatus("Your opponent left. Share the new code to play again.");
      return;
    default:
      // ping, and anything this build does not know: ignored, never thrown on.
      return;
  }
  broadcast();
}

/* ---- joining ---- */

export async function join(input) {
  const c = normaliseCode(input);
  if (!isValidCode(c)) {
    setNetStatus(`A code is ${CODE_LENGTH} characters.`, true);
    const field = $("joinInput");
    field.classList.remove("shake");
    void field.offsetWidth;
    field.classList.add("shake");
    field.focus();
    return;
  }
  // A reconnect to the same code keeps what this page knows about the host,
  // including having caught it changing a pick.
  if (role !== "guest" || code !== c) {
    reconnects = 0;
    hostHashes.clear();
    checked.clear();
    cheated = false;
  }
  closeAll();
  role = "guest";
  code = c;
  lastState = 0;
  restoreGuestPick();

  if (!game.current() || game.current().mode !== "network") {
    game.showPanel("net");
    $("hostView").classList.add("hidden");
    $("newCodeBtn").classList.add("hidden");
  }
  $("netRetryBtn").classList.add("hidden");
  setNetStatus(navigator.onLine === false ? "Network games need a connection to pair." : `Connecting to ${c}.`);

  const mine = new Guest();
  guest = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (guest === mine) onGuestStatus(detail);
  });
  mine.addEventListener("message", ({ detail }) => {
    if (guest === mine) onGuestMessage(detail.message);
  });

  try {
    await mine.connect(c);
    store.set(LAST_CODE_KEY, c);
  } catch {
    if (guest !== mine) return;
    guest = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
    $("netRetryBtn").classList.remove("hidden");
  }
}

const UNREACHABLE =
  "Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.";

function onGuestStatus({ status, message }) {
  const inGame = game.current()?.mode === "network";
  if (status === "connected") {
    reconnects = 0;
    acquireWakeLock();
    if (!inGame) setNetStatus("Connected. Waiting for the host's game.");
  } else if (status === "dropped") {
    // Probably coming back: try again quietly a few times.
    if (reconnects < 3) {
      reconnects++;
      setTimeout(() => role === "guest" && guest?.status === "dropped" && join(code), 1500);
    } else if (!inGame) {
      setNetStatus("The connection dropped.", true);
      $("netRetryBtn").classList.remove("hidden");
    }
  } else if (status === "unreachable" || status === "error") {
    const text = status === "unreachable" ? UNREACHABLE : message;
    if (inGame) {
      renderBar(text);
    } else {
      setNetStatus(text, true);
      $("netRetryBtn").classList.remove("hidden");
    }
  }
  renderBar();
  game.refresh();
}

function validSnapshot(s) {
  const rounds = typeof s.rounds === "string" ? roundsFromText(s.rounds) : null;
  const p = s.proof;
  return (
    Number.isInteger(s.game) &&
    s.game > 0 &&
    validBestOf(s.bestOf) &&
    rounds !== null &&
    tally(rounds, s.bestOf) !== null &&
    typeof s.practice === "boolean" &&
    typeof s.scored === "boolean" &&
    (s.gameId === null || (typeof s.gameId === "string" && UUID.test(s.gameId))) &&
    (s.takeback === null || (typeof s.takeback === "object" && (s.takeback.by === 0 || s.takeback.by === 1))) &&
    (s.hostHash === null || (typeof s.hostHash === "string" && HASH.test(s.hostHash))) &&
    typeof s.guestCommitted === "boolean" &&
    (p === null ||
      (typeof p === "object" &&
        Number.isInteger(p.game) &&
        Number.isInteger(p.round) &&
        p.round >= 0 &&
        p.round < MAX_ROUNDS &&
        validPick(p.pick) &&
        typeof p.salt === "string" &&
        SALT.test(p.salt)))
  );
}

function onGuestMessage(message) {
  switch (message.type) {
    case "state":
      if (!validSnapshot(message)) return;
      lastState = Date.now();
      // Rebuilt field by field, so nothing unexpected rides along.
      game.loadSnapshot({
        game: message.game,
        bestOf: message.bestOf,
        practice: message.practice,
        scored: message.scored,
        gameId: message.gameId,
        rounds: message.rounds,
        takeback: message.takeback && { by: message.takeback.by },
      });
      onGuestState(message);
      renderBar();
      return;
    case "full":
      setNetStatus("That game already has two players.", true);
      return;
    case "old":
      setNetStatus("The host's device is on a different version. Reload both and try again.", true);
      return;
    default:
      return;
  }
}

// Everything the guest does with a snapshot beyond showing it: noting the
// host's seal, checking its opened pick, and sending its own seal or its
// opening again until the host has it.
function onGuestState(snap) {
  const g = game.current();
  if (!g) return;
  const round = g.rounds.length;

  if (gp && (gp.game !== snap.game || gp.round !== round)) setGuestPick(null);
  if (snap.hostHash) hostHashes.set(`${snap.game}:${round}`, snap.hostHash);
  checkProof(snap);

  if (gp?.hash && !cheated && !game.isOver()) {
    const now = Date.now();
    if (!snap.guestCommitted && now - gp.sentAt > RESEND_MS) {
      gp.sentAt = now;
      guest?.send({ type: "commit", game: gp.game, round: gp.round, hash: gp.hash });
    } else if (snap.guestCommitted && snap.hostHash && now - gp.revealedAt > RESEND_MS) {
      // The host's seal is on record here before this opens, so the host
      // cannot change its pick to beat it.
      gp.revealedAt = now;
      guest?.send({ type: "reveal", game: gp.game, round: gp.round, pick: gp.pick, salt: gp.salt });
    }
  }
  game.setLive({ myPick: gp?.pick ?? null, oppPicked: Boolean(snap.hostHash) });
}

// The host's opened pick must match the seal it showed, and a round played
// with it must use it.
async function checkProof(snap) {
  const p = snap.proof;
  if (!p || cheated) return;
  const g = game.current();
  if (p.game === snap.game && g && p.round < g.rounds.length && unpackRound(g.rounds[p.round])[0] !== p.pick) {
    flagCheat();
    return;
  }
  const key = `${p.game}:${p.round}:${p.salt}`;
  const seen = hostHashes.get(`${p.game}:${p.round}`);
  // A seal this page never saw, after a reload, cannot be checked.
  if (!seen || checked.has(key)) return;
  checked.add(key);
  if ((await sha256(sealText(p.game, p.round, p.pick, p.salt))) !== seen) flagCheat();
}

function flagCheat() {
  cheated = true;
  game.refresh();
  renderBar();
}

async function guestPick(p) {
  const g = game.current();
  if (!g || !validPick(p) || gp || cheated || game.isOver() || g.takeback) return;
  const entry = { game: g.netGame, round: g.rounds.length, pick: p, salt: randomSalt(), hash: null, sentAt: 0, revealedAt: 0 };
  setGuestPick(entry);
  game.setLive({ myPick: p, oppPicked: g.oppPicked });
  entry.hash = await sha256(sealText(entry.game, entry.round, p, entry.salt));
  if (gp !== entry) return;
  store.set(GUEST_PICK_KEY, { code, ...entry });
  entry.sentAt = Date.now();
  guest?.send({ type: "commit", game: entry.game, round: entry.round, hash: entry.hash });
}

function setGuestPick(entry) {
  gp = entry;
  if (!entry) store.remove(GUEST_PICK_KEY);
}

// After a reload mid-round, the seal the host holds can still be opened.
function restoreGuestPick() {
  const saved = store.getJSON(GUEST_PICK_KEY);
  gp = null;
  if (
    saved &&
    saved.code === code &&
    Number.isInteger(saved.game) &&
    Number.isInteger(saved.round) &&
    validPick(saved.pick) &&
    SALT.test(saved.salt ?? "") &&
    HASH.test(saved.hash ?? "")
  ) {
    gp = { game: saved.game, round: saved.round, pick: saved.pick, salt: saved.salt, hash: saved.hash, sentAt: 0, revealedAt: 0 };
  }
}

function leaveGuest() {
  guest?.leave();
  guest = null;
  role = null;
  setGuestPick(null);
  cheated = false;
  store.remove(LAST_CODE_KEY);
  releaseWakeLock();
}

/* ---- both ---- */

function closeAll() {
  host?.close();
  host = null;
  guest?.close();
  guest = null;
  hr = { game: 0, round: 0, mine: null, theirs: null };
  proof = null;
  gp = null;
}

function setNetStatus(text, error = false) {
  const el = $("netStatus");
  el.textContent = text;
  el.classList.toggle("error", error);
}

// The line under the hands in a network game.
function renderBar(problem) {
  const g = game.current();
  const bar = $("netBar");
  if (!g || g.mode !== "network") {
    bar.classList.add("hidden");
    return;
  }
  let tone = "busy";
  let text;
  if (role === "host") {
    if (host?.links.size) {
      tone = "ok";
      text = "Connected";
    } else {
      tone = "warn";
      text = `Opponent disconnected. They can rejoin with ${code}.`;
    }
  } else if (role === "guest") {
    const fresh = Date.now() - lastState < GUEST_STALE_MS;
    if (cheated) {
      tone = "error";
      text = "The host's pick did not match its seal.";
    } else if (guest?.status === "connected" && fresh) {
      tone = "ok";
      text = "Connected to the host";
    } else if (guest?.status === "connected") {
      tone = "warn";
      text = "The connection looks stale.";
    } else if (guest?.status === "connecting" || guest?.status === "dropped") {
      text = "Reconnecting.";
    } else {
      tone = "error";
      text = "Disconnected.";
    }
  } else {
    tone = "error";
    text = "Not connected.";
  }
  if (problem) {
    tone = "error";
    text = problem;
  }
  if (bar.dataset.tone !== tone) bar.dataset.tone = tone;
  if ($("netBarText").textContent !== text) $("netBarText").textContent = text;
  bar.classList.remove("hidden");
}

async function acquireWakeLock() {
  try {
    if (!wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    // Refused or unsupported: the screen may sleep, nothing else changes.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

let wasConnected = false;

function tick() {
  if (role === "host" && host) {
    // A guest silent this long has probably gone; its seat reopens.
    if (host.links.size && Date.now() - lastHeard > HOST_SILENCE_MS) {
      host.dropAll();
      game.refresh();
    }
  }
  if (role === "guest") {
    renderBar();
    // The pick buttons follow the connection going stale and coming back.
    const now = adapter.connected();
    if (now !== wasConnected) {
      wasConnected = now;
      game.refresh();
    }
  }
}

export function initMultiplayer({ joinCode } = {}) {
  game.setNet(adapter);

  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinInput").value);
  });
  $("joinInput").addEventListener("input", (e) => {
    const c = normaliseCode(e.target.value);
    if (c !== e.target.value) e.target.value = c;
  });
  $("copyLinkBtn").addEventListener("click", async () => {
    $("copyLinkLabel").textContent = (await copyText(joinLink(code))) ? "Copied" : "Copy failed";
  });
  $("newCodeBtn").addEventListener("click", () => {
    if (role === "host") restartWithFreshCode();
  });
  $("netRetryBtn").addEventListener("click", () => {
    if (role === "guest" || code) join(code);
  });
  $("netCancelBtn").addEventListener("click", () => {
    if (role === "host") stopHosting();
    else leaveGuest();
    game.endGame();
  });

  // The steady beat, which doubles as the host's heartbeat.
  setInterval(() => role === "host" && broadcast(), SNAPSHOT_MS);
  setInterval(tick, TICK_MS);
  setInterval(() => role === "guest" && guest?.send({ type: "ping" }), PING_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (role && adapter.connected()) acquireWakeLock();
    // Back from the background with a channel that died meanwhile.
    if (role === "guest" && guest?.status === "dropped") join(code);
  });

  // From a join link, or from last time.
  const initial = normaliseCode(joinCode) || readStored(LAST_CODE_KEY) || "";
  if (initial) $("joinInput").value = initial;
  hydrateIcons($("net"));
}

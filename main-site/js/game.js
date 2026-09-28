// The game screen: choosing a game, playing it, and what happens after.
//
// A game is its best-of and its list of rounds (rules.js), and everything on
// screen is drawn from those two. That is also all that is saved, sent to the
// other device in a network game, put in a replay link, and submitted.
//
// Against the computer the player picks first and the computer then picks at
// random. In a scored game that random pick is made by the server, after it
// has the player's, so a page cannot know it in advance; practice games pick
// here. Network rounds are sealed and opened by multiplayer.js.
//
// Undo is unlimited, but only where nothing is scored: practice games, and
// games that could not reach the leaderboard.

import {
  PICK_NAMES,
  PICK_KEYS,
  PRESET_BEST_OF,
  MIN_BEST_OF,
  MAX_BEST_OF,
  validPick,
  validBestOf,
  winsNeeded,
  packRound,
  unpackRound,
  roundWinner,
  tally,
  roundsToText,
  roundsFromText,
  finishedRounds,
  howItWent,
} from "./rules.js";
import { api } from "./api.js";
import { getSettings, onSettingsChange, saveSettings } from "./settings.js";
import { openLeaderboard } from "./leaderboard.js";
import { Replay } from "./replay.js";
import { copyText, hydrateIcons, store } from "./ui.js";

const GAME_STORAGE = "rpsgame.game";
const SETUP_STORAGE = "rpsgame.setup";
// How long to wait for a start ticket before playing unscored.
const START_WAIT_MS = 5000;
// How long the other hand stays hidden after a pick. It is also the time a
// scored game's throw has to come back before anyone notices the wait.
const REVEAL_MS = 650;
// Refusals that mean this game can never be scored again.
const THROW_FINAL = ["not_found", "not_yours", "expired", "not_computer"];
const SUBMIT_FINAL = ["already_submitted", "expired", "too_fast", "not_yours", "same_device", "mismatch", "unfinished", "bad_rounds", "not_found"];

const $ = (id) => document.getElementById(id);

let replayer = null;
let g = null; // the game on screen, or null
let net = null; // set by multiplayer.js
let watching = null; // a shared replay being watched: { rounds, bestOf, vs }
let view = { mySide: 0, names: ["You", "Computer"], bestOf: 3 }; // what the replay draws with
let launching = false;
let gameCounter = 0;
let leaveTimer = null;
let lastShown = 0; // rounds drawn last time, so only a new one lands

/* ---- setup ---- */

// best: 1, 3 or 5, or "custom" for `custom`. scoring: "board" or "practice".
const setup = { mode: "computer", best: 3, custom: 7, scoring: "board" };

function loadSetup() {
  const saved = store.getJSON(SETUP_STORAGE) ?? {};
  if (["computer", "network"].includes(saved.mode)) setup.mode = saved.mode;
  if (saved.best === "custom" || PRESET_BEST_OF.includes(saved.best)) setup.best = saved.best;
  if (validBestOf(saved.custom)) setup.custom = saved.custom;
  if (["board", "practice"].includes(saved.scoring)) setup.scoring = saved.scoring;
}

function saveSetup() {
  store.set(SETUP_STORAGE, setup);
}

const MODE_NOTES = {
  computer: "You pick first, then the computer picks at random.",
  network: "Play someone on the same wifi, or sharing a hotspot. The host picks the rules.",
};

const SCORING_NOTES = {
  board: "Every round you win is a point on the leaderboard, when the game starts online. No undo.",
  practice: "Undo as often as you like. Not scored.",
};

function bestNote() {
  const n = setup.best === "custom" ? Number($("customBest").value) : setup.best;
  if (!validBestOf(n)) return `Enter an odd number from ${MIN_BEST_OF} to ${MAX_BEST_OF}.`;
  const need = winsNeeded(n);
  return `First to ${need} ${need === 1 ? "round" : "rounds"} won. A drawn round is played again.`;
}

export function renderSetup() {
  const check = (sel, attr, value) =>
    document.querySelectorAll(sel).forEach((el) => el.setAttribute("aria-checked", String(el.dataset[attr] === String(value))));
  check("#modePick [data-pick]", "pick", setup.mode);
  check("#bestPick [data-best]", "best", setup.best);
  check("#scoringPick [data-scoring]", "scoring", setup.scoring);
  $("customBestRow").classList.toggle("hidden", setup.best !== "custom");
  $("bestNote").textContent = bestNote();
  $("playNote").textContent = MODE_NOTES[setup.mode];
  $("scoringNote").textContent = SCORING_NOTES[setup.scoring];
  $("joinForm").classList.toggle("hidden", setup.mode !== "network");
  $("startLabel").textContent = launching ? "Starting" : setup.mode === "network" ? "Host a game" : "Start game";
  $("startBtn").disabled = launching;
}

// The chosen best-of, or undefined if the custom number is not one.
function bestOfFromSetup() {
  if (setup.best !== "custom") return setup.best;
  const n = Number($("customBest").value);
  return validBestOf(n) ? n : undefined;
}

function shake(input) {
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus();
}

function onStart() {
  const bestOf = bestOfFromSetup();
  if (bestOf === undefined) {
    $("bestNote").textContent = `Enter an odd number from ${MIN_BEST_OF} to ${MAX_BEST_OF}.`;
    return shake($("customBest"));
  }
  const practice = setup.scoring === "practice";
  if (setup.mode === "network") {
    net?.host({ bestOf, practice });
    return;
  }
  launch({ mode: "computer", bestOf, practice });
}

function setLaunching(on) {
  launching = on;
  $("againBtn").disabled = on;
  renderSetup();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts a game. A scored one asks the server for a start ticket first; if
// it cannot be reached in a few seconds, the game starts anyway, unscored.
// Resolves with the game, or null if a start was already under way.
export async function launch({ mode, role = null, bestOf, practice = false, netGame = 0 }) {
  if (practice) return startGame({ mode, role, bestOf, practice, ticket: "practice", netGame });
  if (launching) return null;
  setLaunching(true);
  let ticket = null;
  try {
    ticket = await withTimeout(api.start({ mode, bestOf }), START_WAIT_MS);
  } catch {
    ticket = null;
  }
  setLaunching(false);
  const started = startGame({
    mode,
    role,
    bestOf,
    practice,
    netGame,
    gameId: ticket?.game_id ?? null,
    ticket: ticket?.game_id ? "ok" : "offline",
  });
  if (!ticket?.game_id) {
    started.note = "The leaderboard could not be reached, so this game is not scored.";
    update();
  }
  return started;
}

/* ---- the game ---- */

// opts: { mode, role?, bestOf, practice?, rounds?, gameId?, ticket,
// submitted?, submittedText?, startedAt?, netGame? }
//
// ticket is "ok" (scored), "offline" (the start could not reach the
// server), "practice", "dropped" (scored until a throw failed and the player
// chose to play on), or "none" (a network guest whose host has no ticket).
export function startGame(opts) {
  replayer.stop();
  if (watching) closeWatch({ show: false });
  disarmLeave();
  g = {
    id: ++gameCounter,
    mode: opts.mode,
    role: opts.role ?? null,
    mySide: opts.role === "guest" ? 1 : 0,
    bestOf: opts.bestOf,
    practice: Boolean(opts.practice),
    rounds: opts.rounds?.slice() ?? [],
    gameId: opts.gameId ?? null,
    ticket: opts.ticket,
    submitted: opts.submitted ?? false,
    submittedText: opts.submittedText ?? null,
    submitRefused: false,
    startedAt: opts.startedAt ?? Date.now(),
    netGame: opts.netGame ?? 0,
    // This round, before it is played: my pick, and whether the other side
    // has made theirs. Neither is ever the other side's pick itself.
    myPick: null,
    oppPicked: false,
    throwing: false,
    throwError: null,
    note: null,
    takeback: null,
    wasOver: false,
  };
  lastShown = g.rounds.length;
  showPanel("play");
  resetResult();
  persist();
  update({ fresh: true });
  return g;
}

export function isOver() {
  return Boolean(g && tally(g.rounds, g.bestOf)?.over);
}

function scored() {
  return Boolean(g && g.gameId && g.ticket === "ok");
}

function sideNames() {
  if (!g || g.mode === "computer") return ["You", "Computer"];
  return g.mySide === 0 ? ["You", "Opponent"] : ["Opponent", "You"];
}

// A pick for the computer: uniform, from the browser's own random source.
function randomPick() {
  for (;;) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    // 255 would make rock a shade likelier than the others.
    if (byte < 255) return byte % 3;
  }
}

async function onPick(pick) {
  if (!g || watching || !validPick(pick) || isOver() || g.throwing || g.takeback) return;
  if (g.mode === "network") {
    net?.pick(pick);
    return;
  }
  const game = g;
  const round = g.rounds.length;
  g.myPick = pick;
  g.throwing = true;
  g.throwError = null;
  g.note = null;
  update();
  const wait = delay(REVEAL_MS);

  if (!scored()) {
    await wait;
    if (game !== g) return;
    g.rounds.push(packRound(pick, randomPick()));
    endThrow();
    return;
  }

  try {
    const r = await api.throw(g.gameId, round, pick);
    await wait;
    if (game !== g) return;
    const rounds = roundsFromText(r.rounds);
    if (!rounds || !tally(rounds, g.bestOf)) throw new Error("The server's answer did not make sense.");
    // A retry after a lost reply gets the round as it was first played.
    const earlier = rounds.length > round && unpackRound(rounds[round])[0] !== pick;
    g.rounds = rounds;
    if (r.status === "over") g.note = "This game had already ended.";
    else if (earlier) g.note = "That round had already been played, so it stands as it was.";
    endThrow();
  } catch (err) {
    await wait;
    if (game !== g) return;
    g.myPick = null;
    g.throwing = false;
    g.throwError =
      err.code === "offline"
        ? "No connection, so that pick did not count. Pick again to retry."
        : `${err.message || "The server did not answer."} That pick did not count.`;
    if (THROW_FINAL.includes(err.code)) dropScoring();
    else update();
  }
}

function endThrow() {
  g.myPick = null;
  g.throwing = false;
  persist();
  update();
}

// A scored game whose throws cannot reach the server: play on, unscored.
function dropScoring() {
  if (!g) return;
  g.ticket = "dropped";
  g.throwError = null;
  g.note = "This game is no longer scored. Undo is on.";
  persist();
  update();
}

function canUndo() {
  return Boolean(g && !scored() && g.rounds.length > 0 && !g.throwing && !watching);
}

function onUndo() {
  if (!canUndo()) return;
  if (g.mode === "network") {
    if (g.takeback) net?.answerTakeback(false);
    else net?.requestTakeback();
    return;
  }
  takeBack();
}

// Takes back the last round, reopening a finished game.
export function takeBack() {
  if (!g || !g.rounds.length) return;
  g.rounds.pop();
  g.takeback = null;
  g.myPick = null;
  g.note = "The last round was taken back.";
  lastShown = g.rounds.length;
  replayer.stop();
  resetResult();
  persist();
  update();
}

function disarmLeave() {
  clearTimeout(leaveTimer);
  leaveTimer = null;
  $("leaveBtn").classList.remove("armed");
}

function onLeave() {
  if (!g) return;
  const live = g.rounds.length > 0 && !isOver();
  if (live && !leaveTimer) {
    // A game under way needs a second press, so a stray tap loses nothing.
    $("leaveBtn").classList.add("armed");
    $("leaveLabel").textContent = "Press again to leave";
    leaveTimer = setTimeout(() => {
      disarmLeave();
      update();
    }, 3000);
    return;
  }
  if (g.mode === "network") net?.leave();
  endGame();
}

// Back to choosing a game.
export function endGame() {
  disarmLeave();
  g = null;
  replayer.stop();
  store.remove(GAME_STORAGE);
  showPanel("setup");
  renderSetup();
}

/* ---- drawing ---- */

function setHand(el, { pick = null, state = "empty", tone = null, label = "", animate = false }) {
  el.dataset.state = state;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
  const art = el.querySelector(".hand-art");
  art.setAttribute("data-icon", pick !== null ? PICK_KEYS[pick] : state === "locked" ? "lock" : "question");
  hydrateIcons(el);
  el.querySelector(".hand-label").textContent = label || (pick !== null ? PICK_NAMES[pick] : "");
  if (animate) {
    el.classList.remove("land");
    void el.offsetWidth;
    el.classList.add("land");
  }
}

function winLine(names, side) {
  return names[side] === "You" ? "You win" : `${names[side]} wins`;
}

// The score and the hands just after round `count`, from `mySide`'s chair.
function drawFrame(rounds, count, { mySide, names, bestOf }, animate = false) {
  const shown = rounds.slice(0, count);
  const t = tally(shown, bestOf) ?? { wins: [0, 0] };
  $("myName").textContent = names[mySide];
  $("oppName").textContent = names[mySide ^ 1];
  $("myWins").textContent = String(t.wins[mySide]);
  $("oppWins").textContent = String(t.wins[mySide ^ 1]);

  const badge = $("roundBadge");
  if (!count) {
    setHand($("myHand"), {});
    setHand($("oppHand"), {});
    badge.textContent = "";
    delete badge.dataset.tone;
    $("roundHow").textContent = "";
    return;
  }
  const last = shown[count - 1];
  const picks = unpackRound(last);
  const w = roundWinner(last);
  const tone = w === -1 ? "draw" : w === mySide ? "win" : "loss";
  const other = tone === "win" ? "loss" : tone === "loss" ? "win" : "draw";
  setHand($("myHand"), { pick: picks[mySide], state: "shown", tone, animate });
  setHand($("oppHand"), { pick: picks[mySide ^ 1], state: "shown", tone: other, animate });
  badge.textContent = w === -1 ? "Draw" : winLine(names, w);
  badge.dataset.tone = tone;
  $("roundHow").textContent = howItWent(last);
}

// A round under way: my pick if I have made it, and the other side as
// thinking, sealed, or not yet picked.
function drawPending() {
  const names = sideNames();
  const t = tally(g.rounds, g.bestOf);
  $("myName").textContent = names[g.mySide];
  $("oppName").textContent = names[g.mySide ^ 1];
  $("myWins").textContent = String(t.wins[g.mySide]);
  $("oppWins").textContent = String(t.wins[g.mySide ^ 1]);
  setHand($("myHand"), g.myPick !== null ? { pick: g.myPick, state: "picked" } : { label: "Your pick" });
  if (g.mode === "computer") setHand($("oppHand"), { state: "thinking", label: "Picking" });
  else if (g.oppPicked) setHand($("oppHand"), { state: "locked", label: "Picked" });
  else setHand($("oppHand"), { state: "thinking", label: "Picking" });
  const badge = $("roundBadge");
  badge.textContent = `Round ${g.rounds.length + 1}`;
  delete badge.dataset.tone;
  $("roundHow").textContent = "";
}

function statusText() {
  if (g.throwError) return g.throwError;
  const last = g.rounds.at(-1);
  const after = last !== undefined ? `${howItWent(last)} ` : "";
  const prefix = g.note ? `${g.note} ` : "";
  if (g.mode === "computer") {
    if (g.throwing) return "The computer is picking.";
    return prefix + (last === undefined ? "Pick rock, paper or scissors." : `${after}Pick again.`);
  }
  if (net?.cheated()) return "The other device changed its pick after seeing yours, so this game cannot be trusted.";
  if (!net?.connected()) return "Waiting for the connection.";
  if (g.takeback) return "";
  if (g.myPick !== null && g.oppPicked) return "Both picked. Revealing.";
  if (g.myPick !== null) return `You picked ${PICK_KEYS[g.myPick]}. Waiting for your opponent.`;
  if (g.oppPicked) return `${after}Your opponent has picked. Your turn.`;
  return prefix + (last === undefined ? "Pick rock, paper or scissors." : `${after}Pick again.`);
}

function setStatus(text) {
  const el = $("status");
  if (el.textContent !== text) el.textContent = text;
}

function update({ fresh = false } = {}) {
  if (!g) return;
  const over = isOver();
  const t = tally(g.rounds, g.bestOf);
  const need = winsNeeded(g.bestOf);

  $("formatChip").textContent = `Best of ${g.bestOf}, first to ${need}`;
  $("roundChip").textContent = over ? `${g.rounds.length} ${g.rounds.length === 1 ? "round" : "rounds"}` : `Round ${g.rounds.length + 1}`;
  $("scoreChip").textContent = scored() ? `Score ${t.wins[g.mySide]}` : g.practice ? "Practice" : "Not scored";

  if (!over) {
    const pending = g.myPick !== null || g.throwing || (g.mode === "network" && g.oppPicked);
    if (pending) drawPending();
    else drawFrame(g.rounds, g.rounds.length, { mySide: g.mySide, names: sideNames(), bestOf: g.bestOf }, g.rounds.length > lastShown);
    lastShown = g.rounds.length;
  }

  setStatus(over ? "" : statusText());
  renderPicks(over);
  renderActions(over);
  renderTakeback();

  $("throwFail").classList.toggle("hidden", !g.throwError || !scored());

  if (over && (!g.wasOver || fresh)) finish(fresh);
  if (!over && g.wasOver) resetResult();
  g.wasOver = over;
  if (over) renderSubmit();

  if (g.mode === "network") net?.changed();
}

function renderPicks(over) {
  const offline = g.mode === "network" && (!net?.connected() || net?.cheated());
  const locked = over || g.throwing || g.myPick !== null || Boolean(g.takeback) || offline;
  $("picks").classList.toggle("hidden", over);
  document.querySelectorAll("#picks [data-pick]").forEach((btn) => {
    btn.disabled = locked;
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.pick) === g.myPick));
  });
}

function renderActions(over) {
  $("liveActions").classList.toggle("hidden", over);
  const undoable = !scored();
  $("undoBtn").classList.toggle("hidden", !undoable);
  $("undoBtn").disabled = !canUndo() || (g.mode === "network" && !net?.connected());
  const asked = g.mode === "network" && g.takeback?.by === g.mySide;
  $("undoLabel").textContent = asked ? "Cancel undo" : "Undo";
  if (!leaveTimer) $("leaveLabel").textContent = g.mode === "network" ? "Leave" : "New game";

  let note = "";
  if (scored()) note = "Leaderboard games have no undo.";
  else if (g.mode === "network") note = "Undo asks your opponent first.";
  $("undoNote").textContent = over ? "" : note;
}

function renderTakeback() {
  const pending = g?.mode === "network" ? g.takeback : null;
  $("takeback").classList.toggle("hidden", !pending);
  if (!pending) return;
  const mine = pending.by === g.mySide;
  $("takebackText").textContent = mine ? "You asked to undo the last round." : "Your opponent asks to undo the last round.";
  $("takebackYes").classList.toggle("hidden", mine);
  $("takebackNo").textContent = mine ? "Cancel" : "Decline";
}

export function showPanel(name) {
  for (const id of ["setup", "net", "play"]) $(id).classList.toggle("hidden", id !== name);
}

/* ---- the end ---- */

function resetResult() {
  if (g) g.submitRefused = false;
  $("result").classList.add("hidden");
  $("replayBar").classList.add("hidden");
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
}

function rounds1(n) {
  return `${n} ${n === 1 ? "round" : "rounds"}`;
}

function scoreLine() {
  if (!scored()) return "";
  const n = tally(g.rounds, g.bestOf).wins[g.mySide];
  return `${n} ${n === 1 ? "point" : "points"}, one for every round you won.`;
}

function reasonFor(rounds, bestOf, first) {
  const t = tally(rounds, bestOf);
  const draws = t.draws ? `, ${t.draws} drawn` : "";
  return `${t.wins[first]} to ${t.wins[first ^ 1]}${draws}, best of ${bestOf}.`;
}

function finish(fresh) {
  const t = tally(g.rounds, g.bestOf);
  const won = t.winner === g.mySide;
  const s = getSettings();

  if (g.mode === "computer") $("resultTitle").textContent = won ? "You won" : "The computer won";
  else $("resultTitle").textContent = won ? "You won" : "You lost";
  $("resultReason").textContent = reasonFor(g.rounds, g.bestOf, g.mySide);
  $("resultScore").textContent = scoreLine();
  $("shareLabel").textContent = "Share replay";

  $("nameInput").value = s.name ?? "";
  $("submitBtn").disabled = false;
  g.autoTried = fresh;
  renderSubmit();

  const guest = g.mode === "network" && g.role === "guest";
  $("againBtn").classList.toggle("hidden", guest);
  $("againLabel").textContent = g.mode === "network" ? "Next game" : "Play again";
  $("newGameBtn").classList.toggle("hidden", g.mode === "network");
  $("newGameLabel").textContent = "New game";

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  view = { mySide: g.mySide, names: sideNames(), bestOf: g.bestOf };
  const autoplay = !fresh && s.auto_replay;
  replayer.load(g.rounds, { names: view.names, mySide: g.mySide, autoplay, hold: autoplay ? 1800 : 0 });
  if (!fresh) $("resultTitle").focus({ preventScroll: true });
}

// The leaderboard part of the result. Redrawn on every update while the
// game is over, because a network guest learns of the host's ticket from
// the host's snapshots and may only get it after the end.
function renderSubmit() {
  const canSubmit = scored() && !g.submitted && !g.submitRefused;
  $("submitForm").classList.toggle("hidden", !canSubmit);
  let why = "";
  if (!scored()) {
    const guest = g.mode === "network" && g.role === "guest";
    if (g.ticket === "practice") why = guest ? "The host chose a practice game, so it is not scored." : "Practice games are not scored.";
    else if (g.ticket === "dropped") why = "This game stopped being scored when the server could not be reached.";
    else if (guest) why = "The host's device could not reach the leaderboard, so this game is not scored.";
    else why = "This game started without a connection, so it cannot go on the leaderboard.";
  }
  $("notScored").textContent = why;
  $("notScored").classList.toggle("hidden", !why);
  $("submittedText").textContent = g.submittedText || "This game is on the leaderboard.";
  $("submitted").classList.toggle("hidden", !g.submitted);

  const s = getSettings();
  if (canSubmit && !g.autoTried && s.auto_submit && s.name) {
    g.autoTried = true;
    submitAs(s.name, true);
  }
}

async function submitAs(name, auto = false) {
  const msg = $("submitMsg");
  const game = g;
  $("submitBtn").disabled = true;
  msg.textContent = auto ? `Adding as ${name}.` : "Checking the game.";
  try {
    const r = await api.submit({
      game_id: game.gameId,
      name,
      side: game.mySide,
      // The server keeps a computer game's rounds itself; a network game's
      // it checks against the other side's.
      rounds: game.mode === "network" ? roundsToText(game.rounds) : undefined,
    });
    if (game !== g) return;
    saveSettings({ name: r.name });
    const games = r.games === 1 ? "1 game" : `${r.games} games`;
    g.submitted = true;
    g.submittedText = `Added as ${r.name} with ${rounds1(r.score)} won. ${r.total} in all over ${games}, ranked ${r.rank}.`;
    persist();
    $("submittedText").textContent = g.submittedText;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
    msg.textContent = "";
  } catch (err) {
    if (game !== g) return;
    if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
    else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
    else msg.textContent = err.message || "That did not go through. Try again in a moment.";
    if (SUBMIT_FINAL.includes(err.code)) {
      g.submitRefused = true;
      $("submitForm").classList.add("hidden");
    } else $("submitBtn").disabled = false;
  }
}

function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    $("submitMsg").textContent = "Enter a name.";
    $("nameInput").focus();
    return;
  }
  submitAs(name);
}

/* ---- sharing a replay ----
   A replay link holds the whole game: every round as one digit, the
   best-of, and whether it was against the computer. Nothing is stored
   anywhere, so a link works for as long as the site does, offline too. It
   carries no score: anyone can edit a link, and only the leaderboard's
   scores are checked. */

function replayLink(rounds, bestOf, vs) {
  const params = new URLSearchParams({ watch: roundsToText(rounds), bo: String(bestOf), vs });
  return `${location.origin}/?${params}`;
}

async function onShare() {
  const src = watching ?? (g && { rounds: g.rounds, bestOf: g.bestOf, vs: g.mode === "computer" ? "c" : "n" });
  if (!src) return;
  const url = replayLink(src.rounds, src.bestOf, src.vs);
  const label = $("shareLabel");
  if (navigator.share) {
    try {
      await navigator.share({ title: "Rock Paper Scissors replay", text: `Watch this best of ${src.bestOf} game of rock paper scissors.`, url });
      label.textContent = "Shared";
      return;
    } catch (err) {
      // Dismissed: nothing to say. Refused or unsupported here: copy instead.
      if (err?.name === "AbortError") return;
    }
  }
  label.textContent = (await copyText(url)) ? "Link copied" : "Copy failed";
}

// Reads a replay link's parameters. Returns what to watch, { damaged: true }
// if the link is broken, or null if this is not a replay link.
export function readReplayLink(params) {
  if (!params.has("watch")) return null;
  const bestOf = Number(params.get("bo"));
  const rounds = finishedRounds(params.get("watch"), bestOf);
  const vs = params.get("vs") === "n" ? "n" : "c";
  if (!rounds) return { damaged: true };
  return { rounds, bestOf, vs };
}

function watch(link) {
  g = null;
  watching = link;
  const names = link.vs === "c" ? ["Player", "Computer"] : ["Player 1", "Player 2"];
  const t = tally(link.rounds, link.bestOf);

  showPanel("play");
  resetResult();
  for (const id of ["picks", "liveActions", "netBar", "takeback", "throwFail", "submitForm", "notScored", "submitted"]) {
    $(id).classList.add("hidden");
  }
  $("undoNote").textContent = "";
  setStatus("A shared replay.");
  $("formatChip").textContent = `Best of ${link.bestOf}, first to ${winsNeeded(link.bestOf)}`;
  $("roundChip").textContent = rounds1(link.rounds.length);
  $("scoreChip").textContent = "Replay";

  $("resultTitle").textContent = `${names[t.winner]} won`;
  $("resultReason").textContent = reasonFor(link.rounds, link.bestOf, t.winner);
  $("resultScore").textContent = link.vs === "c" ? "Against the computer." : "Played over the network.";
  $("shareLabel").textContent = "Share replay";
  $("againBtn").classList.remove("hidden");
  $("againLabel").textContent = `Play best of ${link.bestOf}`;
  $("newGameBtn").classList.remove("hidden");
  $("newGameLabel").textContent = "Close replay";

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  view = { mySide: 0, names, bestOf: link.bestOf };
  replayer.load(link.rounds, { names, mySide: 0, autoplay: true });
}

// Leaves a shared replay: the address loses the link, and the page goes
// back to the game this browser had going, or to choosing one.
function closeWatch({ show = true } = {}) {
  watching = null;
  replayer.stop();
  const params = new URLSearchParams(location.search);
  for (const key of ["watch", "bo", "vs"]) params.delete(key);
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  if (show && !resume()) {
    showPanel("setup");
    renderSetup();
  }
}

// "Play best of N": the new-game screen with the replay's rules chosen.
function playWatched() {
  const { bestOf, vs } = watching;
  closeWatch({ show: false });
  setup.mode = vs === "n" ? "network" : "computer";
  if (PRESET_BEST_OF.includes(bestOf)) setup.best = bestOf;
  else {
    setup.best = "custom";
    setup.custom = bestOf;
    $("customBest").value = String(bestOf);
  }
  saveSetup();
  showPanel("setup");
  renderSetup();
  $("startBtn").focus();
}

function onAgain() {
  if (watching) return playWatched();
  if (!g || launching) return;
  if (g.mode === "network") {
    net?.nextGame();
    return;
  }
  launch({ mode: g.mode, bestOf: g.bestOf, practice: g.practice });
}

/* ---- saving ---- */

// Games against the computer survive a reload. Network games live on the
// host and are not saved.
function persist() {
  if (!g || g.mode !== "computer") return;
  store.set(GAME_STORAGE, {
    mode: g.mode,
    bestOf: g.bestOf,
    practice: g.practice,
    rounds: roundsToText(g.rounds),
    gameId: g.gameId,
    ticket: g.ticket,
    submitted: g.submitted,
    submittedText: g.submittedText ?? null,
    startedAt: g.startedAt,
  });
}

function resume() {
  const saved = store.getJSON(GAME_STORAGE);
  if (!saved || saved.mode !== "computer" || !validBestOf(saved.bestOf)) return false;
  const rounds = roundsFromText(saved.rounds);
  if (!rounds || !tally(rounds, saved.bestOf)) return false;
  const gameId = typeof saved.gameId === "string" ? saved.gameId : null;
  const ticket = ["ok", "offline", "practice", "dropped"].includes(saved.ticket) ? saved.ticket : "offline";
  startGame({
    mode: "computer",
    bestOf: saved.bestOf,
    practice: saved.practice === true,
    rounds,
    gameId,
    ticket: ticket === "ok" && !gameId ? "offline" : ticket,
    submitted: saved.submitted === true,
    submittedText: typeof saved.submittedText === "string" ? saved.submittedText : null,
    startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : Date.now(),
  });
  return true;
}

/* ---- for multiplayer.js ---- */

export function setNet(adapter) {
  net = adapter;
}

export function current() {
  return g;
}

export function refresh() {
  update();
}

// This round's state as the network sees it: my pick, and whether the other
// side has sealed theirs.
export function setLive({ myPick, oppPicked }) {
  if (!g) return;
  if (g.myPick === myPick && g.oppPicked === oppPicked) return;
  g.myPick = myPick;
  g.oppPicked = oppPicked;
  if (myPick !== null) g.note = null;
  update();
}

// Host: a round both sides have opened.
export function commitRound(round) {
  if (!g || isOver()) return;
  g.rounds.push(round);
  g.myPick = null;
  g.oppPicked = false;
  g.note = null;
  update();
}

export function setTakeback(value) {
  if (!g) return;
  g.takeback = value;
  update();
}

// Guest: the game as the host has it.
export function loadSnapshot(snap) {
  const rounds = roundsFromText(snap.rounds);
  const same = g && g.mode === "network" && g.role === "guest" && g.netGame === snap.game;
  const ticket = snap.gameId && snap.scored ? "ok" : snap.practice ? "practice" : "none";
  if (!same) {
    startGame({
      mode: "network",
      role: "guest",
      bestOf: snap.bestOf,
      practice: snap.practice,
      rounds,
      gameId: snap.gameId,
      ticket,
      netGame: snap.game,
    });
    g.takeback = snap.takeback;
    update();
    return;
  }
  const before = JSON.stringify([g.gameId, g.ticket, g.takeback, g.rounds]);
  const shrank = rounds.length < g.rounds.length;
  g.gameId = snap.gameId;
  g.ticket = ticket;
  g.takeback = snap.takeback;
  if (rounds.length !== g.rounds.length) {
    g.rounds = rounds;
    g.note = shrank ? "The last round was taken back." : null;
    if (shrank) {
      lastShown = rounds.length;
      replayer.stop();
      resetResult();
    }
  }
  if (JSON.stringify([g.gameId, g.ticket, g.takeback, g.rounds]) !== before) update();
}

export function snapshot() {
  return {
    type: "state",
    v: 1,
    game: g.netGame,
    bestOf: g.bestOf,
    practice: g.practice,
    gameId: g.gameId,
    scored: scored(),
    rounds: roundsToText(g.rounds),
    takeback: g.takeback,
  };
}

/* ---- wiring ---- */

// A radio group in the setup: clicking a button sets `key` from its data.
function pick(id, attr, key, parse = (v) => v) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (!b) return;
    setup[key] = parse(b.dataset[attr]);
    saveSetup();
    renderSetup();
    if (key === "best" && setup.best === "custom") $("customBest").focus();
  });
}

const PICK_KEYS_TYPED = { r: 0, p: 1, s: 2, 1: 0, 2: 1, 3: 2 };

export function initGame({ joinCode, replayLink: shared } = {}) {
  replayer = new Replay((frame, { animate, rounds }) => drawFrame(rounds, frame, view, animate));
  loadSetup();

  pick("modePick", "pick", "mode");
  pick("bestPick", "best", "best", (v) => (v === "custom" ? "custom" : Number(v)));
  pick("scoringPick", "scoring", "scoring");
  $("customBest").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (validBestOf(n)) {
      setup.custom = n;
      saveSetup();
    }
    $("bestNote").textContent = bestNote();
  });
  // The field keeps what was typed, valid or not, so Start never quietly
  // plays a different number from the one on screen.
  $("customBest").value = String(setup.custom);
  $("customBest").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onStart();
  });
  $("startBtn").addEventListener("click", onStart);

  $("picks").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) onPick(Number(b.dataset.pick));
  });
  // R, P and S, or 1, 2 and 3, while a game is under way.
  document.addEventListener("keydown", (e) => {
    if (!g || watching || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("input, textarea") || document.body.classList.contains("modal-open")) return;
    const p = PICK_KEYS_TYPED[e.key.toLowerCase()];
    if (p === undefined || $("play").classList.contains("hidden")) return;
    onPick(p);
  });

  $("undoBtn").addEventListener("click", onUndo);
  $("leaveBtn").addEventListener("click", onLeave);
  $("unscoredBtn").addEventListener("click", dropScoring);
  $("takebackYes").addEventListener("click", () => net?.answerTakeback(true));
  $("takebackNo").addEventListener("click", () => net?.answerTakeback(false));

  $("submitForm").addEventListener("submit", onSubmit);
  $("againBtn").addEventListener("click", onAgain);
  $("newGameBtn").addEventListener("click", () => (watching ? closeWatch() : endGame()));
  $("resultBoardBtn").addEventListener("click", openLeaderboard);
  $("shareBtn").addEventListener("click", onShare);

  onSettingsChange(() => g && !isOver() && update());

  renderSetup();
  if (shared && !shared.damaged) {
    watch(shared);
    return;
  }
  if (joinCode) {
    setup.mode = "network";
    renderSetup();
    showPanel("setup");
    return;
  }
  // A broken replay link is dropped from the address, and said so on the
  // new-game screen when that is where the page lands.
  if (shared?.damaged) {
    closeWatch({ show: false });
    $("playNote").textContent = "That replay link is damaged or incomplete, so it cannot be played back.";
  }
  if (!resume()) showPanel("setup");
}

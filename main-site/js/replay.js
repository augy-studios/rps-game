// The instant replay: a finished game played back one round at a time, with
// play, pause, a step either way, a jump to any round from the list or the
// slider, and four speeds. Frame 0 is before the first round and frame i is
// just after round i. The drawing belongs to game.js, which hands in `draw`.

import { PICK_NAMES, unpackRound, roundWinner } from "./rules.js";
import { escapeHtml, hydrateIcons, store } from "./ui.js";

// A round every 1100 ms at 1x. The hands take 220 ms to land, so even 4x
// (275 ms a round) still shows each one arrive.
const STEP_MS = 1100;
// The same speeds as wordrain's replay. The one picked last is remembered.
const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "rpsgame.replaySpeed";

const $ = (id) => document.getElementById(id);

export class Replay {
  // draw(frame, { animate, rounds }) puts frame `frame` on screen.
  constructor(draw) {
    this.draw = draw;
    this.timer = null;
    this.ticking = null;
    this.index = 0;
    this.rounds = [];
    this.active = false;
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpStart").addEventListener("click", () => this.jump(0));
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpEnd").addEventListener("click", () => this.jump(this.rounds.length));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpScrub").addEventListener("input", (e) => this.jump(Number(e.target.value)));
    $("roundList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-round]");
      if (btn) this.jump(Number(btn.dataset.round) + 1);
    });
    document.addEventListener("keydown", (e) => {
      if (!this.active || e.target.closest("input, textarea") || document.body.classList.contains("modal-open")) return;
      if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else return;
      e.preventDefault();
    });
  }

  // names: what to call each side in the round list, first side first.
  // mySide: whose wins read as wins there. Starts at the end, or from the
  // top and playing when `autoplay` is set. `hold` first lands the last
  // round and lets it sit that many ms, so a game that has just ended shows
  // how it ended before it plays back from the top.
  load(rounds, { names, mySide = 0, autoplay = false, hold = 0 }) {
    this.pause();
    this.active = true;
    this.rounds = rounds.slice();
    $("rpScrub").max = String(this.rounds.length);

    $("roundList").innerHTML = this.rounds
      .map((round, i) => {
        const [a, b] = unpackRound(round);
        const w = roundWinner(round);
        const tone = w === -1 ? "draw" : w === mySide ? "win" : "loss";
        const who = w === -1 ? "Draw" : names[w];
        return `<li><button type="button" class="round-btn" data-round="${i}">
            <span class="round-num">${i + 1}</span>
            <span class="round-picks">${PICK_NAMES[a]} v ${PICK_NAMES[b]}</span>
            <span class="round-tag" data-tone="${tone}">${escapeHtml(who)}</span>
          </button></li>`;
      })
      .join("");

    if (autoplay && this.rounds.length && hold > 0) {
      this.show(this.rounds.length, true);
      // play() starts over from the end. Any control pressed first clears this.
      this.timer = setTimeout(() => this.play(), hold);
      this.syncPlayButton(true);
    } else if (autoplay && this.rounds.length) {
      this.show(0, false);
      this.timer = setTimeout(() => this.play(), 500);
      this.syncPlayButton(true);
    } else {
      this.show(this.rounds.length, false);
    }
  }

  stop() {
    this.pause();
    this.active = false;
  }

  show(i, animate) {
    const total = this.rounds.length;
    if (i < 0 || i > total) return;
    this.index = i;
    this.draw(i, { animate, rounds: this.rounds });
    $("rpScrub").value = String(i);
    $("rpLabel").textContent =
      i === 0 ? `Before the first round, ${total} ${total === 1 ? "round" : "rounds"} in all` : `Round ${i} of ${total}`;

    const list = $("roundList");
    list.querySelectorAll(".round-btn").forEach((b) => {
      const on = Number(b.dataset.round) === i - 1;
      b.classList.toggle("current", on);
      if (on) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    // Keep the current round in view within the list, not the page.
    const current = list.querySelector(".round-btn.current");
    if (current) {
      const top = current.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 30) list.scrollTop = top - 40;
    } else if (i === 0) {
      list.scrollTop = 0;
    }
    $("rpBack").disabled = $("rpStart").disabled = i === 0;
    $("rpForward").disabled = $("rpEnd").disabled = i === total;
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.index + delta;
    if (next < 0 || next > this.rounds.length) return false;
    // Forward lands the new round's hands; back just shows the earlier one.
    this.show(next, delta > 0);
    return true;
  }

  jump(i) {
    this.pause();
    const target = Math.max(0, Math.min(this.rounds.length, i));
    if (target - this.index === 1) this.step(1);
    else this.show(target, false);
  }

  get stepMs() {
    return STEP_MS / this.speed;
  }

  // A replay that is playing picks the new pace up from its next round,
  // without restarting.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer && this.ticking) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.stepMs);
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      el.setAttribute("aria-checked", String(Number(el.dataset.speed) === this.speed));
    });
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.index >= this.rounds.length) this.show(0, false);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.index >= this.rounds.length) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.stepMs);
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.index === 0 ? Math.min(400, this.stepMs) : this.stepMs / 2);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.querySelector("[data-icon]").setAttribute("data-icon", playing ? "pause" : "play");
    hydrateIcons(btn);
  }
}

// The leaderboard window: rounds won, added up per name. A round won is a
// point, in any game that goes on the board, won or lost.

import { api } from "./api.js";
import { escapeHtml, openModal } from "./ui.js";

const HEAD = ["#", "Name", "Rounds won", "Games won"];
const row = (e) => [e.rank, e.name, e.total, `${e.won} of ${e.games}`];

let loading = 0;

async function load() {
  const body = document.getElementById("boardBody");
  const ticket = ++loading;
  body.setAttribute("aria-busy", "true");

  try {
    const data = await api.leaderboard();
    if (ticket !== loading) return;
    const entries = data.entries ?? [];
    body.innerHTML = entries.length
      ? `<table class="board-table">
          <thead><tr>${HEAD.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
          <tbody>${entries
            .map((e) => `<tr>${row(e).map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`)
            .join("")}</tbody>
        </table>`
      : `<p class="board-empty">No scores yet. Finish a game and add yours.</p>`;
  } catch (err) {
    if (ticket !== loading) return;
    body.innerHTML = `<p class="board-empty">${
      err.code === "offline" ? "The leaderboard needs a connection." : "The leaderboard did not load. Try again in a moment."
    }</p>`;
  } finally {
    if (ticket === loading) body.removeAttribute("aria-busy");
  }
}

export function openLeaderboard() {
  openModal("boardModal");
  load();
}

export function initLeaderboard() {
  document.getElementById("boardBtn").addEventListener("click", openLeaderboard);
}

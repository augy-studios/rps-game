// The rules, and the round list everything else keeps. Pure, no DOM: the
// API imports this too, so the browser and the server always agree on who
// won a round and when a game is over.
//
// A pick is 0 rock, 1 paper, 2 scissors. A round is one digit, the first
// side's pick times three plus the second side's, so 0 to 8. The first side
// is the player against the computer, or the host in a network game.
//
// Best of N means first to (N + 1) / 2 rounds won. A drawn round is played
// again and does not count towards N, so N is always odd: best of 4 could
// end two all.

export const PICK_NAMES = ["Rock", "Paper", "Scissors"];
export const PICK_KEYS = ["rock", "paper", "scissors"];

export const PRESET_BEST_OF = [1, 3, 5];
export const MIN_BEST_OF = 1;
export const MAX_BEST_OF = 99;

// Far more than best of 99 ever needs, draws and all. It bounds what a
// saved game, a snapshot or a replay link can make this code chew through.
export const MAX_ROUNDS = 1000;

export function validPick(p) {
  return p === 0 || p === 1 || p === 2;
}

export function validBestOf(n) {
  return Number.isInteger(n) && n >= MIN_BEST_OF && n <= MAX_BEST_OF && n % 2 === 1;
}

export function winsNeeded(bestOf) {
  return (bestOf + 1) / 2;
}

export function packRound(a, b) {
  return a * 3 + b;
}

export function unpackRound(round) {
  return [Math.floor(round / 3), round % 3];
}

// -1 a draw, 0 the first side won, 1 the second side did.
export function roundWinner(round) {
  const [a, b] = unpackRound(round);
  const r = (a - b + 3) % 3;
  return r === 0 ? -1 : r - 1;
}

// Wins so far, and whether the game is over. null when a round comes after
// the one that ended it, which no honest game has.
export function tally(rounds, bestOf) {
  const need = winsNeeded(bestOf);
  const wins = [0, 0];
  let draws = 0;
  let winner = -1;
  for (const round of rounds) {
    if (winner !== -1) return null;
    const w = roundWinner(round);
    if (w === -1) {
      draws++;
      continue;
    }
    wins[w]++;
    if (wins[w] >= need) winner = w;
  }
  return { wins, draws, winner, over: winner !== -1, need };
}

export function roundsToText(rounds) {
  return rounds.join("");
}

// The digits back into rounds, or null if they cannot be any.
export function roundsFromText(text) {
  if (typeof text !== "string" || text.length > MAX_ROUNDS || !/^[0-8]*$/.test(text)) return null;
  return Array.from(text, Number);
}

// A finished game's rounds, or null unless they end it exactly.
export function finishedRounds(text, bestOf) {
  const rounds = roundsFromText(text);
  if (!rounds || !validBestOf(bestOf)) return null;
  const t = tally(rounds, bestOf);
  return t?.over ? rounds : null;
}

// Why a round went the way it did, winner first: "Paper covers rock."
const HOW = { "1-0": "Paper covers rock.", "0-2": "Rock blunts scissors.", "2-1": "Scissors cut paper." };

export function howItWent(round) {
  const [a, b] = unpackRound(round);
  if (a === b) return `Both picked ${PICK_KEYS[a]}.`;
  return HOW[`${a}-${b}`] ?? HOW[`${b}-${a}`];
}

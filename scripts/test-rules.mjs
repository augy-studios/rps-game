#!/usr/bin/env node
// The rules everything else leans on: who wins a round, when a best-of is
// over, and the round digits that saves, snapshots, replay links and the API
// all carry. Also checks that every round digit agrees with the SQL
// function's own arithmetic, (a - b + 3) % 3.
//
// Run: node scripts/test-rules.mjs

import {
  packRound,
  unpackRound,
  roundWinner,
  tally,
  validBestOf,
  winsNeeded,
  roundsFromText,
  roundsToText,
  finishedRounds,
  howItWent,
  MAX_ROUNDS,
} from "../main-site/js/rules.js";

let failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`FAIL ${name}: got ${a}, expected ${e}`);
  }
}

const R = 0;
const P = 1;
const S = 2;

// Who wins: paper covers rock, rock blunts scissors, scissors cut paper.
check("paper beats rock", roundWinner(packRound(P, R)), 0);
check("rock loses to paper", roundWinner(packRound(R, P)), 1);
check("rock beats scissors", roundWinner(packRound(R, S)), 0);
check("scissors beat paper", roundWinner(packRound(S, P)), 0);
check("scissors lose to rock", roundWinner(packRound(S, R)), 1);
for (const p of [R, P, S]) check(`draw ${p}`, roundWinner(packRound(p, p)), -1);

// Every digit, against the SQL: 0 draw, 1 first side, 2 second side.
for (let d = 0; d <= 8; d++) {
  const [a, b] = unpackRound(d);
  check(`pack ${d}`, packRound(a, b), d);
  const sql = (a - b + 3) % 3;
  check(`sql agrees on ${d}`, roundWinner(d), sql === 0 ? -1 : sql - 1);
  check(`how ${d}`, typeof howItWent(d), "string");
}

// Best-of: odd, 1 to 99.
check("best of 1", validBestOf(1), true);
check("best of 99", validBestOf(99), true);
check("best of 4", validBestOf(4), false);
check("best of 101", validBestOf(101), false);
check("best of 0", validBestOf(0), false);
check("best of 3.0 as a string", validBestOf("3"), false);
check("first to 3", winsNeeded(5), 3);

// Draws do not count; the game ends on the deciding round.
const win = packRound(P, R);
const loss = packRound(R, P);
const draw = packRound(S, S);
check("best of 3, 2-1", tally([win, draw, loss, draw, win], 3), { wins: [2, 1], draws: 2, winner: 0, over: true, need: 2 });
check("best of 3, still going", tally([win, loss], 3).over, false);
check("best of 1, one draw", tally([draw], 1).over, false);
check("a round after the end", tally([win, win, loss], 3), null);
check("empty", tally([], 5), { wins: [0, 0], draws: 0, winner: -1, over: false, need: 3 });

// The digits.
check("round trip", roundsToText(roundsFromText("0481")), "0481");
check("empty text", roundsFromText(""), []);
check("a 9", roundsFromText("019"), null);
check("not a string", roundsFromText(123), null);
check("too long", roundsFromText("0".repeat(MAX_ROUNDS + 1)), null);
check("finished", finishedRounds("33", 3), [3, 3]);
check("unfinished", finishedRounds("3", 3), null);
check("overrun", finishedRounds("333", 3), null);
check("bad best of", finishedRounds("33", 4), null);

if (failed) {
  console.error(`${failed} failed.`);
  process.exit(1);
}
console.log("rules ok: rounds, best-of and round digits agree with the SQL.");

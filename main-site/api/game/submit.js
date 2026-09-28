// POST /api/game/submit  { game_id, client_key, name, side, rounds? }
//   -> { name, score, outcome, total, games, won, rank }
// Puts one side of a finished game on the leaderboard. The score is that
// side's rounds won, counted here.
//
// A computer game's rounds are the server's own, thrown one at a time, and
// `rounds` is ignored. A network game's are the page's, as digits
// (js/rules.js): they must be a whole game, and match the other side's if
// that is already in. The SQL function does the checks that need the
// database.

import { endpoint, HttpError, clientKey, gameId, side as readSide, limit } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest, rpc } from "../_lib/supabase.js";
import { finishedRounds, roundsToText, tally } from "../../js/rules.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  expired: [410, "That game started more than 12 hours ago."],
  bad_side: [400, "A game against the computer has one side to submit."],
  not_yours: [403, "That game was started in a different browser."],
  same_device: [409, "Both sides of that game were played from one browser, so it stays off the leaderboard."],
  unfinished: [409, "That game is not over yet."],
  already_submitted: [409, "That game is already on the leaderboard."],
  mismatch: [409, "Those rounds do not match the ones your opponent submitted."],
  too_fast: [409, "That game was played too quickly to count."],
  same_name: [409, "Your opponent is already on the leaderboard for this game under that name. Pick another."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const who = readSide(body.side);

  await limit(req, "submit", 600, 30);

  const [game] = (await rest(`rpsgame_games?id=eq.${id}&select=mode,best_of,rounds`)) ?? [];
  if (!game) throw new HttpError(404, "not_found", REFUSALS.not_found[1]);

  const text = game.mode === "computer" ? game.rounds : body.rounds;
  const rounds = finishedRounds(text, game.best_of);
  if (!rounds) {
    if (game.mode === "computer") throw new HttpError(409, "unfinished", REFUSALS.unfinished[1]);
    throw new HttpError(400, "bad_rounds", "Those rounds are not a finished game.");
  }
  const t = tally(rounds, game.best_of);
  const score = t.wins[who];
  const outcome = t.winner === who ? "win" : "loss";

  const [row] =
    (await rpc("rpsgame_submit", {
      p_game_id: id,
      p_side: who,
      p_name: name,
      p_client_key: key,
      p_rounds: roundsToText(rounds),
      p_score: score,
      p_outcome: outcome,
    })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not submit."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  return {
    name,
    score,
    outcome,
    total: Number(row.total),
    games: row.games,
    won: row.won,
    rank: Number(row.rank),
  };
});

// POST /api/game/throw  { game_id, client_key, round, pick }
//   -> { status, rounds }
// One round of a scored game against the computer. The computer's pick is
// made here, after the player's has arrived, so a page can never know it in
// advance. round is the number of rounds the page has seen played, which
// makes a retry safe: a round already played comes back as it was, never
// played again with a different pick.
//
// status "ok" is the round played (or replayed); "over" and "out_of_step"
// carry the game's rounds as the server has them, for the page to take.

import { randomInt } from "node:crypto";
import { endpoint, HttpError, clientKey, gameId, limit } from "../_lib/http.js";
import { rpc } from "../_lib/supabase.js";
import { MAX_ROUNDS, validPick } from "../../js/rules.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  not_computer: [409, "That is not a game against the computer."],
  not_yours: [403, "That game was started in a different browser."],
  expired: [410, "That game started more than 12 hours ago."],
  too_long: [409, "That game has gone on too long."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const round = body.round;
  if (!Number.isInteger(round) || round < 0 || round >= MAX_ROUNDS) throw new HttpError(400, "bad_round");
  if (!validPick(body.pick)) throw new HttpError(400, "bad_pick");

  // Generous for a person, who needs a moment a round; a script farming
  // rounds hits it in minutes.
  await limit(req, "throw", 600, 600);

  const [row] =
    (await rpc("rpsgame_throw", {
      p_game_id: id,
      p_client_key: key,
      p_round: round,
      p_pick: body.pick,
      p_cpu: randomInt(3),
    })) ?? [];

  if (row && ["ok", "over", "out_of_step"].includes(row.status)) return { status: row.status, rounds: row.rounds };
  const [status, message] = REFUSALS[row?.status] ?? [500, "Could not play that round."];
  throw new HttpError(status, row?.status ?? "server", message);
});

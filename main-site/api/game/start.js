// POST /api/game/start  { client_key, mode, best_of } -> { game_id, created_at }
// The start ticket. A game can only go on the leaderboard if it began here.
// Games started offline, and practice games, play the same without one.
//
// mode is "computer" or "network". A computer game's rounds are then
// thrown through /api/game/throw; a network game's are submitted at the end.

import { endpoint, HttpError, clientKey, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { validBestOf } from "../../js/rules.js";

export default endpoint("POST", async ({ req, body }) => {
  const key = clientKey(body.client_key);
  const mode = body.mode;
  if (mode !== "computer" && mode !== "network") throw new HttpError(400, "bad_mode");
  const bestOf = body.best_of;
  if (!validBestOf(bestOf)) throw new HttpError(400, "bad_best_of", "Best of is an odd number from 1 to 99.");

  await limit(req, "start", 600, 60);

  const [row] = await rest("rpsgame_games?select=id,created_at", {
    method: "POST",
    prefer: "return=representation",
    // A computer game's rounds are written as they are thrown; a network
    // game's by its first accepted submission.
    body: { mode, best_of: bestOf, host_key: key, rounds: mode === "computer" ? "" : null },
  });

  // Now and then, clear out what nobody will submit.
  if (Math.random() < 0.02) rpc("rpsgame_prune", {}).catch(() => {});

  return { game_id: row.id, created_at: row.created_at };
});

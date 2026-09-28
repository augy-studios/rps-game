// GET /api/leaderboard
//   -> { entries: [{ rank, name, total, games, won }] }
// Rounds won, added up per name. Public, no login, cached briefly at the
// edge.

import { endpoint } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

const LIMIT = 100;

export default endpoint("GET", async ({ res }) => {
  const rows = await rest(
    `rpsgame_leaderboard_total?select=name,total,games,won&order=total.desc,games.asc,last_at.asc&limit=${LIMIT}`
  );
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  return {
    entries: (rows ?? []).map((r, i) => ({ rank: i + 1, name: r.name, total: Number(r.total), games: r.games, won: r.won })),
  };
});

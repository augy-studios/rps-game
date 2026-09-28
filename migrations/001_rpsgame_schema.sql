-- Rock Paper Scissors (rps.uwuapps.org) schema, in the shared uwuapps
-- Supabase project. Paste into the Supabase SQL editor and run once. Safe to
-- run again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions touch these tables, with the
-- service role key. RLS is on with no policies, so an anon key reads nothing.
--
-- A round is one digit, 0 to 8: the first side's pick times three plus the
-- second side's, where a pick is 0 rock, 1 paper, 2 scissors. The first side
-- is the player against the computer, or the host of a network game. Best of
-- N is first to (N + 1) / 2 rounds won; drawn rounds are played again.
-- main-site/js/rules.js holds the same rules for the browser and the API.

-- One row per game that could go on the leaderboard, started while online.
-- created_at is the server's clock, which a browser cannot move.
create table if not exists rpsgame_games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('computer', 'network')),
  best_of smallint not null check (best_of between 1 and 99 and best_of % 2 = 1),
  host_key text not null,               -- the client_key that started it
  created_at timestamptz not null default now(),
  -- Computer games: every round so far, written by rpsgame_throw as it is
  -- played, so the computer's picks are the server's. Network games: null
  -- until the first accepted submission, which the second must match.
  rounds text check (rounds ~ '^[0-8]*$' and length(rounds) <= 1000),
  -- Computer games: rounds won so far by the player (a) and the computer (b).
  wins_a smallint not null default 0,
  wins_b smallint not null default 0,
  finished_at timestamptz,
  check (mode = 'network' or rounds is not null)
);

create index if not exists rpsgame_games_created on rpsgame_games (created_at);

-- One row per side of a game on the board. score is that side's rounds won.
create table if not exists rpsgame_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null check (score >= 0),
  game_id uuid not null references rpsgame_games(id) on delete cascade,
  side smallint not null check (side in (0, 1)),
  mode text not null,
  best_of smallint not null,
  outcome text not null check (outcome in ('win', 'loss')),
  created_at timestamptz not null default now(),
  unique (game_id, side)
);

create index if not exists rpsgame_lb_name on rpsgame_leaderboard (lower(name));

-- The board: rounds won added up per name, with games played and won. The
-- casing shown is the most recent one.
create or replace view rpsgame_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  (count(*) filter (where outcome = 'win'))::int as won,
  max(created_at) as last_at
from rpsgame_leaderboard
group by lower(name);

-- Fixed window counters for rate limiting by (hashed) IP. There are no
-- accounts to limit against, and Vercel functions share no memory.
create table if not exists rpsgame_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits int not null
);

alter table rpsgame_games enable row level security;
alter table rpsgame_leaderboard enable row level security;
alter table rpsgame_rate_limits enable row level security;

-- True while the bucket is under its limit. One statement, so concurrent
-- hits cannot both read the old count.
create or replace function rpsgame_hit(p_bucket text, p_window_seconds int, p_max int)
returns boolean
language sql
volatile
as $$
  insert into rpsgame_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    window_start = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else r.window_start end,
    hits = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else r.hits + 1 end
  returning hits <= p_max;
$$;

-- Plays one round of a computer game. p_cpu is the computer's pick, made by
-- the API after the player's arrived. p_round is how many rounds the page
-- has seen, so a retry after a lost reply returns the round as it was
-- rather than playing it again:
--
--   ok            played, or already played; rounds is the game so far
--   out_of_step   the page is ahead of the server; rounds is the server's
--   over          the game has already ended
--   not_found, not_computer, not_yours, expired, too_long
create or replace function rpsgame_throw(
  p_game_id uuid,
  p_client_key text,
  p_round int,
  p_pick smallint,
  p_cpu smallint
)
returns table (status text, rounds text)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game rpsgame_games%rowtype;
  v_need int;
  v_result int;
  v_a int;
  v_b int;
  v_rounds text;
begin
  select * into v_game from rpsgame_games g where g.id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_game.mode <> 'computer' then
    return query select 'not_computer'::text, null::text;
    return;
  end if;
  if v_game.host_key <> p_client_key then
    return query select 'not_yours'::text, null::text;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::text;
    return;
  end if;
  if p_pick not between 0 and 2 or p_cpu not between 0 and 2 then
    return query select 'bad_pick'::text, null::text;
    return;
  end if;

  if p_round < length(v_game.rounds) then
    return query select 'ok'::text, v_game.rounds;
    return;
  end if;
  if p_round > length(v_game.rounds) then
    return query select 'out_of_step'::text, v_game.rounds;
    return;
  end if;

  v_need := (v_game.best_of + 1) / 2;
  if v_game.wins_a >= v_need or v_game.wins_b >= v_need then
    return query select 'over'::text, v_game.rounds;
    return;
  end if;
  if length(v_game.rounds) >= 1000 then
    return query select 'too_long'::text, v_game.rounds;
    return;
  end if;

  -- 0 a draw, 1 the player won, 2 the computer did.
  v_result := (p_pick - p_cpu + 3) % 3;
  v_a := v_game.wins_a + case when v_result = 1 then 1 else 0 end;
  v_b := v_game.wins_b + case when v_result = 2 then 1 else 0 end;
  v_rounds := v_game.rounds || (p_pick * 3 + p_cpu)::text;

  update rpsgame_games g set
    rounds = v_rounds,
    wins_a = v_a,
    wins_b = v_b,
    finished_at = case when v_a >= v_need or v_b >= v_need then now() else null end
  where g.id = p_game_id;

  return query select 'ok'::text, v_rounds;
end;
$$;

-- Puts one side of a finished game on the board. The API has already
-- checked the rounds make a whole game and counted the score; this checks
-- what only the database can:
--
--   not_found          no such game
--   expired            started more than 12 hours ago
--   bad_side           a computer game has only the player's side
--   not_yours          a computer game, or a network host side, submitted
--                      from a browser other than the one that started it
--   same_device        a network game's guest side submitted from the host's
--                      own browser: one person playing both sides
--   unfinished         a computer game the server has not seen end
--   already_submitted  this side of this game is already on the board
--   mismatch           rounds different from the server's, or from the other
--                      side's submission
--   too_fast           a network game finished sooner than a second a round,
--                      or five seconds in all
--   same_name          both sides of one network game under one name
create or replace function rpsgame_submit(
  p_game_id uuid,
  p_side smallint,
  p_name text,
  p_client_key text,
  p_rounds text,
  p_score int,
  p_outcome text
)
returns table (status text, total bigint, games int, won int, rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game rpsgame_games%rowtype;
  v_total bigint;
  v_games int;
  v_won int;
begin
  select * into v_game from rpsgame_games g where g.id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::bigint, null::int, null::int, null::bigint;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::bigint, null::int, null::int, null::bigint;
    return;
  end if;

  if v_game.mode = 'computer' then
    if p_side <> 0 then
      return query select 'bad_side'::text, null::bigint, null::int, null::int, null::bigint;
      return;
    end if;
    if p_client_key <> v_game.host_key then
      return query select 'not_yours'::text, null::bigint, null::int, null::int, null::bigint;
      return;
    end if;
    if v_game.finished_at is null then
      return query select 'unfinished'::text, null::bigint, null::int, null::int, null::bigint;
      return;
    end if;
  else
    if p_side = 0 and p_client_key <> v_game.host_key then
      return query select 'not_yours'::text, null::bigint, null::int, null::int, null::bigint;
      return;
    end if;
    if p_side = 1 and p_client_key = v_game.host_key then
      return query select 'same_device'::text, null::bigint, null::int, null::int, null::bigint;
      return;
    end if;
  end if;

  if exists (select 1 from rpsgame_leaderboard l where l.game_id = p_game_id and l.side = p_side) then
    return query select 'already_submitted'::text, null::bigint, null::int, null::int, null::bigint;
    return;
  end if;
  if v_game.rounds is not null and v_game.rounds <> p_rounds then
    return query select 'mismatch'::text, null::bigint, null::int, null::int, null::bigint;
    return;
  end if;
  if v_game.mode = 'network'
    and now() - v_game.created_at < make_interval(secs => greatest(5, length(p_rounds))) then
    return query select 'too_fast'::text, null::bigint, null::int, null::int, null::bigint;
    return;
  end if;

  -- One submission per name at a time, so two sent together cannot both
  -- miss each other in the check below.
  perform pg_advisory_xact_lock(hashtext('rpsgame_submit:' || lower(p_name)));

  if exists (
    select 1 from rpsgame_leaderboard l
    where l.game_id = p_game_id and lower(l.name) = lower(p_name)
  ) then
    return query select 'same_name'::text, null::bigint, null::int, null::int, null::bigint;
    return;
  end if;

  if v_game.rounds is null then
    update rpsgame_games g set rounds = p_rounds, finished_at = now() where g.id = p_game_id;
  end if;

  insert into rpsgame_leaderboard (name, score, game_id, side, mode, best_of, outcome)
  values (p_name, p_score, p_game_id, p_side, v_game.mode, v_game.best_of, p_outcome);

  select sum(l.score)::bigint, count(*)::int, (count(*) filter (where l.outcome = 'win'))::int
  into v_total, v_games, v_won
  from rpsgame_leaderboard l
  where lower(l.name) = lower(p_name);

  return query
  select
    'ok'::text,
    v_total,
    v_games,
    v_won,
    (
      select count(*) + 1
      from rpsgame_leaderboard_total t
      where lower(t.name) <> lower(p_name)
        and (
          t.total > v_total
          or (t.total = v_total and t.games < v_games)
          -- This name's total was only just reached, so an equal one got there first.
          or (t.total = v_total and t.games = v_games)
        )
    );
end;
$$;

-- Housekeeping, called now and then by /api/game/start: old counters, and
-- games nobody submitted that are past any use.
create or replace function rpsgame_prune()
returns void
language sql
volatile
as $$
  delete from rpsgame_rate_limits where window_start < now() - interval '1 day';
  delete from rpsgame_games g
  where g.created_at < now() - interval '2 days'
    and not exists (select 1 from rpsgame_leaderboard l where l.game_id = g.id);
$$;

-- Service role only.
revoke all on function rpsgame_hit(text, int, int) from public, anon, authenticated;
revoke all on function rpsgame_throw(uuid, text, int, smallint, smallint) from public, anon, authenticated;
revoke all on function rpsgame_submit(uuid, smallint, text, text, text, int, text) from public, anon, authenticated;
revoke all on function rpsgame_prune() from public, anon, authenticated;
grant execute on function rpsgame_hit(text, int, int) to service_role;
grant execute on function rpsgame_throw(uuid, text, int, smallint, smallint) to service_role;
grant execute on function rpsgame_submit(uuid, smallint, text, text, text, int, text) to service_role;
grant execute on function rpsgame_prune() to service_role;

create table if not exists matches (
  id text primary key,
  code text not null unique,
  status text not null,
  mode text not null,
  settings jsonb not null default '{}'::jsonb,
  host_player_id text,
  guest_player_id text,
  winner_player_id text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists match_results (
  id bigint generated always as identity primary key,
  match_id text not null,
  winner_player_id text,
  win_reason text,
  mode text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_matches_code on matches(code);
create index if not exists idx_match_results_match_id on match_results(match_id);

-- ── Leaderboard / profiles ────────────────────────────────────────────────

create table if not exists players (
  wallet_address text primary key,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists scores (
  id bigint generated always as identity primary key,
  wallet_address text not null,
  name text,
  mode text not null,            -- classic_coil | time_attack | last_survivor | first_to_length | apple_rush | highest_score
  opponent text not null default 'solo', -- solo | ai | pvp
  difficulty text,               -- easy | medium | hard | master | null
  score int not null default 0,
  length int not null default 0,
  apples int not null default 0,
  duration_ms int,               -- time taken; used for apple_rush / first_to_length "within less time" tiebreak
  won boolean,                   -- vs modes only
  streak int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists streaks (
  wallet_address text not null,
  scope text not null,           -- 'pvai' | 'pvp'
  current_streak int not null default 0,
  best_streak int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (wallet_address, scope)
);

create index if not exists idx_scores_mode on scores(mode, difficulty, opponent);
create index if not exists idx_scores_rank on scores(mode, score desc, length desc);
create index if not exists idx_scores_wallet on scores(wallet_address);

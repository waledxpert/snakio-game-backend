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

# 🧠 Memory Log
> Append-only. Never delete or edit previous entries.
> Initialized: 2026-07-01

---

## [2026-07-01] — Leaderboard / scores / profiles API + PvP score persistence (backend)

### Project Status & Decisions
- Added the persistence + REST layer for the arcade leaderboard, player profiles, and winning streaks. Frontend work tracked in `snakio-games/.memory`.
- **Ranking model:** `fetchLeaderboard` caps at top 100 then paginates in memory (so `total` reflects the cap, not the whole table). Per-mode ordering — `apple_rush`: apples ↓ then duration ↑; `first_to_length`: length ↓ then duration ↑; everything else (incl. `all`): score ↓ then length ↓.
- **Streaks:** `streaks(wallet_address, scope)` where scope is `pvai` or `pvp`; `bumpStreak` increments on win / resets on loss and stamps `streak` onto the score row. Only called with a boolean `won` (draws don't touch streaks).
- **PvP now feeds the leaderboard:** `persistMatchResult` writes one `scores` row per player (`opponent:'pvp'`) + bumps PvP streaks, for players with a wallet.

### Tech Stack & Tools
- Node ESM, Express 5, socket.io 4, zod 4, `@supabase/supabase-js` 2. Run: `npm run dev` / `npm start`.
- Admin clear: `npm run clear-leaderboard` (script `scripts/clearLeaderboard.js`, supports `--mode/--difficulty/--opponent`) and `DELETE /api/leaderboard` gated by `ADMIN_KEY` via `x-admin-key` header.

### Problems Solved / Lessons Learned
- **CRITICAL env bug:** `SUPABASE_URL` in `.env` was a *postgres connection string*, which `@supabase/supabase-js` silently rejects (`createClient` guard requires `https?://`) — so `supabase` was `null` and NOTHING persisted (incl. pre-existing PvP snapshots). Fixed to the HTTPS project URL `https://uhkraauepmrmcclcrrwh.supabase.co`. Lesson: supabase-js needs the REST URL, not the DB DSN.
- **Duplicate identifier:** `server.js` already had a local `getPlayer(room, playerId)`; the new import collided and crashed boot with `SyntaxError: Identifier 'getPlayer' has already been declared`. Fixed by importing as `getPlayerProfile`.
- **Direct DB host unreachable from this environment:** `db.<ref>.supabase.co:5432` fails `ENOTFOUND` (IPv6-only), while the HTTPS REST API resolves fine. Schema must be applied via the Supabase SQL editor — `_migrate.mjs` + temp `pg` install could not connect and were removed.
- **Supabase delete requires a filter:** `clearScores` unfiltered uses `.gte("id", 0)` as an always-true guard; `resetStreaks` uses `.gte("current_streak", 0)`.

### Key Files Added / Changed
- `supabase-schema.sql`: `players`, `scores`, `streaks` + indexes.
- `src/supabase.js`: `upsertPlayer`, `getPlayer`, `insertScore`, `bumpStreak`, `fetchLeaderboard`, `clearScores`, `resetStreaks`; extended `persistMatchResult`.
- `src/server.js`: `POST/GET /api/players`, `POST /api/scores`, `GET`+`DELETE /api/leaderboard`, `submitScoreSchema`/`upsertPlayerSchema`.
- `scripts/clearLeaderboard.js`, `package.json` (`clear-leaderboard` script), `.env` + `.env.example` (`ADMIN_KEY`, fixed `SUPABASE_URL`).

### Goals & Next Steps
- **PENDING (manual):** run `supabase-schema.sql` in the Supabase SQL editor — tables don't exist yet; helpers no-op gracefully (`null`/empty) until then.
- Verified: server boots, all endpoints respond over HTTPS; got "Could not find table 'public.scores'" (expected pre-migration) proving the client + routes work.
- Possible follow-ups: rate-limit/validate `POST /api/scores` (currently client-trusted); add a `GET /api/players/:address` profile UI; consider RLS policies if the anon key ever touches these tables.

---

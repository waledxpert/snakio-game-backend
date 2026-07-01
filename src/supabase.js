import { createClient } from "@supabase/supabase-js";

const rawUrl = process.env.SUPABASE_URL || "";
const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const url = rawUrl.trim();
const key = rawKey.trim();
const hasValidUrl = /^https?:\/\//i.test(url);

export const supabase = hasValidUrl && key
  ? createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export async function persistRoomSnapshot(room) {
  if (!supabase) return;
  try {
    await supabase.from("matches").upsert({
      id: room.id,
      code: room.code,
      status: room.status,
      mode: room.mode,
      settings: room.settings,
      host_player_id: room.players[0]?.id ?? null,
      guest_player_id: room.players[1]?.id ?? null,
      winner_player_id: room.result?.winnerPlayerId ?? null,
      started_at: room.startedAt ? new Date(room.startedAt).toISOString() : null,
      ended_at: room.endedAt ? new Date(room.endedAt).toISOString() : null,
      created_at: new Date(room.createdAt).toISOString(),
    });
  } catch (error) {
    console.warn("supabase snapshot failed:", error.message);
  }
}

export async function persistMatchResult(room) {
  if (!supabase || !room.result) return;
  try {
    await supabase.from("match_results").insert({
      match_id: room.id,
      winner_player_id: room.result.winnerPlayerId,
      win_reason: room.result.reason,
      mode: room.mode,
      payload: {
        players: room.players,
        settings: room.settings,
      },
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("supabase result persist failed:", error.message);
  }

  // Also record each player's run on the leaderboard (opponent = pvp) and
  // bump their PvP winning streak. Only players with a wallet are ranked.
  try {
    const startedAt = room.startedAt || room.createdAt || Date.now();
    const durationMs = room.endedAt ? Math.max(0, room.endedAt - startedAt) : null;
    for (const player of room.players) {
      const wallet = normalizeAddress(player.walletAddress);
      if (!wallet) continue;
      const won = room.result.winnerPlayerId === player.id;
      const { current } = await bumpStreak(wallet, "pvp", won);
      await insertScore({
        walletAddress: wallet,
        name: player.nickname || null,
        mode: room.mode,
        opponent: "pvp",
        difficulty: null,
        score: player.score || 0,
        length: player.length || 0,
        apples: player.applesCollected || 0,
        durationMs,
        won,
        streak: current,
      });
    }
  } catch (error) {
    console.warn("supabase pvp leaderboard persist failed:", error.message);
  }
}

// ── Leaderboard / profiles ─────────────────────────────────────────────────

function normalizeAddress(address) {
  if (!address || typeof address !== "string") return null;
  const trimmed = address.trim().toLowerCase();
  return trimmed || null;
}

export async function upsertPlayer({ walletAddress, name }) {
  if (!supabase) return null;
  const wallet = normalizeAddress(walletAddress);
  if (!wallet) return null;
  const cleanName = typeof name === "string" ? name.trim().slice(0, 20) : null;
  try {
    const { data, error } = await supabase
      .from("players")
      .upsert(
        {
          wallet_address: wallet,
          name: cleanName || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "wallet_address" },
      )
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn("supabase upsertPlayer failed:", error.message);
    return null;
  }
}

export async function getPlayer(walletAddress) {
  if (!supabase) return null;
  const wallet = normalizeAddress(walletAddress);
  if (!wallet) return null;
  try {
    const [{ data: player }, { data: streakRows }, { data: bestRows }] =
      await Promise.all([
        supabase.from("players").select("*").eq("wallet_address", wallet).maybeSingle(),
        supabase.from("streaks").select("*").eq("wallet_address", wallet),
        supabase
          .from("scores")
          .select("mode, opponent, difficulty, score, length, apples, won, created_at")
          .eq("wallet_address", wallet)
          .order("score", { ascending: false })
          .limit(50),
      ]);
    return {
      walletAddress: wallet,
      name: player?.name ?? null,
      streaks: streakRows ?? [],
      scores: bestRows ?? [],
    };
  } catch (error) {
    console.warn("supabase getPlayer failed:", error.message);
    return null;
  }
}

export async function insertScore(row) {
  if (!supabase) return null;
  const wallet = normalizeAddress(row.walletAddress);
  if (!wallet) return null;
  try {
    const { data, error } = await supabase
      .from("scores")
      .insert({
        wallet_address: wallet,
        name: typeof row.name === "string" ? row.name.trim().slice(0, 20) : null,
        mode: row.mode,
        opponent: row.opponent || "solo",
        difficulty: row.difficulty ?? null,
        score: Math.max(0, Math.trunc(row.score || 0)),
        length: Math.max(0, Math.trunc(row.length || 0)),
        apples: Math.max(0, Math.trunc(row.apples || 0)),
        duration_ms:
          row.durationMs == null ? null : Math.max(0, Math.trunc(row.durationMs)),
        won: typeof row.won === "boolean" ? row.won : null,
        streak: Math.max(0, Math.trunc(row.streak || 0)),
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn("supabase insertScore failed:", error.message);
    return null;
  }
}

export async function bumpStreak(walletAddress, scope, won) {
  if (!supabase) return { current: 0, best: 0 };
  const wallet = normalizeAddress(walletAddress);
  if (!wallet) return { current: 0, best: 0 };
  try {
    const { data: existing } = await supabase
      .from("streaks")
      .select("*")
      .eq("wallet_address", wallet)
      .eq("scope", scope)
      .maybeSingle();

    const prevCurrent = existing?.current_streak ?? 0;
    const prevBest = existing?.best_streak ?? 0;
    const current = won ? prevCurrent + 1 : 0;
    const best = Math.max(prevBest, current);

    await supabase.from("streaks").upsert(
      {
        wallet_address: wallet,
        scope,
        current_streak: current,
        best_streak: best,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "wallet_address,scope" },
    );
    return { current, best };
  } catch (error) {
    console.warn("supabase bumpStreak failed:", error.message);
    return { current: 0, best: 0 };
  }
}

// Column priority per mode — first column is the primary ranking metric.
function orderForMode(mode) {
  switch (mode) {
    case "first_to_length":
      return [
        { column: "length", ascending: false },
        { column: "duration_ms", ascending: true, nullsFirst: false },
      ];
    case "apple_rush":
      return [
        { column: "apples", ascending: false },
        { column: "duration_ms", ascending: true, nullsFirst: false },
      ];
    default:
      // all, classic_coil, time_attack, highest_score, last_survivor
      return [
        { column: "score", ascending: false },
        { column: "length", ascending: false },
      ];
  }
}

const LEADERBOARD_CAP = 100;

export async function fetchLeaderboard({
  mode = "all",
  difficulty = "all",
  opponent = "all",
  page = 1,
  pageSize = 20,
} = {}) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safeSize = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 20)));
  const empty = { entries: [], total: 0, page: safePage, pageSize: safeSize };
  if (!supabase) return empty;

  try {
    let query = supabase.from("scores").select("*");
    if (mode && mode !== "all") query = query.eq("mode", mode);
    if (difficulty && difficulty !== "all") query = query.eq("difficulty", difficulty);
    if (opponent && opponent !== "all") query = query.eq("opponent", opponent);

    for (const order of orderForMode(mode)) {
      query = query.order(order.column, {
        ascending: order.ascending,
        nullsFirst: order.nullsFirst ?? false,
      });
    }
    query = query.order("created_at", { ascending: true });

    // Pull the capped top slice, then paginate in memory so `total` reflects
    // the leaderboard cap (top 100) rather than the whole table.
    const { data, error } = await query.limit(LEADERBOARD_CAP);
    if (error) throw error;

    const capped = data ?? [];
    const total = capped.length;
    const start = (safePage - 1) * safeSize;
    const entries = capped.slice(start, start + safeSize).map((row, index) => ({
      rank: start + index + 1,
      walletAddress: row.wallet_address,
      name: row.name,
      mode: row.mode,
      opponent: row.opponent,
      difficulty: row.difficulty,
      score: row.score,
      length: row.length,
      apples: row.apples,
      durationMs: row.duration_ms,
      won: row.won,
      streak: row.streak,
      createdAt: row.created_at,
    }));

    return { entries, total, page: safePage, pageSize: safeSize };
  } catch (error) {
    console.warn("supabase fetchLeaderboard failed:", error.message);
    return empty;
  }
}

export async function clearScores({ mode, difficulty, opponent } = {}) {
  if (!supabase) return { deleted: 0 };
  try {
    let query = supabase.from("scores").delete({ count: "exact" });
    let filtered = false;
    if (mode && mode !== "all") { query = query.eq("mode", mode); filtered = true; }
    if (difficulty && difficulty !== "all") { query = query.eq("difficulty", difficulty); filtered = true; }
    if (opponent && opponent !== "all") { query = query.eq("opponent", opponent); filtered = true; }
    // Supabase requires a filter on delete — use an always-true guard for "all".
    if (!filtered) query = query.gte("id", 0);
    const { error, count } = await query;
    if (error) throw error;
    return { deleted: count ?? 0 };
  } catch (error) {
    console.warn("supabase clearScores failed:", error.message);
    return { deleted: 0 };
  }
}

export async function resetStreaks() {
  if (!supabase) return { deleted: 0 };
  try {
    const { error, count } = await supabase
      .from("streaks")
      .delete({ count: "exact" })
      .gte("current_streak", 0);
    if (error) throw error;
    return { deleted: count ?? 0 };
  } catch (error) {
    console.warn("supabase resetStreaks failed:", error.message);
    return { deleted: 0 };
  }
}

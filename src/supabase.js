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
}

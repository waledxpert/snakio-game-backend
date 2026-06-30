import "dotenv/config";
import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { customAlphabet, nanoid } from "nanoid";
import { z } from "zod";
import { persistMatchResult, persistRoomSnapshot } from "./supabase.js";

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const allowedOrigins = FRONTEND_URL.split(",").map((value) => value.trim()).filter(Boolean);
const createCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const SHARE_TTL_MS = 1000 * 60 * 5;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

const rooms = new Map();
const sharedResults = new Map();

const snakeSnapshotSchema = z.object({
  tokenId: z.union([z.string(), z.number()]),
  name: z.string(),
  len: z.number().optional(),
  image: z.string().optional(),
  traits: z.object({
    rarity: z.string(),
    skinSeries: z.string(),
    skin: z.string(),
    formSeries: z.string(),
    form: z.string(),
    mark: z.string(),
    gaze: z.string(),
    crown: z.string(),
    sigil: z.string(),
    curse: z.string(),
    bodyPattern: z.string(),
  }),
});

const playerSchema = z.object({
  nickname: z.string().trim().min(1).max(20),
  snakeId: z.union([z.string(), z.number()]),
  snake: snakeSnapshotSchema.nullable().optional(),
  backgroundId: z.string().trim().min(1),
  walletAddress: z.string().nullable().optional(),
});

const createMatchSchema = z.object({
  hostPlayer: playerSchema,
  mode: z.enum(["time_attack", "last_survivor", "first_to_length", "highest_score", "apple_rush"]),
  settings: z.object({
    durationSeconds: z.number().int().positive().optional(),
    targetLength: z.number().int().positive().optional(),
    targetApples: z.number().int().positive().optional(),
  }).default({}),
});

const joinMatchSchema = z.object({
  guestPlayer: playerSchema,
});

const progressSchema = z.object({
  code: z.string(),
  playerId: z.string(),
  playerToken: z.string(),
  score: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  alive: z.boolean(),
  applesCollected: z.number().int().nonnegative(),
  clientTime: z.number().optional(),
});

const playerAuthSchema = z.object({
  playerId: z.string(),
  playerToken: z.string(),
});

function normalizeSettings(mode, settings = {}) {
  switch (mode) {
    case "time_attack":
      return { durationSeconds: settings.durationSeconds || 180 };
    case "first_to_length":
      return { targetLength: settings.targetLength || 100 };
    case "apple_rush":
      return { targetApples: settings.targetApples || 25 };
    default:
      return {};
  }
}

function createPlayer(data, role) {
  return {
    id: nanoid(12),
    authToken: nanoid(24),
    role,
    nickname: data.nickname,
    snakeId: String(data.snakeId),
    backgroundId: data.backgroundId,
    snake: data.snake || null,
    walletAddress: data.walletAddress || null,
    ready: false,
    connected: false,
    socketId: null,
    alive: true,
    score: 0,
    length: 4,
    applesCollected: 0,
    thresholdReachedAt: null,
    joinedAt: Date.now(),
  };
}

function frontendBase() {
  return (allowedOrigins[0] || FRONTEND_URL).replace(/\/$/, "");
}

function buildInviteUrl(code) {
  return `${frontendBase()}/play/${code}`;
}

function buildShareUrl(shareId) {
  return `${frontendBase()}/share/${shareId}`;
}

function createRoom(input) {
  const code = createCode();
  const host = createPlayer(input.hostPlayer, "host");
  const room = {
    id: nanoid(16),
    code,
    inviteUrl: buildInviteUrl(code),
    status: "waiting",
    mode: input.mode,
    settings: normalizeSettings(input.mode, input.settings),
    players: [host],
    result: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    countdownTimer: null,
    matchTimer: null,
  };
  rooms.set(code, room);
  void persistRoomSnapshot(room);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code).toUpperCase()) || null;
}

function getPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null;
}

function authorizePlayer(room, playerId, playerToken) {
  const player = getPlayer(room, playerId);
  if (!player) return null;
  return player.authToken === playerToken ? player : null;
}

function remainingSeconds(room) {
  if (room.status !== "playing" || room.mode !== "time_attack") return null;
  const elapsed = Math.floor((Date.now() - room.startedAt) / 1000);
  return Math.max(0, room.settings.durationSeconds - elapsed);
}

function publicRoom(room) {
  return {
    id: room.id,
    code: room.code,
    inviteUrl: room.inviteUrl,
    status: room.status,
    mode: room.mode,
    settings: room.settings,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    remainingSeconds: remainingSeconds(room),
    result: room.result,
    rematchCode: room.rematchCode || null,
    rematchInviteUrl: room.rematchInviteUrl || null,
    players: room.players.map((player) => ({

      id: player.id,
      role: player.role,
      nickname: player.nickname,
      snakeId: player.snakeId,
      backgroundId: player.backgroundId,
      snake: player.snake,
      walletAddress: player.walletAddress,
      ready: player.ready,
      connected: player.connected,
      alive: player.alive,
      score: player.score,
      length: player.length,
      applesCollected: player.applesCollected,
    })),
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:state", publicRoom(room));
  void persistRoomSnapshot(room);
}

function clearRoomTimers(room) {
  if (room.countdownTimer) clearInterval(room.countdownTimer);
  if (room.matchTimer) clearInterval(room.matchTimer);
  room.countdownTimer = null;
  room.matchTimer = null;
}

function resetPlayersForMatch(room) {
  room.players.forEach((player) => {
    player.alive = true;
    player.score = 0;
    player.length = 4;
    player.applesCollected = 0;
    player.thresholdReachedAt = null;
  });
}

function comparePlayers(a, b) {
  if (a.score !== b.score) return a.score > b.score ? a : b;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  if (a.applesCollected !== b.applesCollected) return a.applesCollected > b.applesCollected ? a : b;
  return null;
}

function finishMatch(room, result) {
  if (room.status === "finished") return;
  clearRoomTimers(room);
  room.status = "finished";
  room.result = result;
  room.endedAt = Date.now();
  emitRoom(room);
  io.to(room.code).emit("match:ended", result);
  void persistMatchResult(room);
}

function evaluateRoom(room) {
  const [host, guest] = room.players;
  if (!host || !guest) return null;

  if (room.mode === "time_attack") {
    if (remainingSeconds(room) === 0) {
      const winner = comparePlayers(host, guest);
      return {
        winnerPlayerId: winner?.id ?? null,
        reason: winner ? "Time expired" : "Time expired in a draw",
      };
    }
    return null;
  }

  if (room.mode === "last_survivor") {
    if (!host.alive && guest.alive) return { winnerPlayerId: guest.id, reason: `${host.nickname} crashed first` };
    if (!guest.alive && host.alive) return { winnerPlayerId: host.id, reason: `${guest.nickname} crashed first` };
    if (!host.alive && !guest.alive) {
      const winner = comparePlayers(host, guest);
      return {
        winnerPlayerId: winner?.id ?? null,
        reason: winner ? "Both crashed, score tie-breaker applied" : "Both players crashed",
      };
    }
    return null;
  }

  if (room.mode === "first_to_length") {
    const target = room.settings.targetLength || 100;
    const reached = room.players.filter((player) => player.length >= target);
    if (!reached.length) return null;
    reached.sort((a, b) => (a.thresholdReachedAt || Infinity) - (b.thresholdReachedAt || Infinity));
    return { winnerPlayerId: reached[0].id, reason: `${reached[0].nickname} reached length ${target}` };
  }

  if (room.mode === "apple_rush") {
    const target = room.settings.targetApples || 25;
    const reached = room.players.filter((player) => player.applesCollected >= target);
    if (!reached.length) return null;
    reached.sort((a, b) => (a.thresholdReachedAt || Infinity) - (b.thresholdReachedAt || Infinity));
    return { winnerPlayerId: reached[0].id, reason: `${reached[0].nickname} collected ${target} apples first` };
  }

  if (room.mode === "highest_score") {
    if (room.players.every((player) => !player.alive)) {
      const winner = comparePlayers(host, guest);
      return {
        winnerPlayerId: winner?.id ?? null,
        reason: winner ? "Both players died, highest score wins" : "Both players died in a draw",
      };
    }
  }

  return null;
}

function startMatch(room) {
  clearRoomTimers(room);
  resetPlayersForMatch(room);
  room.status = "playing";
  room.result = null;
  room.startedAt = Date.now();
  room.endedAt = null;
  emitRoom(room);
  io.to(room.code).emit("match:started", { code: room.code, startedAt: room.startedAt });

  if (room.mode === "time_attack") {
    room.matchTimer = setInterval(() => {
      const result = evaluateRoom(room);
      if (result) finishMatch(room, result);
      else emitRoom(room);
    }, 1000);
  }
}

function beginCountdown(room) {
  if (room.status !== "waiting") return;
  room.status = "countdown";
  let count = 3;
  emitRoom(room);
  io.to(room.code).emit("match:countdown", { count });
  room.countdownTimer = setInterval(() => {
    count -= 1;
    if (count > 0) {
      io.to(room.code).emit("match:countdown", { count });
      emitRoom(room);
      return;
    }
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
    startMatch(room);
  }, 1000);
}

function createSharePayload(room, playerId) {
  const winner = room.players.find((player) => player.id === room.result?.winnerPlayerId) || null;
  const isWinner = room.result?.winnerPlayerId === playerId;
  return {
    room: publicRoom(room),
    resultLabel: room.result?.winnerPlayerId ? (isWinner ? "YOU WIN" : winner ? `${winner.nickname} WINS` : "MATCH COMPLETE") : "DRAW",
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, shares: sharedResults.size });
});

app.post("/api/matches", (req, res) => {
  const parsed = createMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid create match payload" });
  }
  const room = createRoom(parsed.data);
  return res.status(201).json({
    code: room.code,
    inviteUrl: room.inviteUrl,
    hostPlayerId: room.players[0].id,
    hostPlayerToken: room.players[0].authToken,
    room: publicRoom(room),
  });
});

app.get("/api/matches/:code", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: "Match not found" });
  return res.json(publicRoom(room));
});

app.post("/api/matches/:code/join", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: "Match not found" });
  if (room.players.length >= 2) return res.status(409).json({ error: "Match already has two players" });

  const parsed = joinMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid join payload" });
  }

  const guest = createPlayer(parsed.data.guestPlayer, "guest");
  room.players.push(guest);
  emitRoom(room);
  return res.status(201).json({
    guestPlayerId: guest.id,
    guestPlayerToken: guest.authToken,
    room: publicRoom(room),
  });
});

app.post("/api/matches/:code/share", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: "Match not found" });
  if (room.status !== "finished" || !room.result) return res.status(409).json({ error: "Match is not finished yet" });

  const parsed = playerAuthSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing player credentials" });
  const player = authorizePlayer(room, parsed.data.playerId, parsed.data.playerToken);
  if (!player) return res.status(403).json({ error: "You are not allowed to share this result" });

  const shareId = nanoid(8);
  const expiresAt = Date.now() + SHARE_TTL_MS;
  sharedResults.set(shareId, {
    expiresAt,
    payload: {
      ...createSharePayload(room, player.id),
      expiresAt,
    },
  });

  return res.status(201).json({
    shareId,
    shareUrl: buildShareUrl(shareId),
    expiresAt,
  });
});

// POST /api/matches/:code/rematch
// A finished match's player calls this to create a fresh room with the same
// mode + settings. They become the host. Returns credentials + a new invite URL.
app.post("/api/matches/:code/rematch", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: "Match not found" });
  if (room.status !== "finished") return res.status(409).json({ error: "Match is not finished yet" });

  const parsed = playerAuthSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Missing player credentials" });
  const player = authorizePlayer(room, parsed.data.playerId, parsed.data.playerToken);
  if (!player) return res.status(403).json({ error: "You are not a player in this match" });

  // Build the new room with the same mode/settings. The requester becomes host.
  const newRoom = createRoom({
    hostPlayer: {
      nickname: player.nickname,
      snakeId: player.snakeId,
      snake: player.snake,
      backgroundId: player.backgroundId,
      walletAddress: player.walletAddress,
    },
    mode: room.mode,
    settings: room.settings,
  });

  // Tag both rooms so the opponent can find the rematch via polling.
  newRoom.rematchFrom = room.code;
  room.rematchCode = newRoom.code;
  room.rematchInviteUrl = newRoom.inviteUrl;

  // Broadcast updated state to anyone still connected to the old room so their
  // Results page can show the rematch invite without polling.
  emitRoom(room);

  const host = newRoom.players[0];
  return res.status(201).json({
    code: newRoom.code,
    inviteUrl: newRoom.inviteUrl,
    hostPlayerId: host.id,
    hostPlayerToken: host.authToken,
    room: publicRoom(newRoom),
  });
});

app.get("/api/shares/:shareId", (req, res) => {
  const shared = sharedResults.get(req.params.shareId);
  if (!shared) return res.status(404).json({ error: "Share link not found" });
  if (shared.expiresAt <= Date.now()) {
    sharedResults.delete(req.params.shareId);
    return res.status(410).json({ error: "This share link has expired" });
  }
  return res.json(shared.payload);
});

io.on("connection", (socket) => {
  socket.on("room:join", ({ code, playerId, playerToken }) => {
    const room = getRoom(code);
    if (!room) {
      socket.emit("match:error", { message: "Room not found" });
      return;
    }

    const player = authorizePlayer(room, playerId, playerToken);
    if (!player) {
      socket.emit("match:error", { message: "Player not recognized for this room" });
      return;
    }

    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    emitRoom(room);
  });

  socket.on("player:setReady", ({ code, playerId, playerToken, ready }) => {
    const room = getRoom(code);
    if (!room || room.status !== "waiting") return;
    const player = authorizePlayer(room, playerId, playerToken);
    if (!player) return;
    player.ready = Boolean(ready);
    emitRoom(room);
  });

  socket.on("match:start", ({ code, playerId, playerToken }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = authorizePlayer(room, playerId, playerToken);
    if (!player || player.role !== "host") {
      socket.emit("match:error", { message: "Only the host can start the match" });
      return;
    }
    if (room.players.length !== 2 || !room.players.every((entry) => entry.ready)) {
      socket.emit("match:error", { message: "Both players must be ready before starting" });
      return;
    }
    beginCountdown(room);
  });

  socket.on("match:progress", (payload) => {
    const parsed = progressSchema.safeParse(payload);
    if (!parsed.success) return;

    const room = getRoom(parsed.data.code);
    if (!room || room.status !== "playing") return;
    const player = authorizePlayer(room, parsed.data.playerId, parsed.data.playerToken);
    if (!player) return;

    player.score = parsed.data.score;
    player.length = parsed.data.length;
    player.alive = parsed.data.alive;
    player.applesCollected = parsed.data.applesCollected;

    if (room.mode === "first_to_length" && player.length >= (room.settings.targetLength || 100) && !player.thresholdReachedAt) {
      player.thresholdReachedAt = Date.now();
    }
    if (room.mode === "apple_rush" && player.applesCollected >= (room.settings.targetApples || 25) && !player.thresholdReachedAt) {
      player.thresholdReachedAt = Date.now();
    }

    const result = evaluateRoom(room);
    if (result) finishMatch(room, result);
    else emitRoom(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.find((entry) => entry.socketId === socket.id);
      if (!player) continue;
      player.connected = false;
      player.socketId = null;
      emitRoom(room);
    }
  });
});

setInterval(() => {
  const roomCutoff = Date.now() - 1000 * 60 * 60 * 6;
  for (const [code, room] of rooms.entries()) {
    if (room.status === "finished" && room.endedAt && room.endedAt < roomCutoff) {
      clearRoomTimers(room);
      rooms.delete(code);
    }
  }

  for (const [shareId, shared] of sharedResults.entries()) {
    if (shared.expiresAt <= Date.now()) {
      sharedResults.delete(shareId);
    }
  }
}, 1000 * 30);

server.listen(PORT, () => {
  console.log(`Snake PvP backend running on http://localhost:${PORT}`);
});

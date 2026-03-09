import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createInitialState } from "../engine/initialState";
import { gameReducer } from "../engine/gameEngine";
import type { GameState, GameAction, PlayerId } from "../domain/types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RoomPlayer {
  ws: WebSocket;
  id: PlayerId;
  name: string;
  isHost: boolean;
}

interface Room {
  code: string;
  players: Map<WebSocket, RoomPlayer>;
  gameState: GameState | null;
  status: "lobby" | "playing";
}

// ─── State ────────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code: string;
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: object): void {
  const json = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(json);
  }
}

function lobbySnapshot(room: Room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
  }));
}

/** Auto-advance server-side phases that need no player input. */
function autoAdvance(room: Room): void {
  if (!room.gameState) return;
  let s = room.gameState;
  // DRAW → EXCHANGE_PHASE (no draw this game)
  if (s.phase === "DRAW_PHASE") s = gameReducer(s, { type: "DRAW" });
  // RESOLVE → END_CHECK → DRAW_PHASE (loop)
  if (s.phase === "RESOLVE_PHASE") s = gameReducer(s, { type: "RESOLVE" });
  if (s.phase === "END_CHECK") s = gameReducer(s, { type: "END_TURN" });
  if (s.phase === "DRAW_PHASE") s = gameReducer(s, { type: "DRAW" });
  room.gameState = s;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*",
  });
  res.end("GoodField Game Server OK");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let currentRoom: Room | null = null;
  let currentPlayer: RoomPlayer | null = null;

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg["type"]) {
      // ── Lobby ──────────────────────────────────────────────────────────────
      case "CREATE_ROOM": {
        if (currentRoom) return; // already in a room
        const code = generateCode();
        const player: RoomPlayer = {
          ws,
          id: "P1",
          name: String(msg["playerName"] || "Player 1"),
          isHost: true,
        };
        const room: Room = {
          code,
          players: new Map([[ws, player]]),
          gameState: null,
          status: "lobby",
        };
        rooms.set(code, room);
        currentRoom = room;
        currentPlayer = player;
        send(ws, { type: "ROOM_CREATED", roomCode: code, playerId: "P1" });
        broadcast(room, { type: "LOBBY_STATE", players: lobbySnapshot(room) });
        break;
      }

      case "JOIN_ROOM": {
        if (currentRoom) return;
        const code = String(msg["roomCode"] ?? "").toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: "ERROR", message: "部屋が見つかりません" }); return; }
        if (room.status === "playing") { send(ws, { type: "ERROR", message: "ゲームは既に開始しています" }); return; }
        if (room.players.size >= 9) { send(ws, { type: "ERROR", message: "満員です（最大9人）" }); return; }

        const num = room.players.size + 1;
        const playerId = `P${num}` as PlayerId;
        const player: RoomPlayer = {
          ws,
          id: playerId,
          name: String(msg["playerName"] || `Player ${num}`),
          isHost: false,
        };
        room.players.set(ws, player);
        currentRoom = room;
        currentPlayer = player;
        send(ws, { type: "ROOM_JOINED", roomCode: code, playerId });
        broadcast(room, { type: "LOBBY_STATE", players: lobbySnapshot(room) });
        break;
      }

      case "START_GAME": {
        if (!currentRoom || !currentPlayer?.isHost) return;
        if (currentRoom.players.size < 2) {
          send(ws, { type: "ERROR", message: "2人以上必要です" });
          return;
        }
        const playerIds = [...currentRoom.players.values()].map((p) => p.id);
        currentRoom.gameState = createInitialState(playerIds);
        currentRoom.status = "playing";
        autoAdvance(currentRoom);
        broadcast(currentRoom, { type: "GAME_STATE", state: currentRoom.gameState });
        break;
      }

      // ── In-game ────────────────────────────────────────────────────────────
      case "ACTION": {
        if (!currentRoom?.gameState || !currentPlayer) return;
        const action = msg["action"] as GameAction;
        if (!action?.type) return;

        const gs = currentRoom.gameState;
        const activeId = gs.playerOrder[gs.activePlayerIndex];

        // Validate sender may take this action
        if (action.type === "DEFEND" || action.type === "CONFIRM_DEFENSE") {
          if (currentPlayer.id !== action.playerId) return;
        } else if (currentPlayer.id !== activeId) {
          return;
        }

        currentRoom.gameState = gameReducer(gs, action);
        autoAdvance(currentRoom);
        broadcast(currentRoom, { type: "GAME_STATE", state: currentRoom.gameState });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!currentRoom || !currentPlayer) return;
    currentRoom.players.delete(ws);
    if (currentRoom.players.size === 0) {
      rooms.delete(currentRoom.code);
    } else {
      // Re-assign host if needed
      if (currentPlayer.isHost) {
        const next = [...currentRoom.players.values()][0]!;
        next.isHost = true;
      }
      broadcast(currentRoom, { type: "LOBBY_STATE", players: lobbySnapshot(currentRoom) });
    }
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`GoodField server  →  ws://localhost:${PORT}`);
  console.log("Open  http://localhost:5173/online.html  in each browser tab.");
});

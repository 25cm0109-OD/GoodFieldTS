import { GameState } from "../domain/types";
import { GameAction } from "../domain/types";

/**
 * Network action envelope – wraps a GameAction with metadata for online play.
 * GameAction is fully serialisable so the same gameReducer can run on both
 * server and client.
 */
export interface NetworkAction {
  readonly gameId: string;
  readonly playerId: string;
  readonly action: GameAction;
  readonly timestamp: number;
  readonly signature?: string; // チート対策用 HMAC
}

/**
 * Represents a game room that players can join.
 */
export interface GameRoom {
  readonly id: string;
  readonly hostPlayerId: string;
  readonly players: readonly string[]; // 2〜9人
  readonly spectators: readonly string[];
  readonly state: GameState;
  readonly isPrivate: boolean;
  readonly maxPlayers: number; // 2〜9
}

import { GameState, PlayerId, PlayerState } from "../domain/types";
import { CARD_DEFINITIONS } from "./cardRegistry";

export const INITIAL_HAND_SIZE = 7;
export const INITIAL_HP = 40;
export const INITIAL_MP = 10;
export const INITIAL_PAY = 20;

/** The shared pool size players draw from each turn. */
export const POOL_SIZE = 500;

/**
 * Draw one card at random from the 500-card master pool.
 * The pool is the CARD_DEFINITIONS repeated until it reaches POOL_SIZE entries.
 * Each draw is independent – there is no deck to exhaust.
 */
export function drawRandomCard() {
  const pool = buildPool();
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildPool() {
  const pool = [];
  let i = 0;
  while (pool.length < POOL_SIZE) {
    pool.push(CARD_DEFINITIONS[i % CARD_DEFINITIONS.length]);
    i++;
  }
  return pool;
}

/**
 * Creates the initial game state.
 * Players start with a hand drawn randomly from the pool.
 * There is no per-player deck – every draw goes through drawRandomCard().
 */
export function createInitialState(playerIds: PlayerId[]): GameState {
  if (playerIds.length < 2 || playerIds.length > 9) {
    throw new Error("Player count must be between 2 and 9");
  }

  const players: { [key in PlayerId]?: PlayerState } = {};
  for (const id of playerIds) {
    const hand = Array.from({ length: INITIAL_HAND_SIZE }, () => drawRandomCard());
    players[id] = {
      id,
      stats: { hp: INITIAL_HP, mp: INITIAL_MP, pay: INITIAL_PAY },
      hand,
      deck: [],   // unused – kept for type compatibility
      discard: [],
    };
  }

  return {
    players,
    playerOrder: playerIds,
    activePlayerIndex: 0,
    phase: "DRAW_PHASE",
    attackCards: [],
    defenseCards: {},
    confirmedDefenders: [],
    winner: undefined,
    attackPlusActive: false,
    attackElementOverride: undefined,
  };
}

/** Legacy shuffle helper (kept for test compatibility). */
export function shuffleDeck<T>(cards: readonly T[]): T[] {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
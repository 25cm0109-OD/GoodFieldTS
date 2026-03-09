import { GameState, PlayerId, PlayerState, Card } from "../domain/types";
import { CARD_TEMPLATES, makeCardFromTemplate } from "./cardRegistry";

export const INITIAL_HAND_SIZE = 7;
export const MAX_HAND_SIZE = 18;
export const INITIAL_HP = 40;
export const INITIAL_MP = 10;
export const INITIAL_PAY = 20;

/** Size of the master card pool players draw from (matches sum of all template frequencies). */
export const POOL_SIZE = 492;

let _poolCache: readonly Card[] | null = null;

function buildPool(): readonly Card[] {
  const pool: Card[] = [];
  for (const t of CARD_TEMPLATES) {
    for (let i = 0; i < t.frequency; i++) {
      pool.push(makeCardFromTemplate(t));
    }
  }
  // Pad to POOL_SIZE if total frequency < 500
  while (pool.length < POOL_SIZE) {
    pool.push(makeCardFromTemplate(CARD_TEMPLATES[pool.length % CARD_TEMPLATES.length]!));
  }
  return pool.slice(0, POOL_SIZE);
}

/** Reset the cached pool (useful in tests). */
export function resetPool(): void {
  _poolCache = null;
}

/**
 * Draw one card at random from the 500-card master pool.
 * The pool is built once (lazily) and cached for the lifetime of the process.
 */
export function drawRandomCard(): Card {
  if (!_poolCache) _poolCache = buildPool();
  return _poolCache[Math.floor(Math.random() * _poolCache.length)]!;
}

/**
 * Creates the initial game state.
 * Players start with a hand drawn randomly from the pool.
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
      deck: [],
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
    attackTarget: undefined,
    attackAreaPercent: undefined,
    miracleUsedThisTurn: false,
    actionUsedThisTurn: false,
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

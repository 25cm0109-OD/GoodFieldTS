import { GameState, PlayerId, Card, PlayerState } from "../domain/types";
import { CARD_DEFINITIONS } from "./cardRegistry";

const INITIAL_HAND_SIZE = 7;
const INITIAL_HP = 30;
const INITIAL_MP = 30;
const INITIAL_PAY = 10;

export function shuffleDeck<T>(cards: readonly T[]): T[] {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildPlayerDeck(): Card[] {
  // 4 copies of every card definition, shuffled
  const deck: Card[] = [];
  for (let i = 0; i < 4; i++) {
    deck.push(...CARD_DEFINITIONS);
  }
  return shuffleDeck(deck);
}

/**
 * Creates the initial game state.
 * Player order is taken as-is from the supplied array.
 * Shuffle before passing if random order is desired.
 */
export function createInitialState(playerIds: PlayerId[]): GameState {
  if (playerIds.length < 2 || playerIds.length > 9) {
    throw new Error("Player count must be between 2 and 9");
  }

  const players: { [key in PlayerId]?: PlayerState } = {};
  for (const id of playerIds) {
    const deck = buildPlayerDeck();
    const hand = deck.slice(0, INITIAL_HAND_SIZE);
    const remainingDeck = deck.slice(INITIAL_HAND_SIZE);
    players[id] = {
      id,
      stats: { hp: INITIAL_HP, mp: INITIAL_MP, pay: INITIAL_PAY },
      hand,
      deck: remainingDeck,
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

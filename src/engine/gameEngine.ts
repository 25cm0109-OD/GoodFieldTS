import {
  GameState,
  GameAction,
  PlayerId,
  Card,
  PlayerState,
  Phase,
} from "../domain/types";
import {
  canDefend,
  resolveAttackElementWithLight,
} from "./elementSystem";
import { shuffleDeck } from "./initialState";

// ---------------------------------------------------------------------------
// Constants & utilities
// ---------------------------------------------------------------------------

export const MAX_STAT = 99;
export const MIN_STAT = 0;

/** Clamps a stat value to the valid range [0, 99]. */
export function clampStat(value: number): number {
  return Math.min(MAX_STAT, Math.max(MIN_STAT, value));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function drawCard(player: PlayerState): PlayerState {
  let deck = [...player.deck];
  let discard = [...player.discard];

  if (deck.length === 0) {
    if (discard.length === 0) return player; // nothing to draw
    deck = shuffleDeck(discard);
    discard = [];
  }

  const [drawn, ...remaining] = deck;
  return {
    ...player,
    hand: [...player.hand, drawn],
    deck: remaining,
    discard,
  };
}

function getActivePlayerId(state: GameState): PlayerId {
  return state.playerOrder[state.activePlayerIndex];
}

function getDefenderIds(state: GameState): PlayerId[] {
  const activeId = getActivePlayerId(state);
  return state.playerOrder.filter((id) => id !== activeId) as PlayerId[];
}

function isAttackCard(card: Card): boolean {
  return card.type === "ATTACK" || card.type === "MIRACLE_ATK";
}

function isDefenseCard(card: Card): boolean {
  return card.type === "DEFENSE" || card.type === "MIRACLE_DEF";
}

/** Remove the first occurrence of each card (by id) in `cards` from `hand`. */
function removeFromHand(
  hand: readonly Card[],
  cards: readonly Card[]
): Card[] {
  const toRemove = [...cards];
  const result: Card[] = [];
  for (const c of hand) {
    const idx = toRemove.findIndex((r) => r.id === c.id);
    if (idx !== -1) {
      toRemove.splice(idx, 1);
    } else {
      result.push(c);
    }
  }
  return result;
}

/** Apply damage to a defender's HP (clamped). */
function applyDamage(
  state: GameState,
  defenderId: PlayerId,
  damage: number
): GameState {
  const defender = state.players[defenderId];
  if (!defender) return state;
  const newHp = clampStat(defender.stats.hp - damage);
  const newDefender: PlayerState = {
    ...defender,
    stats: { ...defender.stats, hp: newHp },
  };
  return {
    ...state,
    players: { ...state.players, [defenderId]: newDefender },
  };
}

// ---------------------------------------------------------------------------
// Phase resolution
// ---------------------------------------------------------------------------

function resolvePhase(state: GameState): GameState {
  const attackElements = state.attackCards.map((c) => c.element);
  const attackElement = resolveAttackElementWithLight(
    attackElements,
    state.attackElementOverride
  );
  const totalAttack = state.attackCards.reduce((sum, c) => sum + c.power, 0);

  const defenders = getDefenderIds(state);
  let newState: GameState = state;

  for (const defenderId of defenders) {
    const defCards = state.defenseCards[defenderId] ?? [];

    // Only count defense cards whose element counters the attack element
    const effectiveDefense = defCards
      .filter((c) => canDefend(attackElement, c.element))
      .reduce((sum, c) => sum + c.power, 0);

    const rawDamage = Math.max(0, totalAttack - effectiveDefense);

    if (rawDamage === 0) continue;

    if (attackElement === "DARK") {
      // Dark instant kill
      newState = applyDamage(newState, defenderId, MAX_STAT); // force HP to 0
    } else {
      newState = applyDamage(newState, defenderId, rawDamage);
    }
  }

  // Check for eliminated players
  const eliminatedIds = defenders.filter(
    (id) => (newState.players[id]?.stats.hp ?? 0) === 0
  );

  if (eliminatedIds.length > 0) {
    const survivingPlayers = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) > 0
    );
    if (survivingPlayers.length === 1) {
      return {
        ...newState,
        phase: "GAME_OVER",
        winner: survivingPlayers[0],
      };
    }
    // Multiple survivors – remove eliminated players and continue
    const newOrder = state.playerOrder.filter(
      (id) => !eliminatedIds.includes(id)
    );
    return { ...newState, phase: "END_CHECK", playerOrder: newOrder };
  }

  return { ...newState, phase: "END_CHECK" };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function gameReducer(state: GameState, action: GameAction): GameState {
  if (state.phase === "GAME_OVER") return state;

  const activeId = getActivePlayerId(state);
  const activePlayer = state.players[activeId];
  if (!activePlayer) return state;

  switch (action.type) {
    // ----- DRAW_PHASE -------------------------------------------------------
    case "DRAW": {
      if (state.phase !== "DRAW_PHASE") return state;
      const newPlayer = drawCard(activePlayer);
      return {
        ...state,
        players: { ...state.players, [activeId]: newPlayer },
        phase: "EXCHANGE_PHASE",
      };
    }

    // ----- EXCHANGE_PHASE ---------------------------------------------------
    case "EXCHANGE": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      const { hp, mp, pay } = action.allocations;

      if (hp < 0 || mp < 0 || pay < 0) return state;
      if (hp > 99 || mp > 99 || pay > 99) return state;

      const currentTotal =
        activePlayer.stats.hp + activePlayer.stats.mp + activePlayer.stats.pay;
      if (hp + mp + pay !== currentTotal) return state;

      const newStats = {
        hp: clampStat(hp),
        mp: clampStat(mp),
        pay: clampStat(pay),
      };
      const newPlayer: PlayerState = { ...activePlayer, stats: newStats };
      const newState: GameState = {
        ...state,
        players: { ...state.players, [activeId]: newPlayer },
      };

      if (hp === 0) {
        const winner = getDefenderIds(state)[0];
        return { ...newState, phase: "GAME_OVER", winner };
      }

      return newState;
    }

    case "END_EXCHANGE": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      return { ...state, phase: "ATTACK_PHASE" };
    }

    // ----- ATTACK_PHASE -----------------------------------------------------
    case "ATTACK": {
      // Allow transitioning from EXCHANGE_PHASE implicitly
      const inValidPhase =
        state.phase === "ATTACK_PHASE" ||
        state.phase === "EXCHANGE_PHASE";
      if (!inValidPhase) return state;

      const { cards, lightAsElement } = action;
      if (cards.length === 0) return state;
      if (!cards.every(isAttackCard)) return state;

      // Enforce single-attack limit unless attackPlus is active
      if (state.attackCards.length > 0 && !state.attackPlusActive) return state;

      const totalMpCost = cards.reduce((sum, c) => sum + c.mpCost, 0);
      if (activePlayer.stats.mp < totalMpCost) return state;

      const newHand = removeFromHand(activePlayer.hand, cards);
      const newDiscard = [...activePlayer.discard, ...cards];
      const newMp = clampStat(activePlayer.stats.mp - totalMpCost);

      const newPlayer: PlayerState = {
        ...activePlayer,
        hand: newHand,
        discard: newDiscard,
        stats: { ...activePlayer.stats, mp: newMp },
      };

      const hasAttackPlus = cards.some((c) => c.attackPlus || c.doubler);
      const newAttackPlusActive = state.attackPlusActive || hasAttackPlus;

      // Determine next phase:
      // Stay in ATTACK_PHASE if attackPlus was just triggered;
      // otherwise auto-advance to DEFENSE_PHASE.
      const nextPhase: Phase = newAttackPlusActive
        ? "ATTACK_PHASE"
        : "DEFENSE_PHASE";

      return {
        ...state,
        phase: nextPhase,
        players: { ...state.players, [activeId]: newPlayer },
        attackCards: [...state.attackCards, ...cards],
        attackPlusActive: newAttackPlusActive,
        attackElementOverride: lightAsElement ?? state.attackElementOverride,
      };
    }

    case "CONFIRM_ATTACK": {
      if (state.phase !== "ATTACK_PHASE") return state;
      if (state.attackCards.length === 0) return state;
      return {
        ...state,
        phase: "DEFENSE_PHASE",
        confirmedDefenders: [],
      };
    }

    case "PRAY": {
      // PRAY is valid in ATTACK_PHASE or EXCHANGE_PHASE
      const inValidPhase =
        state.phase === "ATTACK_PHASE" ||
        state.phase === "EXCHANGE_PHASE";
      if (!inValidPhase) return state;

      // Can only PRAY when no attack cards are in hand
      if (activePlayer.hand.some(isAttackCard)) return state;

      const newPlayer = drawCard(activePlayer);
      const nextIndex =
        (state.activePlayerIndex + 1) % state.playerOrder.length;

      return {
        ...state,
        players: { ...state.players, [activeId]: newPlayer },
        activePlayerIndex: nextIndex,
        phase: "DRAW_PHASE",
        attackCards: [],
        defenseCards: {},
        confirmedDefenders: [],
        attackPlusActive: false,
        attackElementOverride: undefined,
      };
    }

    // ----- DEFENSE_PHASE ----------------------------------------------------
    case "DEFEND": {
      if (state.phase !== "DEFENSE_PHASE") return state;
      const { playerId, cards: defCards } = action;

      if (!getDefenderIds(state).includes(playerId)) return state;
      if (!defCards.every(isDefenseCard)) return state;

      const defender = state.players[playerId];
      if (!defender) return state;

      const miracleCost = defCards
        .filter((c) => c.type === "MIRACLE_DEF")
        .reduce((sum, c) => sum + c.mpCost, 0);
      if (defender.stats.mp < miracleCost) return state;

      const newHand = removeFromHand(defender.hand, defCards);
      const newDiscard = [...defender.discard, ...defCards];
      const newMp = clampStat(defender.stats.mp - miracleCost);

      const newDefender: PlayerState = {
        ...defender,
        hand: newHand,
        discard: newDiscard,
        stats: { ...defender.stats, mp: newMp },
      };

      const existing = state.defenseCards[playerId] ?? [];
      return {
        ...state,
        players: { ...state.players, [playerId]: newDefender },
        defenseCards: {
          ...state.defenseCards,
          [playerId]: [...existing, ...defCards],
        },
      };
    }

    case "CONFIRM_DEFENSE": {
      if (state.phase !== "DEFENSE_PHASE") return state;
      const { playerId } = action;

      if (!getDefenderIds(state).includes(playerId)) return state;

      const newConfirmed = state.confirmedDefenders.includes(playerId)
        ? state.confirmedDefenders
        : [...state.confirmedDefenders, playerId];

      const allDefenders = getDefenderIds(state);
      const allConfirmed = allDefenders.every((id) =>
        newConfirmed.includes(id)
      );

      if (allConfirmed) {
        return {
          ...state,
          confirmedDefenders: newConfirmed,
          phase: "RESOLVE_PHASE",
        };
      }
      return { ...state, confirmedDefenders: newConfirmed };
    }

    // ----- RESOLVE_PHASE ----------------------------------------------------
    case "RESOLVE": {
      if (state.phase !== "RESOLVE_PHASE") return state;
      return resolvePhase(state);
    }

    // ----- END_CHECK --------------------------------------------------------
    case "END_TURN": {
      if (state.phase !== "END_CHECK") return state;
      const nextIndex =
        (state.activePlayerIndex + 1) % state.playerOrder.length;
      return {
        ...state,
        activePlayerIndex: nextIndex,
        phase: "DRAW_PHASE",
        attackCards: [],
        defenseCards: {},
        confirmedDefenders: [],
        attackPlusActive: false,
        attackElementOverride: undefined,
      };
    }

    default:
      return state;
  }
}

export type Element =
  | "NEUTRAL"
  | "FIRE"
  | "WATER"
  | "WOOD"
  | "EARTH"
  | "LIGHT"
  | "DARK";

export type CardType =
  | "ATTACK"
  | "DEFENSE"
  | "EXCHANGE"
  | "MIRACLE_ATK"
  | "MIRACLE_DEF"
  | "SELL"
  | "BUY";

export type PlayerId =
  | "P1"
  | "P2"
  | "P3"
  | "P4"
  | "P5"
  | "P6"
  | "P7"
  | "P8"
  | "P9";

export type Phase =
  | "DRAW_PHASE"
  | "EXCHANGE_PHASE"
  | "ATTACK_PHASE"
  | "DEFENSE_PHASE"
  | "RESOLVE_PHASE"
  | "END_CHECK"
  | "GAME_OVER";

export interface Card {
  readonly id: string;
  readonly name: string;
  readonly type: CardType;
  readonly element: Element;
  readonly power: number;
  readonly mpCost: number;
  readonly attackPlus?: boolean;
  readonly doubler?: boolean;
}

export interface PlayerStats {
  readonly hp: number;
  readonly mp: number;
  readonly pay: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly stats: PlayerStats;
  readonly hand: readonly Card[];
  readonly deck: readonly Card[];
  readonly discard: readonly Card[];
}

export type DefenseCards = {
  readonly [key in PlayerId]?: readonly Card[];
};

export interface GameState {
  readonly players: {
    readonly [key in PlayerId]?: PlayerState;
  };
  readonly playerOrder: readonly PlayerId[];
  readonly activePlayerIndex: number;
  readonly phase: Phase;
  readonly attackCards: readonly Card[];
  readonly defenseCards: DefenseCards;
  readonly confirmedDefenders: readonly PlayerId[];
  readonly winner?: PlayerId;
  readonly attackPlusActive: boolean;
  readonly attackElementOverride?: Element;
}

export type GameAction =
  | { readonly type: "DRAW" }
  | { readonly type: "EXCHANGE"; readonly allocations: PlayerStats }
  | { readonly type: "END_EXCHANGE" }
  | {
      readonly type: "ATTACK";
      readonly cards: readonly Card[];
      readonly lightAsElement?: Element;
    }
  | { readonly type: "CONFIRM_ATTACK" }
  | { readonly type: "PRAY" }
  | {
      readonly type: "DEFEND";
      readonly playerId: PlayerId;
      readonly cards: readonly Card[];
    }
  | { readonly type: "CONFIRM_DEFENSE"; readonly playerId: PlayerId }
  | { readonly type: "RESOLVE" }
  | { readonly type: "END_TURN" };

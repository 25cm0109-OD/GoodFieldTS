import type { Card, GameAction, GameState, PlayerId } from "../../domain/types";

/**
 * CLI 入力文字列を GameAction に変換する層。
 * ここでは「UI入力の解釈」だけを担当し、ゲーム進行ロジックは engine に委譲する。
 */
export function parseAction(input: string, state: GameState): GameAction | null {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toUpperCase();
  const activeId = state.playerOrder[state.activePlayerIndex];

  switch (cmd) {
    case "DRAW":
      return { type: "DRAW" };
    case "END_EXCHANGE":
      return { type: "END_EXCHANGE" };
    case "PRAY":
      return { type: "PRAY" };
    case "RESOLVE":
      return { type: "RESOLVE" };
    case "END_TURN":
      return { type: "END_TURN" };
    case "CONFIRM_ATTACK":
      return { type: "CONFIRM_ATTACK" };

    case "CONFIRM_DEFENSE": {
      const playerId = parts[1] as PlayerId | undefined;
      if (!playerId) {
        console.log("使い方: CONFIRM_DEFENSE <プレイヤーID>");
        return null;
      }
      return { type: "CONFIRM_DEFENSE", playerId };
    }

    case "ATTACK": {
      // ATTACK <cardId> [<cardId2> ...] [TARGET <targetId>]
      const cardIds: string[] = [];
      let target: PlayerId | undefined;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i]?.toUpperCase() === "TARGET") {
          target = parts[i + 1] as PlayerId | undefined;
          break;
        }
        cardIds.push(parts[i]!);
      }
      if (cardIds.length === 0) {
        console.log("使い方: ATTACK <カードID> [TARGET <プレイヤーID>]");
        return null;
      }
      const hand = state.players[activeId]?.hand ?? [];
      const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (cards.length !== cardIds.length) {
        console.log("指定されたカードが手札に見つかりません");
        return null;
      }
      return { type: "ATTACK", cards, target };
    }

    case "DEFEND": {
      // DEFEND <playerId> [<cardId> ...]
      const playerId = parts[1] as PlayerId | undefined;
      if (!playerId) {
        console.log("使い方: DEFEND <プレイヤーID> [カードID...]");
        return null;
      }
      const cardIds = parts.slice(2);
      const hand = state.players[playerId]?.hand ?? [];
      const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (cards.length !== cardIds.length) {
        console.log("指定されたカードが手札に見つかりません");
        return null;
      }
      return { type: "DEFEND", playerId, cards };
    }

    case "EXCHANGE": {
      // EXCHANGE <cardId> <hp> <mp> <pay>
      const cardId = parts[1];
      const hp = parseInt(parts[2] ?? "", 10);
      const mp = parseInt(parts[3] ?? "", 10);
      const pay = parseInt(parts[4] ?? "", 10);
      if (!cardId || isNaN(hp) || isNaN(mp) || isNaN(pay)) {
        console.log("使い方: EXCHANGE <カードID> <HP> <MP> <PAY>");
        const p = state.players[activeId];
        if (p) {
          const { hp: h, mp: m, pay: pa } = p.stats;
          console.log(`  現在: HP:${h} MP:${m} PAY:${pa}  合計:${h + m + pa}`);
        }
        return null;
      }
      return { type: "EXCHANGE", cardId, allocations: { hp, mp, pay } };
    }

    case "BUY": {
      // BUY <buyCardId> <targetId>
      const buyCardId = parts[1];
      const targetId = parts[2] as PlayerId | undefined;
      if (!buyCardId || !targetId) {
        console.log("使い方: BUY <BUYカードID> <ターゲットID>");
        return null;
      }
      return { type: "BUY", buyCardId, targetId };
    }

    case "SELL": {
      // SELL <sellCardId> <itemCardId> <targetId>
      const sellCardId = parts[1];
      const itemCardId = parts[2];
      const targetId = parts[3] as PlayerId | undefined;
      if (!sellCardId || !itemCardId || !targetId) {
        console.log("使い方: SELL <SELLカードID> <商品カードID> <ターゲットID>");
        return null;
      }
      return { type: "SELL", sellCardId, itemCardId, targetId };
    }

    case "USE_HEAL": {
      const cardId = parts[1];
      if (!cardId) {
        console.log("使い方: USE_HEAL <カードID>");
        return null;
      }
      return { type: "USE_HEAL", cardId };
    }

    default:
      return null;
  }
}

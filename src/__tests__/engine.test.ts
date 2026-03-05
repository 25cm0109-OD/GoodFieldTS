import { gameReducer, clampStat } from "../engine/gameEngine";
import { createInitialState } from "../engine/initialState";
import { GameState, Card, Phase, PlayerId } from "../domain/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _testCardId = 0;
function testCard(
  type: Card["type"],
  overrides: Partial<Card> = {}
): Card {
  _testCardId++;
  return {
    id: `test-${_testCardId}`,
    name: `TestCard-${_testCardId}`,
    type,
    element: "NEUTRAL",
    power: 10,
    mpCost: 5,
    ...overrides,
  };
}

function stateAtPhase(
  phase: Phase,
  playerOrder: PlayerId[] = ["P1", "P2"]
): GameState {
  const base = createInitialState(playerOrder);
  return { ...base, phase };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("engine.test.ts", () => {
  // 1. HP=0自発両替 → 即敗北
  test("HP=0自発両替→即敗北（GAME_OVER状態になること）", () => {
    const state = createInitialState(["P1", "P2"]);
    const afterDraw = gameReducer(state, { type: "DRAW" });
    expect(afterDraw.phase).toBe("EXCHANGE_PHASE");

    const p1 = afterDraw.players["P1"]!;
    const { mp, pay } = p1.stats;
    const total = p1.stats.hp + mp + pay;

    const afterExchange = gameReducer(afterDraw, {
      type: "EXCHANGE",
      allocations: { hp: 0, mp: total, pay: 0 },
    });

    expect(afterExchange.phase).toBe("GAME_OVER");
    expect(afterExchange.winner).toBe("P2");
  });

  // 2. 超過分消滅（HP=40に+70回復→HP=99で止まること）
  test("超過分消滅（HP=40に+70回復→HP=99で止まること）", () => {
    expect(clampStat(40 + 70)).toBe(99);
    expect(clampStat(100)).toBe(99);
    expect(clampStat(0)).toBe(0);
    expect(clampStat(-1)).toBe(0);
    expect(clampStat(99)).toBe(99);
  });

  // 3. 攻撃カードなし→祈る→1枚ドロー&ターン終了
  test("攻撃カードなし→祈る→1枚ドローしてターン終了", () => {
    const defCard = testCard("DEFENSE");
    const base = createInitialState(["P1", "P2"]);
    const state: GameState = {
      ...base,
      phase: "ATTACK_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          hand: [defCard], // no attack cards
          deck: [testCard("DEFENSE"), testCard("DEFENSE")],
        },
      },
    };

    const handBefore = state.players["P1"]!.hand.length;
    const result = gameReducer(state, { type: "PRAY" });

    expect(result.players["P1"]!.hand.length).toBe(handBefore + 1);
    // Turn passes to P2
    expect(result.playerOrder[result.activePlayerIndex]).toBe("P2");
    expect(result.phase).toBe("DRAW_PHASE");
  });

  // 4. attackPlusカード使用後 → 追加で攻撃カードを使用可能
  test("attackPlusカード使用後→追加で攻撃カードを使用可能", () => {
    const apCard = testCard("ATTACK", { id: "ap1", attackPlus: true, power: 5 });
    const atkCard = testCard("ATTACK", { id: "a1", power: 8 });

    const base = createInitialState(["P1", "P2"]);
    const state: GameState = {
      ...base,
      phase: "ATTACK_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          hand: [apCard, atkCard],
          stats: { hp: 30, mp: 99, pay: 10 },
        },
      },
    };

    const afterFirst = gameReducer(state, { type: "ATTACK", cards: [apCard] });
    expect(afterFirst.attackPlusActive).toBe(true);
    // Still in ATTACK_PHASE when attackPlus was played
    expect(afterFirst.phase).toBe("ATTACK_PHASE");

    const afterSecond = gameReducer(afterFirst, {
      type: "ATTACK",
      cards: [atkCard],
    });
    expect(afterSecond.attackCards.length).toBe(2);
  });

  // 5. ターン交代ロジック（P1→P2→P1の順になること）
  test("ターン交代ロジック（P1→P2→P1の順になること）", () => {
    const atkCard = testCard("ATTACK", { id: "atk-t1", power: 5 });
    const base = createInitialState(["P1", "P2"]);

    const setupState = (s: GameState, attackerId: PlayerId, defenderId: PlayerId): GameState => ({
      ...s,
      players: {
        ...s.players,
        [attackerId]: {
          ...s.players[attackerId]!,
          hand: [{ ...atkCard, id: `${atkCard.id}-${attackerId}` }],
          stats: { hp: 30, mp: 99, pay: 10 },
        },
        [defenderId]: {
          ...s.players[defenderId]!,
          stats: { hp: 30, mp: 99, pay: 10 },
        },
      },
    });

    // P1's turn
    let state = gameReducer(setupState(base, "P1", "P2"), { type: "DRAW" });
    expect(state.playerOrder[state.activePlayerIndex]).toBe("P1");

    state = gameReducer(state, { type: "END_EXCHANGE" });
    state = gameReducer(state, {
      type: "ATTACK",
      cards: [{ ...atkCard, id: "atk-p1-t1" }],
    });
    // Auto-advanced to DEFENSE_PHASE
    state = gameReducer(state, { type: "CONFIRM_DEFENSE", playerId: "P2" });
    state = gameReducer(state, { type: "RESOLVE" });
    state = gameReducer(state, { type: "END_TURN" });

    // Now it's P2's turn
    expect(state.playerOrder[state.activePlayerIndex]).toBe("P2");

    // P2's turn
    state = gameReducer(setupState(state, "P2", "P1"), { type: "DRAW" });
    state = gameReducer(state, { type: "END_EXCHANGE" });
    state = gameReducer(state, {
      type: "ATTACK",
      cards: [{ ...atkCard, id: "atk-p2-t1" }],
    });
    state = gameReducer(state, { type: "CONFIRM_DEFENSE", playerId: "P1" });
    state = gameReducer(state, { type: "RESOLVE" });
    state = gameReducer(state, { type: "END_TURN" });

    // Back to P1
    expect(state.playerOrder[state.activePlayerIndex]).toBe("P1");
  });

  // 6. デッキ切れ時に捨て札がシャッフルされてデッキに戻ること
  test("デッキ切れ時に捨て札がシャッフルされてデッキに戻ること", () => {
    const discardCards: Card[] = [
      testCard("DEFENSE", { id: "disc1" }),
      testCard("ATTACK", { id: "disc2" }),
      testCard("EXCHANGE", { id: "disc3" }),
    ];
    const base = createInitialState(["P1", "P2"]);
    const state: GameState = {
      ...base,
      phase: "DRAW_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          deck: [], // empty deck
          discard: discardCards,
          hand: [],
        },
      },
    };

    const result = gameReducer(state, { type: "DRAW" });
    const p1 = result.players["P1"]!;

    // Drew 1 card from shuffled discard
    expect(p1.hand.length).toBe(1);
    // Remaining cards are in deck (discard became deck)
    expect(p1.deck.length + p1.discard.length).toBe(discardCards.length - 1);
    // Discard should be empty after reshuffle
    expect(p1.discard.length).toBe(0);
  });
});

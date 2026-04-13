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

    // Inject an EXCHANGE card so the action is valid
    const exchangeCard = testCard("EXCHANGE", { id: "exc-test", mpCost: 0 });
    const stateWithCard: GameState = {
      ...afterDraw,
      players: {
        ...afterDraw.players,
        P1: {
          ...afterDraw.players["P1"]!,
          hand: [...afterDraw.players["P1"]!.hand, exchangeCard],
        },
      },
    };

    const p1 = stateWithCard.players["P1"]!;
    const { mp, pay } = p1.stats;
    const total = p1.stats.hp + mp + pay;

    const afterExchange = gameReducer(stateWithCard, {
      type: "EXCHANGE",
      cardId: "exc-test",
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
      phase: "EXCHANGE_PHASE",
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

  // 4. 攻撃カードとattackPlusカードを1アクションで同時に使える
  test("攻撃カードとattackPlusカードを1アクションで同時に使える", () => {
    const apCard = testCard("ATTACK", { id: "ap1", attackPlus: true, power: 5 });
    const atkCard = testCard("ATTACK", { id: "a1", power: 8 });

    const base = createInitialState(["P1", "P2"]);
    const state: GameState = {
      ...base,
      phase: "EXCHANGE_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          hand: [atkCard, apCard],
          stats: { hp: 30, mp: 99, pay: 10 },
          deck: Array.from({ length: 5 }, (_, i) => testCard("DEFENSE", { id: `d${i}` })),
        },
      },
    };

    // Play 1 main card + 1 attackPlus card in a single ATTACK action
    const result = gameReducer(state, { type: "ATTACK", cards: [atkCard, apCard] });
    // Both cards included in attackCards
    expect(result.attackCards.length).toBe(2);
    // After attack, always goes to DEFENSE_PHASE
    expect(result.phase).toBe("DEFENSE_PHASE");
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

  // 6. 手札上限18枚：手札が満杯の時はドロー不可（スキップ）
  test("手札上限18枚：手札が満杯の時はPRAYしてもドローされない", () => {
    const base = createInitialState(["P1", "P2"]);
    // Fill P1's hand to exactly MAX_HAND_SIZE (18) with NON-attack cards
    const fullHand = Array.from({ length: 18 }, (_, i) =>
      testCard("EXCHANGE", { id: `hand-${i}` })
    );
    const state: GameState = {
      ...base,
      phase: "EXCHANGE_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          hand: fullHand,
          deck: [],
        },
      },
    };

    // PRAY: draws 1 card into hand, but hand is already full → draw skipped
    const result = gameReducer(state, { type: "PRAY" });
    const p1 = result.players["P1"]!;

    // Hand stays at 18 (draw was skipped because hand was full)
    expect(p1.hand.length).toBe(18);
    // Nothing discarded
    expect(p1.discard.length).toBe(0);
  });

  test("使用済み奇跡(ATTACK)を再使用すると追加で1枚ドローする", () => {
    const reusedMiracleAtk = testCard("ATTACK", {
      id: "miracle-atk-reused",
      isMiracle: true,
      wasUsed: true,
      mpCost: 1,
      power: 7,
    });
    const base = createInitialState(["P1", "P2"]);
    const state: GameState = {
      ...base,
      phase: "EXCHANGE_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          hand: [reusedMiracleAtk],
          stats: { ...base.players["P1"]!.stats, mp: 99 },
        },
      },
    };

    const before = state.players["P1"]!.hand.length;
    const result = gameReducer(state, { type: "ATTACK", cards: [reusedMiracleAtk], target: "P2" });
    const after = result.players["P1"]!.hand.length;
    expect(after).toBe(before + 1);
  });

  test("未使用奇跡(ATTACK)の初回使用では追加ドローしない", () => {
    const freshMiracleAtk = testCard("ATTACK", {
      id: "miracle-atk-fresh",
      isMiracle: true,
      wasUsed: false,
      mpCost: 1,
      power: 7,
    });
    const base = createInitialState(["P1", "P2"]);
    const state: GameState = {
      ...base,
      phase: "EXCHANGE_PHASE",
      players: {
        ...base.players,
        P1: {
          ...base.players["P1"]!,
          hand: [freshMiracleAtk],
          stats: { ...base.players["P1"]!.stats, mp: 99 },
        },
      },
    };

    const before = state.players["P1"]!.hand.length;
    const result = gameReducer(state, { type: "ATTACK", cards: [freshMiracleAtk], target: "P2" });
    const after = result.players["P1"]!.hand.length;
    expect(after).toBe(before);
  });
});

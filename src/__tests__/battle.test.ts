import { gameReducer, clampStat } from "../engine/gameEngine";
import { createInitialState } from "../engine/initialState";
import { GameState, Card, PlayerId, Phase } from "../domain/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _id = 0;
function makeCard(overrides: Partial<Card> = {}): Card {
  _id++;
  return {
    id: `bcard-${_id}`,
    name: `BattleCard-${_id}`,
    type: "ATTACK",
    element: "NEUTRAL",
    power: 10,
    mpCost: 0,
    ...overrides,
  };
}

function battleState(
  attackCards: Card[],
  defenseCards: Card[],
  attackerHp = 30,
  defenderHp = 30
): GameState {
  const base = createInitialState(["P1", "P2"]);
  return {
    ...base,
    phase: "RESOLVE_PHASE",
    attackCards,
    defenseCards: { P2: defenseCards },
    confirmedDefenders: ["P2"],
    players: {
      ...base.players,
      P1: {
        ...base.players["P1"]!,
        stats: { hp: attackerHp, mp: 99, pay: 10 },
      },
      P2: {
        ...base.players["P2"]!,
        stats: { hp: defenderHp, mp: 99, pay: 10 },
      },
    },
    playerOrder: ["P1", "P2"],
    activePlayerIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("battle.test.ts", () => {
  // 1. ATK合計30 DEF合計10 → ダメージ20がHPに適用される
  test("ATK合計30 DEF合計10 → ダメージ20がHPに適用される", () => {
    const attack = [
      makeCard({ power: 15, element: "NEUTRAL" }),
      makeCard({ power: 15, element: "NEUTRAL" }),
    ];
    const defense = [makeCard({ type: "DEFENSE", power: 10, element: "NEUTRAL" })];

    const state = battleState(attack, defense, 30, 30);
    const result = gameReducer(state, { type: "RESOLVE" });

    expect(result.players["P2"]!.stats.hp).toBe(10); // 30 - 20 = 10
  });

  // 2. ATK合計10 DEF合計30 → ダメージ0（HPは減らない）
  test("ATK合計10 DEF合計30 → ダメージ0（HPは減らない）", () => {
    const attack = [makeCard({ power: 10, element: "NEUTRAL" })];
    const defense = [makeCard({ type: "DEFENSE", power: 30, element: "NEUTRAL" })];

    const state = battleState(attack, defense, 30, 30);
    const result = gameReducer(state, { type: "RESOLVE" });

    expect(result.players["P2"]!.stats.hp).toBe(30); // no damage
  });

  // 3. 闇属性攻撃ATK20 DEF0 → HP=0（即死）
  test("闇属性攻撃ATK20 DEF0 → HP=0（即死）", () => {
    const attack = [makeCard({ power: 20, element: "DARK" })];

    const state = battleState(attack, [], 30, 30);
    const result = gameReducer(state, { type: "RESOLVE" });

    expect(result.players["P2"]!.stats.hp).toBe(0);
    expect(result.phase).toBe("GAME_OVER");
    expect(result.winner).toBe("P1");
  });

  // 4. 光属性攻撃 → 防御カードを出しても防御値0として計算される
  test("光属性攻撃 → 防御カードを出しても防御値0として計算される", () => {
    const attack = [makeCard({ power: 15, element: "LIGHT" })];
    // WATER defense should have 0 effective value against LIGHT attack
    const defense = [makeCard({ type: "DEFENSE", power: 10, element: "WATER" })];

    const state = battleState(attack, defense, 30, 30);
    const result = gameReducer(state, { type: "RESOLVE" });

    // Defense is 0 against LIGHT, so damage = 15
    expect(result.players["P2"]!.stats.hp).toBe(15);
  });

  // 5. 複数攻撃カード（attackPlus）の合計値が正しく計算される
  test("複数攻撃カード（attackPlus）の合計値が正しく計算される", () => {
    const attack = [
      makeCard({ power: 5, element: "FIRE", attackPlus: true }),
      makeCard({ power: 8, element: "FIRE" }),
    ];
    const defense = [makeCard({ type: "DEFENSE", power: 3, element: "WATER" })];

    // Total ATK = 13, DEF = 3 (WATER counters FIRE), damage = 10
    const state = battleState(attack, defense, 30, 30);
    const result = gameReducer(state, { type: "RESOLVE" });

    expect(result.players["P2"]!.stats.hp).toBe(20); // 30 - 10 = 20
  });

  // 6. 両替でHP=0にしたとき即敗北フラグが立つこと
  test("両替でHP=0にしたとき即敗北フラグが立つこと", () => {
    let state = createInitialState(["P1", "P2"]);
    state = gameReducer(state, { type: "DRAW" }); // → EXCHANGE_PHASE

    const p1 = state.players["P1"]!;
    const total = p1.stats.hp + p1.stats.mp + p1.stats.pay;

    state = gameReducer(state, {
      type: "EXCHANGE",
      allocations: { hp: 0, mp: total, pay: 0 },
    });

    expect(state.phase).toBe("GAME_OVER");
    expect(state.winner).toBeDefined();
    expect(state.winner).not.toBe("P1");
  });

  // Extra: HP clamp at 0 (no negative HP)
  test("HP下限は0（負にならない）", () => {
    expect(clampStat(-10)).toBe(0);
  });

  // Extra: HP clamp at 99
  test("HP上限は99（超過分消滅）", () => {
    expect(clampStat(150)).toBe(99);
  });
});

import {
  canDefend,
  resolveAttackElement,
  resolveAttackElementWithLight,
  ELEMENT_COUNTER,
} from "../engine/elementSystem";
import { Element } from "../domain/types";

describe("element.test.ts", () => {
  // 1. 火属性攻撃 → 水属性防御カード：防御有効
  test("火属性攻撃→水属性防御カード：防御有効", () => {
    expect(canDefend("FIRE", "WATER")).toBe(true);
  });

  // 2. 火属性攻撃 → 火属性防御カード：防御無効
  test("火属性攻撃→火属性防御カード：防御無効", () => {
    expect(canDefend("FIRE", "FIRE")).toBe(false);
  });

  // 3. 光属性攻撃：いかなる防御カードでも防御不可
  test("光属性攻撃：いかなる防御カードでも防御不可", () => {
    const allElements: Element[] = [
      "NEUTRAL",
      "FIRE",
      "WATER",
      "WOOD",
      "EARTH",
      "LIGHT",
      "DARK",
    ];
    for (const el of allElements) {
      expect(canDefend("LIGHT", el)).toBe(false);
    }
  });

  // 4. 闇属性攻撃 → 水属性防御カード：防御は有効（ダメージ計算される）
  test("闇属性攻撃→水属性防御カード：防御は有効（ダメージ計算される）", () => {
    // DARK counter includes all elements, so WATER can defend
    expect(canDefend("DARK", "WATER")).toBe(true);
  });

  // 5. 闇属性攻撃でダメージ>0：HP=0になること
  // (Tested in battle.test.ts as well, but verify ELEMENT_COUNTER here)
  test("闇属性攻撃：ELEMENT_COUNTERが全属性を含む", () => {
    const darkCounters = ELEMENT_COUNTER["DARK"];
    const allElements: Element[] = [
      "FIRE",
      "WATER",
      "WOOD",
      "EARTH",
      "LIGHT",
      "DARK",
      "NEUTRAL",
    ];
    for (const el of allElements) {
      expect(darkCounters).toContain(el);
    }
  });

  // 6. 異なる属性のカードを同時使用 → 無属性になること
  test("異なる属性のカードを同時使用→無属性になること", () => {
    expect(resolveAttackElement(["FIRE", "WATER"])).toBe("NEUTRAL");
    expect(resolveAttackElement(["FIRE", "FIRE", "WATER"])).toBe("NEUTRAL");
    expect(resolveAttackElement(["WOOD", "EARTH"])).toBe("NEUTRAL");
  });

  // Bonus: same element stays that element
  test("同一属性のカードを複数使用→その属性になること", () => {
    expect(resolveAttackElement(["FIRE", "FIRE"])).toBe("FIRE");
    expect(resolveAttackElement(["DARK"])).toBe("DARK");
  });

  // 7. 光属性カードを火属性の代替として使用 → 火属性として照合されること
  test("光属性カードを火属性の代替として使用→火属性として照合されること", () => {
    // LIGHT card used as FIRE → effective element is FIRE
    const effectiveElement = resolveAttackElementWithLight(["LIGHT"], "FIRE");
    expect(effectiveElement).toBe("FIRE");

    // After treating as FIRE, WATER should be able to defend
    expect(canDefend("FIRE", "WATER")).toBe(true);
    // FIRE defense should NOT work against FIRE attack
    expect(canDefend("FIRE", "FIRE")).toBe(false);
  });

  // LIGHT defense card can substitute for water to defend fire attack
  test("光属性防御カードは水の代わりとして火属性攻撃を防御できる", () => {
    expect(canDefend("FIRE", "LIGHT")).toBe(true);
  });

  // LIGHT defense card cannot defend LIGHT attack (LIGHT counters = [])
  test("光属性防御カードは光属性攻撃を防御できない", () => {
    expect(canDefend("LIGHT", "LIGHT")).toBe(false);
  });
});

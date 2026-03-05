import { Element } from "../domain/types";

/**
 * Maps attack element to the set of elements that can counter it.
 * 無属性: any element can defend
 * 火: water defends
 * 水: fire defends
 * 木: earth defends
 * 土: wood defends
 * 光: nothing can defend (防御不可)
 * 闇: any element can defend (but if damage > 0 → instant kill)
 */
export const ELEMENT_COUNTER: Record<Element, Element[]> = {
  NEUTRAL: ["FIRE", "WATER", "WOOD", "EARTH", "LIGHT", "DARK", "NEUTRAL"],
  FIRE: ["WATER"],
  WATER: ["FIRE"],
  WOOD: ["EARTH"],
  EARTH: ["WOOD"],
  LIGHT: [], // 防御不可
  DARK: ["FIRE", "WATER", "WOOD", "EARTH", "LIGHT", "DARK", "NEUTRAL"],
};

/**
 * Returns true if defenseElement can counter attackElement.
 * LIGHT defense cards can substitute for FIRE/WATER/WOOD/EARTH.
 */
export function canDefend(
  attackElement: Element,
  defenseElement: Element
): boolean {
  const counters = ELEMENT_COUNTER[attackElement];
  if (counters.includes(defenseElement)) return true;
  // LIGHT defense card can substitute for any of FIRE/WATER/WOOD/EARTH
  if (defenseElement === "LIGHT") {
    const lightSubstitutes: Element[] = ["FIRE", "WATER", "WOOD", "EARTH"];
    return lightSubstitutes.some((sub) => counters.includes(sub));
  }
  return false;
}

/**
 * Resolves the effective element from an array of card elements.
 * Multiple different elements → NEUTRAL
 */
export function resolveAttackElement(elements: Element[]): Element {
  if (elements.length === 0) return "NEUTRAL";
  const unique = [...new Set(elements)];
  if (unique.length === 1) return unique[0];
  return "NEUTRAL";
}

/**
 * Resolves attack element, optionally treating LIGHT cards as a specific element.
 */
export function resolveAttackElementWithLight(
  elements: Element[],
  lightAsElement?: Element
): Element {
  if (lightAsElement) {
    const resolved = elements.map((e) => (e === "LIGHT" ? lightAsElement : e));
    return resolveAttackElement(resolved);
  }
  return resolveAttackElement(elements);
}

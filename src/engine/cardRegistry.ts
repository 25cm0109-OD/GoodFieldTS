import { Card, CardType, Element } from "../domain/types";

let _cardIdCounter = 0;

function makeCard(
  name: string,
  type: CardType,
  element: Element,
  power: number,
  mpCost: number,
  extras?: { attackPlus?: boolean; doubler?: boolean }
): Card {
  _cardIdCounter++;
  return {
    id: `card-${_cardIdCounter}`,
    name,
    type,
    element,
    power,
    mpCost,
    ...extras,
  };
}

export function resetCardIdCounter(): void {
  _cardIdCounter = 0;
}

export const CARD_DEFINITIONS: readonly Card[] = [
  // --- Attack cards ---
  makeCard("火の剣", "ATTACK", "FIRE", 10, 5),
  makeCard("水の槍", "ATTACK", "WATER", 10, 5),
  makeCard("木の矢", "ATTACK", "WOOD", 10, 5),
  makeCard("土の拳", "ATTACK", "EARTH", 10, 5),
  makeCard("光の矢", "ATTACK", "LIGHT", 15, 8),
  makeCard("闇の鎌", "ATTACK", "DARK", 20, 10),
  makeCard("無の斬撃", "ATTACK", "NEUTRAL", 10, 5),
  makeCard("連撃の炎", "ATTACK", "FIRE", 8, 4, { attackPlus: true }),
  makeCard("倍打ちの水", "ATTACK", "WATER", 8, 4, { doubler: true }),
  makeCard("神速の木", "ATTACK", "WOOD", 8, 4, { attackPlus: true }),
  // --- Defense cards ---
  makeCard("水の盾", "DEFENSE", "WATER", 10, 0),
  makeCard("火の盾", "DEFENSE", "FIRE", 10, 0),
  makeCard("木の盾", "DEFENSE", "WOOD", 10, 0),
  makeCard("土の盾", "DEFENSE", "EARTH", 10, 0),
  makeCard("光の盾", "DEFENSE", "LIGHT", 10, 0),
  makeCard("中立の盾", "DEFENSE", "NEUTRAL", 8, 0),
  // --- Exchange cards ---
  makeCard("両替の書", "EXCHANGE", "NEUTRAL", 0, 0),
  makeCard("賢者の両替", "EXCHANGE", "NEUTRAL", 0, 0),
  // --- Miracle cards ---
  makeCard("神聖な炎", "MIRACLE_ATK", "LIGHT", 20, 15),
  makeCard("神聖な守護", "MIRACLE_DEF", "LIGHT", 15, 10),
  // --- Trade cards ---
  makeCard("行商人の業", "SELL", "NEUTRAL", 0, 0),
  makeCard("買い付け", "BUY", "NEUTRAL", 0, 0),
];

export function getCardById(id: string): Card | undefined {
  return CARD_DEFINITIONS.find((c) => c.id === id);
}

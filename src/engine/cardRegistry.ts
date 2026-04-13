import { Ailment, Card, CardType, Element } from "../domain/types";

let _cardIdCounter = 0;

/** Card template with pool-frequency metadata. */
export interface CardTemplate {
  readonly name: string;
  readonly type: CardType;
  readonly element: Element;
  readonly power: number;
  readonly mpCost: number;
  readonly payCost?: number;
  readonly attackPlus?: boolean;
  readonly doubler?: boolean;
  /**
   * Miracle cards: cost MP when used and return to hand instead of discarding.
   * Can be attached to any card type (ATTACK, DEFENSE, HEAL_HP, etc.).
   */
  readonly isMiracle?: boolean;
  readonly areaAttackPercent?: 25 | 50 | 75;
  /** Optional card image filename (e.g. "fire_sword.png") served from /card-images/. */
  readonly image?: string;
  readonly ailment?: Ailment;
  /** How many copies of this card appear in the master pool. */
  readonly frequency: number;
}

function tpl(
  name: string,
  type: CardType,
  element: Element,
  power: number,
  mpCost: number,
  extras: Partial<Omit<CardTemplate, "name" | "type" | "element" | "power" | "mpCost">> = {}
): CardTemplate {
  return { name, type, element, power, mpCost, frequency: 1, ...extras };
}

export const CARD_TEMPLATES: readonly CardTemplate[] = [
  // ── 取引 (EXCHANGE) ─── 60 neutral ─────────────────────────────────────────
  tpl("両替", "EXCHANGE", "NEUTRAL", 0, 0, { payCost: 0, frequency: 60 }),

  // ── 単体攻撃武器 ─── 152 total (non-miracle, non-area) ──────────────────────
  // NEUTRAL 110
  tpl("無の一撃",  "ATTACK", "NEUTRAL",  5, 0, { payCost: 0, frequency: 15 }),
  tpl("無の斬撃",  "ATTACK", "NEUTRAL", 10, 0, { payCost: 0, frequency: 10 }),
  tpl("無の大斬",  "ATTACK", "NEUTRAL", 15, 0, { payCost: 0, frequency: 15 }),
  tpl("無の連撃",  "ATTACK", "NEUTRAL",  8, 0, { payCost: 0, attackPlus: true, frequency: 30 }),
  // FIRE 9
  tpl("火の剣",    "ATTACK", "FIRE",  10, 0, { payCost: 0, frequency: 6 }),
  tpl("連撃の炎",  "ATTACK", "FIRE",   8, 0, { payCost: 0, attackPlus: true, frequency: 3 }),
  // WATER 7
  tpl("水の槍",     "ATTACK", "WATER", 10, 0, { payCost: 0, frequency: 5 }),
  tpl("倍打ちの水", "ATTACK", "WATER",  8, 0, { payCost: 0, attackPlus: true, frequency: 2 }),
  // WOOD 7
  tpl("木の矢",   "ATTACK", "WOOD", 10, 0, { payCost: 0, frequency: 5 }),
  tpl("神速の木", "ATTACK", "WOOD",  8, 0, { payCost: 0, attackPlus: true, frequency: 2 }),
  // EARTH 5
  tpl("土の拳", "ATTACK", "EARTH", 10, 0, { payCost: 0, frequency: 5 }),
  // LIGHT 7
  tpl("光の矢", "ATTACK", "LIGHT", 15, 0, { payCost: 0, frequency: 7 }),
  // DARK 7
  tpl("闇の鎌", "ATTACK", "DARK", 10, 0, { payCost: 0, frequency: 1 }),

  // ── 全体攻撃武器 ─── 18 total (area, non-miracle, no neutral) ───────────────
  tpl("炎の嵐",   "ATTACK", "FIRE",  10, 0, { payCost: 0, areaAttackPercent: 50, frequency: 2 }),
  tpl("暴風雨",   "ATTACK", "WATER",  8, 0, { payCost: 0, areaAttackPercent: 25, frequency: 3 }),
  tpl("木の突風", "ATTACK", "WOOD",   8, 0, { payCost: 0, areaAttackPercent: 25, frequency: 2 }),
  tpl("大地震",   "ATTACK", "EARTH", 12, 0, { payCost: 0, areaAttackPercent: 75, frequency: 2 }),
  tpl("光の爆発", "ATTACK", "LIGHT", 10, 0, { payCost: 0, areaAttackPercent: 50, frequency: 3 }),
  tpl("闇の波動", "ATTACK", "DARK",  10, 0, { payCost: 0, areaAttackPercent: 25, frequency: 1 }),

  // ── 通常防具 ─── 136 total (DEFENSE + REFLECT_PHYSICAL, non-miracle) ─────────
  // NEUTRAL 101
  tpl("中立の盾",     "DEFENSE",          "NEUTRAL", 10, 0, { image: "test.png", payCost: 2, frequency: 50 }),
  tpl("堅牢の盾",     "DEFENSE",          "NEUTRAL", 15, 0, { payCost: 3, frequency: 30 }),
  tpl("跳ね返しの盾", "REFLECT_PHYSICAL", "NEUTRAL",  0, 0, { payCost: 5, frequency: 21 }),
  // FIRE 10
  tpl("火の盾",  "DEFENSE", "FIRE",  10, 0, { payCost: 3, frequency: 10 }),
  // WATER 8
  tpl("水の盾",  "DEFENSE", "WATER", 10, 0, { payCost: 3, frequency: 8 }),
  // WOOD 8
  tpl("木の盾",  "DEFENSE", "WOOD",  10, 0, { payCost: 3, frequency: 8 }),
  // EARTH 7
  tpl("土の盾",  "DEFENSE", "EARTH", 10, 0, { payCost: 3, frequency: 7 }),
  // LIGHT 2
  tpl("光の盾",  "DEFENSE", "LIGHT", 10, 0, { payCost: 5, frequency: 2 }),

  // ── 指輪 (RING) ─── 8 total ──────────────────────────────────────────────────
  tpl("反射の指輪", "RING", "NEUTRAL",  0, 0, { payCost: 3, frequency: 2 }),
  tpl("炎の指輪",   "RING", "FIRE",     0, 0, { payCost: 3, frequency: 3 }),
  tpl("水の指輪",   "RING", "WATER",    0, 0, { payCost: 3, frequency: 4 }),
  tpl("木の指輪",   "RING", "WOOD",     0, 0, { payCost: 3, frequency: 4 }),
  tpl("土の指輪",   "RING", "EARTH",    0, 0, { payCost: 3, frequency: 3 }),
  tpl("光の指輪",   "RING", "LIGHT",    0, 0, { payCost: 3, frequency: 2 }),
  tpl("闇の指輪",   "RING", "DARK",     0, 0, { payCost: 3, frequency: 3 }),

  // ── 奇跡 (isMiracle) ─── 30 total ────────────────────────────────────────────
  // NEUTRAL 11
  tpl("万能跳ね返し", "REFLECT_ALL", "NEUTRAL", 0,  8, { isMiracle: true, frequency: 3 }),
  tpl("奇跡の回復",   "HEAL_HP",     "NEUTRAL", 30, 8, { isMiracle: true, frequency: 4 }),
  tpl("奇跡の再生",   "HEAL_MP",     "NEUTRAL", 20, 5, { isMiracle: true, frequency: 4 }),
  // FIRE 4
  tpl("炎の祈り",   "ATTACK",  "FIRE",  20, 12, { isMiracle: true, frequency: 4 }),
  // WATER 5
  tpl("聖水の槍",   "ATTACK",  "WATER", 20, 12, { isMiracle: true, frequency: 3 }),
  tpl("水の加護",   "DEFENSE", "WATER", 15,  8, { isMiracle: true, frequency: 2 }),
  // WOOD 2
  tpl("木の加護",   "DEFENSE", "WOOD",  15,  8, { isMiracle: true, frequency: 2 }),
  // EARTH 2
  tpl("大地の加護", "DEFENSE", "EARTH", 15,  8, { isMiracle: true, frequency: 2 }),
  // LIGHT 4
  tpl("神聖な炎",   "ATTACK",  "LIGHT", 20, 15, { isMiracle: true, frequency: 2 }),
  tpl("神聖な守護", "DEFENSE", "LIGHT", 15, 10, { isMiracle: true, frequency: 2 }),
  // DARK 2
  tpl("闇の祝福",   "ATTACK",  "DARK",  25, 15, { isMiracle: true, frequency: 2 }),

  // ── 雑貨 ─── 88 total (全てNEUTRAL) ─────────────────────────────────────────
  // HEAL_HP 12
  tpl("回復薬",       "HEAL_HP", "NEUTRAL", 10, 0, { payCost:  5, frequency:  8 }),
  tpl("大回復薬",     "HEAL_HP", "NEUTRAL", 20, 0, { payCost: 10, frequency:  4 }),
  // HEAL_MP 12
  tpl("マナポーション",   "HEAL_MP", "NEUTRAL", 15, 0, { payCost:  5, frequency: 8 }),
  tpl("大マナポーション", "HEAL_MP", "NEUTRAL", 20, 0, { payCost: 10, frequency: 4 }),
  // SELL/BUY 10s
  tpl("売る",   "SELL", "NEUTRAL", 0, 0, { payCost: 5, frequency: 60 }),
  tpl("買う",   "BUY",  "NEUTRAL", 0, 0, { payCost: 8, frequency: 60 }),
  // 新カード 9
  tpl("天国の薬",     "HEAVEN_DISEASE_HEAL", "NEUTRAL", 20, 0, { payCost: 3, frequency: 3 }),
  tpl("厄払いの書",   "CLEANSE",             "NEUTRAL",  0, 0, { payCost: 5, frequency: 3 }),
  tpl("奇跡消しの書", "DISPEL_MIRACLE",      "NEUTRAL",  0, 0, { payCost: 8, frequency: 3 }),
  // DISASTER 45 (全てNEUTRAL)
  tpl("風邪のたね",   "DISASTER", "NEUTRAL", 0, 0, { payCost: 0, ailment: "風邪",   frequency: 30}),
  tpl("熱病の呪い",   "DISASTER", "NEUTRAL", 0, 0, { payCost: 3, ailment: "熱病",   frequency: 6 }),
  tpl("地獄病の瘴気", "DISASTER", "NEUTRAL", 0, 0, { payCost: 5, ailment: "地獄病", frequency: 6 }),
  tpl("天国病の光",   "DISASTER", "NEUTRAL", 0, 0, { payCost: 4, ailment: "天国病", frequency: 4 }),
  tpl("霧のとばり",   "DISASTER", "NEUTRAL", 0, 0, { payCost: 0, ailment: "霧",     frequency: 6 }),
  tpl("閃光の呪縛",   "DISASTER", "NEUTRAL", 0, 0, { payCost: 0, ailment: "閃光",   frequency: 26 }),
  tpl("夢幻の霞",     "DISASTER", "NEUTRAL", 0, 0, { payCost: 0, ailment: "夢",     frequency: 5 }),
  tpl("暗雲の呪い",   "DISASTER", "NEUTRAL", 0, 0, { payCost: 2, ailment: "暗雲",   frequency: 25 }),
];

/** Create a Card instance from a template, assigning a unique incremental ID. */
export function makeCardFromTemplate(
  t: Omit<CardTemplate, "frequency">
): Card {
  _cardIdCounter++;
  return {
    id: `card-${_cardIdCounter}`,
    name: t.name,
    type: t.type,
    element: t.element,
    power: t.power,
    mpCost: t.mpCost,
    ...(t.payCost !== undefined && { payCost: t.payCost }),
    ...(t.attackPlus && { attackPlus: true }),
    ...(t.doubler && { doubler: true }),
    ...(t.isMiracle && { isMiracle: true }),
    ...(t.areaAttackPercent && { areaAttackPercent: t.areaAttackPercent }),
    ...(t.image && { image: t.image }),
    ...(t.ailment && { ailment: t.ailment }),
  };
}

export function resetCardIdCounter(): void {
  _cardIdCounter = 0;
}

/** Legacy factory kept for test-helper compatibility. */
export function makeCard(
  name: string,
  type: CardType,
  element: Element,
  power: number,
  mpCost: number,
  extras?: {
    payCost?: number;
    attackPlus?: boolean;
    doubler?: boolean;
    isMiracle?: boolean;
    areaAttackPercent?: 25 | 50 | 75;
  }
): Card {
  return makeCardFromTemplate({ name, type, element, power, mpCost, ...extras });
}

/** One canonical Card instance per template (stable IDs for lookup). */
export const CARD_DEFINITIONS: readonly Card[] = CARD_TEMPLATES.map(
  (t) => makeCardFromTemplate(t)
);

export function getCardById(id: string): Card | undefined {
  return CARD_DEFINITIONS.find((c) => c.id === id);
}

/**
 * Returns the "大分類" category of a card, used for 夢状態 illusion matching.
 * Miracle cards form their own category; otherwise based on CardType.
 */
export type CardCategory = "武器" | "防具" | "奇跡" | "雑貨" | "取引";

export function getCardCategory(card: { type: CardType; isMiracle?: boolean }): CardCategory {
  if (card.isMiracle) return "奇跡";
  if (card.type === "ATTACK") return "武器";
  if (
    card.type === "DEFENSE" ||
    card.type === "REFLECT_PHYSICAL" ||
    card.type === "REFLECT_ALL" ||
    card.type === "RING"
  ) return "防具";
  if (card.type === "EXCHANGE") return "取引";
  return "雑貨";
}

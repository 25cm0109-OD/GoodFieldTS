import type { CardType, Element, Phase } from "../../domain/types";

/**
 * UI 表示専用ラベルを集約。
 * ロジック層 (engine) とは切り離し、CLI/ブラウザUIから共通参照する。
 */
export const ELEMENT_EMOJI: Readonly<Record<Element, string>> = {
  FIRE: "🔥",
  WATER: "💧",
  WOOD: "🌿",
  EARTH: "🪨",
  LIGHT: "☀️",
  DARK: "🌑",
  NEUTRAL: "⬜",
};

export const ELEMENT_LABEL: Readonly<Record<Element, string>> = {
  FIRE: "火",
  WATER: "水",
  WOOD: "木",
  EARTH: "土",
  LIGHT: "光",
  DARK: "闇",
  NEUTRAL: "無",
};

export const TYPE_LABEL: Readonly<Record<CardType, string>> = {
  ATTACK: "攻",
  DEFENSE: "守",
  EXCHANGE: "両替",
  SELL: "売",
  BUY: "買",
  HEAL_HP: "HP回復",
  HEAL_MP: "MP回復",
  REFLECT_PHYSICAL: "跳ね返し",
  REFLECT_ALL: "全跳ね返し",
  DISASTER: "災い",
  RING: "指輪",
  CLEANSE: "厄払い",
  DISPEL_MIRACLE: "奇跡消し",
  HEAVEN_DISEASE_HEAL: "天国の薬",
};

export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  DRAW_PHASE: "ドロー",
  EXCHANGE_PHASE: "アクション",
  DEFENSE_PHASE: "防御",
  RESOLVE_PHASE: "解決",
  END_CHECK: "終了確認",
  GAME_OVER: "ゲームオーバー",
};

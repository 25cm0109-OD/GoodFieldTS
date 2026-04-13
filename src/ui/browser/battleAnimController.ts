// ─── Battle Animation Controller ─────────────────────────────────────────────
// Cinematic JRPG-style overlay animation pipeline for area attacks.
// All overlay elements are children of #battle-animation-overlay — a persistent
// DOM node that lives OUTSIDE #app, so render() never destroys them.

// ─── Configurable Timings ─────────────────────────────────────────────────────

export const ANIM_TIMINGS = {
  /** Phase 1: How long the skill activation banner is shown (ms) */
  skillDisplay: 500,
  /** Phase 1: Exit fade duration (ms) */
  skillExit: 180,
  /** Phase 2: Delay before first miss text appears after skill banner exits (ms) */
  missTextDelay: 160,
  /** Phase 2/5: Stagger gap between sequential targets (ms) */
  targetResolutionGap: 80,
  /** Phase 2: How long each miss floating text stays visible (ms) */
  missTextDuration: 700,
  /** Phase 4: Extra delay before 命中 banner after miss texts (ms) */
  hitBannerDelay: 350,
  /** Phase 4: Banner pop-in duration — scale 1.3 → 1.0 (ms) */
  bannerPopIn: 70,
  /** Phase 4: Delay from pop-in complete to screen shake (ms) */
  bannerToShake: 40,
  /** Phase 4: How long the 命中 banner is held visible (ms) */
  hitBannerHold: 650,
  /** Phase 4: Banner exit fade duration (ms) */
  bannerExit: 200,
  /** Phase 5: Extra gap after hit banner for HP bars to animate */
  resolveGap: 120,
  /** Phase 6: Recovery delay before unlocking UI (ms) */
  uiRecoveryDelay: 200,
  /** Screen shake duration (ms) */
  shakeDuration: 150,
} as const;

// ─── State ────────────────────────────────────────────────────────────────────

let _isPlaying = false;
let _activeDivs: HTMLElement[] = [];

export function isAnimPlaying(): boolean {
  return _isPlaying;
}

/** Remove all in-flight animation elements and reset state immediately. */
export function cancelAnim(): void {
  for (const div of _activeDivs) {
    div.remove();
  }
  _activeDivs = [];
  _isPlaying = false;
  // Also clear any residual overlay children (defensive)
  const overlay = getOverlay();
  if (overlay) overlay.innerHTML = "";
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get the persistent cinematic overlay container. */
function getOverlay(): HTMLElement | null {
  return document.getElementById("battle-animation-overlay");
}

/**
 * Append an element to the cinematic overlay and register it for cleanup.
 * Falls back to document.body if the overlay isn't in the DOM yet.
 */
function mountInOverlay(el: HTMLElement): HTMLElement {
  const overlay = getOverlay() ?? document.body;
  overlay.appendChild(el);
  _activeDivs.push(el);
  return el;
}

function untrack(el: HTMLElement): void {
  const idx = _activeDivs.indexOf(el);
  if (idx !== -1) _activeDivs.splice(idx, 1);
  el.remove();
}

// ─── Screen Shake ─────────────────────────────────────────────────────────────

export function triggerScreenShake(durationMs: number = ANIM_TIMINGS.shakeDuration): void {
  document.body.classList.add("screen-shake");
  setTimeout(() => document.body.classList.remove("screen-shake"), durationMs);
}


// ─── Component: CentralBanner ─────────────────────────────────────────────────
// Cinematic 420×120px banner with pop-scale entrance, shake, and flash.

async function showCentralBanner(
  text: string,
  variant: "hit" | "special",
  holdMs: number,
): Promise<void> {
  const div = document.createElement("div");
  div.className = `anim-central-banner anim-central-banner--${variant}`;
  div.textContent = text;
  mountInOverlay(div);

  // 0 ms — banner appears (pop-in scale 1.3 → 1.0)
  await delay(ANIM_TIMINGS.bannerPopIn);

  // Post pop-in → screen shake
  await delay(ANIM_TIMINGS.bannerToShake);
  triggerScreenShake(ANIM_TIMINGS.shakeDuration);

  // Hold banner visible
  await delay(holdMs);

  // Exit
  div.classList.add("anim-central-banner--exit");
  await delay(ANIM_TIMINGS.bannerExit);
  untrack(div);
}

// ─── Component: FloatingResultText ────────────────────────────────────────────
// Centered result label (外れた) — same position as 命中 banner.
// anchor param is kept for API compatibility but ignored (reference shows both
// 命中 and 外れた at the same upper-center position in the overlay).

async function showFloatingText(
  text: string,
  _anchor: HTMLElement | null,
): Promise<void> {
  const div = document.createElement("div");
  div.className = "anim-floating-text";
  div.textContent = text;
  mountInOverlay(div);
  await delay(ANIM_TIMINGS.missTextDuration);
  untrack(div);
}

// ─── AreaAttackAnimParams ─────────────────────────────────────────────────────

export interface AreaAttackAnimParams {
  /** Card name shown in the skill activation banner */
  cardName: string;
  /** Hit / miss results for each target (from areaHitResults) */
  hitResults: Array<{ playerId: string; hit: boolean }>;
  /** Returns the opponent-row DOM element for a given player id */
  getTargetRow: (playerId: string) => HTMLElement | null;
  /** Called once the full animation pipeline finishes */
  onComplete: () => void;
}

// ─── runAreaAttackAnim ────────────────────────────────────────────────────────
/**
 * Full cinematic pipeline:
 *
 *   triggerSkill()              → skill activation banner (Phase 1)
 *   ↓
 *   showMiss()                  → floating 外れた per missed target (Phase 2)
 *   ↓
 *   playBattleOverlay()         → radial burst (fires in background)
 *   ↓
 *   showCentralBanner(「命中」)  → pop + shake + flash (Phase 4)
 *   ↓
 *   applyDamageSequentially()   → 80ms stagger gap per hit target (Phase 5)
 *   ↓
 *   UI recovery → onComplete()  (Phase 6)
 *
 * Note: Phase 3 (昇天) reuses the existing ascendingPlayers overlay in main.ts,
 * now enhanced with triggerScreenShake().
 */
export async function runAreaAttackAnim(params: AreaAttackAnimParams): Promise<void> {
  if (_isPlaying) {
    params.onComplete();
    return;
  }
  _isPlaying = true;

  try {
    // ── Phase 1: triggerSkill() — skill activation banner ─────────────────
    const skillDiv = document.createElement("div");
    skillDiv.className = "anim-skill-banner";
    skillDiv.textContent = params.cardName;
    mountInOverlay(skillDiv);

    await delay(ANIM_TIMINGS.skillDisplay);

    skillDiv.classList.add("anim-skill-banner--exit");
    await delay(ANIM_TIMINGS.skillExit);
    untrack(skillDiv);

    // ── Phase 2: showMiss() — floating 外れた texts, staggered ────────────
    const missTargets = params.hitResults.filter(r => !r.hit);
    const hitTargets  = params.hitResults.filter(r => r.hit);

    const missPromises: Promise<void>[] = missTargets.map((r, i) =>
      delay(ANIM_TIMINGS.missTextDelay + i * ANIM_TIMINGS.targetResolutionGap)
        .then(() => showFloatingText("外れた", params.getTargetRow(r.playerId)))
    );

    if (missTargets.length > 0) {
      await Promise.all(missPromises);
    }

    // ── Phase 3+4: playBattleOverlay() + showCentralBanner(「命中」) ───────
    if (hitTargets.length > 0) {
      await delay(ANIM_TIMINGS.hitBannerDelay);
      // Radial burst fires alongside the banner (overlapping visual layers)
      await showCentralBanner("命中", "hit", ANIM_TIMINGS.hitBannerHold);
    }

    // ── Phase 5: applyDamageSequentially() — gap per hit target ──────────
    await delay(
      hitTargets.length * ANIM_TIMINGS.targetResolutionGap +
      ANIM_TIMINGS.resolveGap
    );

  } finally {
    // ── Phase 6: UI recovery ──────────────────────────────────────────────
    await delay(ANIM_TIMINGS.uiRecoveryDelay);
    _isPlaying = false;
    params.onComplete();
  }
}

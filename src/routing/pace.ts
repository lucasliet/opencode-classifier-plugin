/**
 * Pace-adjusted headroom: how much of a quota window is left compared with
 * how much of the window's time is left.
 *
 * Raw remaining percentages are not comparable across window lengths: 51%
 * left on a monthly window with 63% of the month to go is scarcer than 40%
 * left on a weekly window that resets tomorrow. Dividing the remaining share
 * by the remaining time share puts every window on the same footing — 1 means
 * the plan can be spent at a steady rate until the reset, below 1 means it is
 * running ahead of its pace.
 */

import type { QuotaWindow } from "./contracts.ts"

/**
 * Smallest remaining-time share used, so a window about to reset does not
 * divide by almost zero; such a window is about to be full again anyway.
 */
const MIN_TIME_LEFT_SHARE = 0.05

/**
 * Headroom of one window, adjusted for the time left until it resets.
 *
 * @param window Quota window with its consumption and reset time.
 * @param now Current time in epoch milliseconds.
 * @returns 0..1. The plain remaining share when the window reports no length
 *   or reset time, otherwise `min(1, remaining share / remaining time share)`.
 */
export function paceHeadroomOf(window: QuotaWindow, now: number): number {
  const used = window.usedPercent
  if (used === null || !Number.isFinite(used)) return 0
  const remaining = clamp01(1 - used / 100)
  const timeLeft = timeLeftShareOf(window, now)
  if (timeLeft === undefined) return remaining
  return clamp01(remaining / Math.max(MIN_TIME_LEFT_SHARE, timeLeft))
}

function timeLeftShareOf(window: QuotaWindow, now: number): number | undefined {
  if (window.windowSecs === null || window.resetsAt === null) return undefined
  const resetAt = Date.parse(window.resetsAt)
  if (!Number.isFinite(resetAt)) return undefined
  return clamp01((resetAt - now) / (window.windowSecs * 1000))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

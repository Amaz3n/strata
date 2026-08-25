// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { resolveProjectTimeline } from "@/lib/services/project-overview"

const today = new Date("2026-08-23T12:00:00.000Z")

describe("project overview timeline", () => {
  it("reports elapsed and remaining days for a project underway", () => {
    const timeline = resolveProjectTimeline({ start_date: "2026-08-03", end_date: "2026-10-02" }, today)
    expect(timeline.totalDays).toBe(60)
    expect(timeline.daysElapsed).toBe(20)
    expect(timeline.daysRemaining).toBe(40)
    expect(timeline.daysUntilStart).toBe(0)
    expect(timeline.timeElapsedPercent).toBe(33)
  })

  it("counts down to a project that has not started", () => {
    const timeline = resolveProjectTimeline({ start_date: "2026-09-02", end_date: "2026-11-01" }, today)
    expect(timeline.daysUntilStart).toBe(10)
    expect(timeline.daysElapsed).toBe(0)
    expect(timeline.timeElapsedPercent).toBe(0)
  })

  it("never reports elapsed past the end date", () => {
    const timeline = resolveProjectTimeline({ start_date: "2026-01-01", end_date: "2026-02-01" }, today)
    expect(timeline.daysElapsed).toBe(timeline.totalDays)
    expect(timeline.daysRemaining).toBe(0)
    expect(timeline.timeElapsedPercent).toBe(100)
  })

  it("reports a zero-length timeline rather than a fake one-day project", () => {
    const timeline = resolveProjectTimeline({}, today)
    expect(timeline.totalDays).toBe(0)
    expect(timeline.timeElapsedPercent).toBe(0)
  })
})

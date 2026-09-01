// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import {
  parsePayableDueFilter,
  parsePayableQueue,
  parseProjectPayablesQuery,
} from "./payables-queues"

describe("payables queue contract", () => {
  it("defaults unknown queue values to needs approval instead of broadening to all", () => {
    expect(parsePayableQueue("typo")).toBe("approval")
    expect(parsePayableQueue(undefined)).toBe("approval")
  })

  it("keeps legacy project links working while writing canonical lifecycle values", () => {
    expect(parsePayableQueue("needs_review")).toBe("approval")
    expect(parsePayableQueue("payable")).toBe("ready")
  })

  it("treats urgency as an independent dimension", () => {
    expect(parseProjectPayablesQuery({ queue: "ready", due: "overdue" })).toEqual({
      queue: "ready",
      due: "overdue",
    })
  })

  it("normalizes old urgency-as-queue links without losing their intent", () => {
    expect(parseProjectPayablesQuery({ queue: "due_soon" })).toEqual({
      queue: "approval",
      due: "due_soon",
    })
  })

  it("rejects unknown urgency values", () => {
    expect(parsePayableDueFilter("whenever")).toBe("any")
  })
})

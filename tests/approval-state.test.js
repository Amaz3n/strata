"use strict"

/**
 * `lib/selections/approval-state.ts` — unsigned, sent, declined, expired and
 * approved stay distinct, and the coordinator is told why a group cannot be
 * sent.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { freshRequire } = require("./support/modules")

const { approvalBlocker, latestApproval, selectionApprovalState } = freshRequire("lib/selections/approval-state.ts")

const NOW = new Date("2026-10-12T12:00:00Z")
const request = (overrides = {}) => ({
  id: "a", status: "sent", channel: "portal", termsHash: "h", totalCents: 100, sentAt: "2026-10-10T00:00:00Z",
  expiresAt: null, approvedAt: null, declineReason: null, voidReason: null, ...overrides,
})
const terms = (overrides = {}) => ({ termsHash: "h", totalCents: 100, lineCount: 2, complete: true, confirmed: false, ...overrides })

test("each way a request ends reads as its own state", () => {
  const cases = [
    [null, "unsigned", null],
    [request(), "sent", null],
    [request({ expiresAt: "2026-10-12T11:59:00Z" }), "expired", null],
    [request({ status: "expired" }), "expired", null],
    [request({ status: "declined", declineReason: "Wrong tile" }), "declined", "Wrong tile"],
    [request({ status: "voided", voidReason: "The selections changed after they were sent" }), "unsigned", "The selections changed after they were sent"],
    [request({ status: "approved", approvedAt: "2026-10-11T00:00:00Z" }), "approved", null],
  ]
  for (const [latest, state, reason] of cases) {
    assert.deepEqual(selectionApprovalState(latest, NOW), { state, reason }, latest?.status ?? "none")
  }
})

test("the newest request decides", () => {
  const older = request({ id: "old", status: "declined", sentAt: "2026-10-01T00:00:00Z" })
  const newer = request({ id: "new", sentAt: "2026-10-05T00:00:00Z" })
  assert.equal(latestApproval([older, newer]).id, "new")
  assert.equal(latestApproval([]), null)
})

test("a group can be sent only when every choice is made, nothing is out, and the deadline has not passed", () => {
  assert.equal(approvalBlocker("unsigned", terms(), false), null)
  assert.equal(approvalBlocker("declined", terms(), false), null)
  assert.match(approvalBlocker("unsigned", terms({ complete: false }), false), /every category/)
  assert.match(approvalBlocker("sent", terms(), false), /Waiting on the buyer/)
  assert.match(approvalBlocker("unsigned", terms(), true), /deadline has passed/)
  assert.match(approvalBlocker("unsigned", terms({ confirmed: true }), false), /change order/)
  assert.match(approvalBlocker("unsigned", terms({ lineCount: 0 }), false), /no selections/)
})

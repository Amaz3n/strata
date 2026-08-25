import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const scheduleSource = readFileSync("lib/services/invoice-schedules.ts", "utf8")
const runnerSource = scheduleSource.slice(scheduleSource.indexOf("export async function runDueInvoiceSchedules"))
const lateFeeSource = readFileSync("app/api/jobs/late-fees/route.ts", "utf8")

test("recurring billing claims a schedule before creating its invoice", () => {
  const claimIndex = runnerSource.indexOf('.from("invoice_schedules")')
  const createIndex = runnerSource.indexOf("createInvoice(")
  assert.ok(claimIndex >= 0 && createIndex > claimIndex)
})

test("recurring billing claim is guarded by the original due date", () => {
  assert.match(runnerSource, /\.eq\("next_run_on", originalNextRunOn\)/)
})

test("recurring billing releases its own claim when invoice creation fails", () => {
  const catchIndex = runnerSource.indexOf("catch (createError)")
  assert.ok(catchIndex >= 0)
  assert.match(runnerSource.slice(catchIndex), /\.eq\("next_run_on", nextRunOn\)/)
})

test("late-fee cron exposes individual application failures", () => {
  assert.match(lateFeeSource, /applyError\.message/)
  assert.match(lateFeeSource, /failed: failures\.length/)
  assert.match(lateFeeSource, /status: failures\.length > 0 \? 207 : 200/)
})

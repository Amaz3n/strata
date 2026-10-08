// The golden scenario catalog (B00.3): every scenario in GOLDEN_SCENARIOS (runtime.cjs),
// with its module when built, or why it is not built yet and which package owns
// it. The runner runs only what is here, and verify-catalog.cjs fails when the
// plan, the tracker, the expected files and this list disagree.

/** Built and run by scenario-runner.cjs. */
const IMPLEMENTED = {
  "BILL-01": "./scenarios/bill-01.cjs",
  "WIP-01": "./scenarios/wip-01.cjs",
  "YEAR-01": "./scenarios/year-01.cjs",
  "CLOSE-01": "./scenarios/close-01.cjs",
  "BANK-01": "./scenarios/bank-01.cjs",
  "STATUS-01": "./scenarios/status-01.cjs",
  "RACE-01": "./scenarios/race-01.cjs",
  "CAP-01": "./scenarios/cap-01.cjs",
  "DIM-01": "./scenarios/dim-01.cjs",
  "HIST-01": "./scenarios/hist-01.cjs",
  "REV-01": "./scenarios/rev-01.cjs",
  "HOME-01": "./scenarios/home-01.cjs",
  "LOSS-01": "./scenarios/loss-01.cjs",
  "ENTITY-01": "./scenarios/entity-01.cjs",
  "CASH-01": "./scenarios/cash-01.cjs",
  "TAX-01": "./scenarios/tax-01.cjs",
  "RESTORE-01": "./scenarios/restore-01.cjs",
  "INTERCO-01": "./scenarios/interco-01.cjs",
  "CONSOL-01": "./scenarios/consol-01.cjs",
  "MIG-01": "./scenarios/mig-01.cjs",
  "AUTH-01": "./scenarios/auth-01.cjs",
  "GREEN-01": "./scenarios/green-01.cjs",
}

/**
 * Named by the plan but not built. `deferred` is outside the first-client scope;
 * `blocked` waits on something outside the repository; `not_built` is open work.
 */
const NOT_IMPLEMENTED = {
  "STORE-01": { status: "blocked", packages: ["B06.4"], reason: "Needs real R2 storage (an authorized test bucket) for privacy, overwrite, retention and byte checks." },
  "PAY-01": { status: "deferred", packages: ["B13"], reason: "Payroll is not day one; it arrives as a reviewed summary journal." },
  "PAY-02": { status: "deferred", packages: ["B13"], reason: "Payroll is not day one; it arrives as a reviewed summary journal." },
}

/** Subcases a built scenario names but does not implement yet, and who owns each. */
const OPEN_SUBCASES = {}

module.exports = { IMPLEMENTED, NOT_IMPLEMENTED, OPEN_SUBCASES }

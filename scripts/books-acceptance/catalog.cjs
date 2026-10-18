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
  "STORE-01": "./scenarios/store-01.cjs",
  "LOT-01": "./scenarios/lot-01.cjs",
  "RACE-02": "./scenarios/race-02.cjs",
  "SEC-01": "./scenarios/sec-01.cjs",
  "PROD-01": "./scenarios/prod-01.cjs",
  "LAND-01": "./scenarios/land-01.cjs",
  "LEAD-01": "./scenarios/lead-01.cjs",
  "SALE-01": "./scenarios/sale-01.cjs",
  "SEL-01": "./scenarios/sel-01.cjs",
  "PERMIT-01": "./scenarios/permit-01.cjs",
  "FLOW-01": "./scenarios/flow-01.cjs",
  "CUT-01": "./scenarios/cut-01.cjs",
  "RELEASE-01": "./scenarios/release-01.cjs",
  "TRADE-01": "./scenarios/trade-01.cjs",
  "BID-01": "./scenarios/bid-01.cjs",
  "PO-01": "./scenarios/po-01.cjs",
  "VPO-01": "./scenarios/vpo-01.cjs",
  "SUPPLY-01": "./scenarios/supply-01.cjs",
  "FIELD-01": "./scenarios/field-01.cjs",
  "MONEY-01": "./scenarios/money-01.cjs",
  "WARR-01": "./scenarios/warr-01.cjs",
  "CUTOVER-01": "./scenarios/cutover-01.cjs",
  "OPS-01": "./scenarios/ops-01.cjs",
  "SCALE-01": "./scenarios/scale-01.cjs",
  "RACE-03": "./scenarios/race-03.cjs",
  "RESTORE-02": "./scenarios/restore-02.cjs",
  "ROLE-01": "./scenarios/role-01.cjs",
  "SPEC-01": "./scenarios/spec-01.cjs",
  "CANCEL-01": "./scenarios/cancel-01.cjs",
  "DELAY-01": "./scenarios/delay-01.cjs",
  "WARR-02": "./scenarios/warr-02.cjs",
}

/** Built, but run only against real storage (`--storage-env`); otherwise reported blocked. */
const NEEDS_STORAGE = {
  "STORE-01": { status: "blocked", packages: ["B06.4"], reason: "Runs only with --storage-env naming the acceptance bucket's key file." },
}

/**
 * Named by the plan but not built. `deferred` is outside the first-client scope;
 * `blocked` waits on something outside the repository; `not_built` is open work.
 */
const NOT_IMPLEMENTED = {
  "PAY-01": { status: "deferred", packages: ["B13"], reason: "Payroll is not day one; it arrives as a reviewed summary journal." },
  "PAY-02": { status: "deferred", packages: ["B13"], reason: "Payroll is not day one; it arrives as a reviewed summary journal." },
}

/**
 * Production scenarios (EP14). They run on the same stack and runner, but a step the
 * chain cannot take yet (a product defect, or storage this run does not have) is listed
 * as open with its reason, so the scenario is INCOMPLETE rather than FAILED. An
 * incomplete production scenario does not fail an all-scenarios run; a failed one does.
 */
const PRODUCTION = { "LOT-01": { checklist: "EP14-01" }, "RACE-02": { checklist: "EP14-01" }, "SEC-01": { checklist: "EP02-04" }, "PROD-01": { checklist: "EP03-04" }, "LAND-01": { checklist: "EP04-01" }, "LEAD-01": { checklist: "EP05-01" }, "SALE-01": { checklist: "EP05-03" }, "SEL-01": { checklist: "EP06-01" }, "PERMIT-01": { checklist: "EP06-06" }, "FLOW-01": { checklist: "EP07-01" }, "CUT-01": { checklist: "EP07-18" }, "RELEASE-01": { checklist: "EP07-04" }, "TRADE-01": { checklist: "EP07-06" }, "BID-01": { checklist: "EP08-03" }, "PO-01": { checklist: "EP08-07" }, "VPO-01": { checklist: "EP08-09" }, "SUPPLY-01": { checklist: "EP08-08" }, "FIELD-01": { checklist: "EP09-04" }, "MONEY-01": { checklist: "EP10-02" }, "WARR-01": { checklist: "EP11-01" }, "CUTOVER-01": { checklist: "EP12-03" }, "OPS-01": { checklist: "EP13-03" }, "SCALE-01": { checklist: "EP13-02" }, "RACE-03": { checklist: "EP13-07" }, "RESTORE-02": { checklist: "EP13-08" }, "ROLE-01": { checklist: "EP14-06" }, "SPEC-01": { checklist: "EP14-02" }, "CANCEL-01": { checklist: "EP14-03" }, "DELAY-01": { checklist: "EP14-04" }, "WARR-02": { checklist: "EP14-05" } }

/**
 * Built, but too long for the all-scenarios run: they seed a full-size builder, hold a
 * load for minutes, or dump and restore the whole database. `--scenario ID` runs one and
 * `--include-long-running` runs them inside `--all`. Otherwise `--all` reads each one's
 * evidence from `--long-run-evidence DIR` (<ID>.json from a whole `--scenario` run,
 * recorded on the current commit or within the last 7 days) and judges it like any
 * other result; with none fresh it is NOT_RUN and the verdict fails.
 */
const LONG_RUNNING = {
  "SCALE-01": "Seeds the first-builder profile (about two minutes) and holds a 50-session load for five.",
  "RESTORE-02": "Dumps and restores the whole acceptance database and reconciles every table.",
}

/** Subcases a built scenario names but does not implement yet, and who owns each. */
const OPEN_SUBCASES = {
  "SCALE-01": {
    "desk-render-at-scale": "EP13-02",
    "desk-p95-under-load": "EP13-02",
  },
  "BID-01": {
    "bidder-uses-the-portal-on-a-community-package": "EP08-03",
  },
}

module.exports = { IMPLEMENTED, NOT_IMPLEMENTED, NEEDS_STORAGE, LONG_RUNNING, OPEN_SUBCASES, PRODUCTION }

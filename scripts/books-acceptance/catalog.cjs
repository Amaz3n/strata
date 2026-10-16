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
const PRODUCTION = { "LOT-01": { checklist: "EP14-01" }, "RACE-02": { checklist: "EP14-01" }, "SEC-01": { checklist: "EP02-04" }, "PROD-01": { checklist: "EP03-04" }, "LAND-01": { checklist: "EP04-01" }, "LEAD-01": { checklist: "EP05-01" }, "SALE-01": { checklist: "EP05-03" }, "SEL-01": { checklist: "EP06-01" }, "PERMIT-01": { checklist: "EP06-06" }, "FLOW-01": { checklist: "EP07-01" }, "CUT-01": { checklist: "EP07-18" }, "RELEASE-01": { checklist: "EP07-04" }, "TRADE-01": { checklist: "EP07-06" }, "BID-01": { checklist: "EP08-03" }, "PO-01": { checklist: "EP08-07" }, "VPO-01": { checklist: "EP08-09" }, "SUPPLY-01": { checklist: "EP08-08" } }

/** Subcases a built scenario names but does not implement yet, and who owns each. */
const OPEN_SUBCASES = {
  "LOT-01": {
    "agreement-signs-through-an-envelope": "EP14-01",
    "release-copies-the-plan-set": "EP14-01",
  },
}

module.exports = { IMPLEMENTED, NOT_IMPLEMENTED, NEEDS_STORAGE, OPEN_SUBCASES, PRODUCTION }

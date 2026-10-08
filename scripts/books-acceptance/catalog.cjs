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
}

/**
 * Named by the plan but not built. `deferred` is outside the first-client scope;
 * `blocked` waits on something outside the repository; `not_built` is open work.
 */
const NOT_IMPLEMENTED = {
  "MIG-01": { status: "not_built", packages: ["B03.3", "B15.1"], reason: "Importing an existing builder's trial balance with its outstanding items, through dual review to the first collection and cutover.",
    coveredSoFar: "HIST-01 opening-items, ENTITY-01 company-openings and BANK-01 imported-outstanding-items cover parts of it." },
  "GREEN-01": { status: "not_built", packages: ["B15.1"], reason: "A zero-history company set up through the normal screens to its first invoice, bill and expense.",
    coveredSoFar: "Every scenario launches a greenfield company through the services, not the screens." },
  "INTERCO-01": { status: "not_built", packages: ["B14.3"], reason: "Advances and partial repayment between companies, one company closed, and a failed reciprocal leg retried.",
    coveredSoFar: "ENTITY-01 payment-across-companies and intercompany-lot-sale cover payments and lot sales between companies." },
  "CONSOL-01": { status: "not_built", packages: ["B14.4"], reason: "Group membership effective by date, mapped accounts, approved eliminations and a later membership change.",
    coveredSoFar: "ENTITY-01 and the two-companies journey cover the consolidated trial balance with eliminations." },
  "AUTH-01": { status: "not_built", packages: ["B15.3"], reason: "Accountant, independent reviewer, division operator, ordinary project user and a foreign organization across every added path.",
    coveredSoFar: "Each scenario checks its own refusals (self-review, foreign ids, readers without tax filing rights)." },
  "STORE-01": { status: "blocked", packages: ["B06.4"], reason: "Needs real R2 storage (an authorized test bucket) for privacy, overwrite, retention and byte checks." },
  "PAY-01": { status: "deferred", packages: ["B13"], reason: "Payroll is not day one; it arrives as a reviewed summary journal." },
  "PAY-02": { status: "deferred", packages: ["B13"], reason: "Payroll is not day one; it arrives as a reviewed summary journal." },
}

/** Subcases a built scenario names but does not implement yet, and who owns each. */
const OPEN_SUBCASES = {
  "CLOSE-01": { "quarter-end": "B01.2", "all-supported-modules": "B15.2" },
  "RACE-01": { "entity-pair": "B14.3" },
}

module.exports = { IMPLEMENTED, NOT_IMPLEMENTED, OPEN_SUBCASES }

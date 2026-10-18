require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  preconBriefSchema,
  preconDecisionSchema,
  EMPTY_PRECON_BRIEF,
} = require("../lib/precon/workspace");

const decision = {
  title: "Confirm electrical scope",
  kind: "scope",
  owner_user_id: null,
  due_date: null,
  cost_impact_cents: null,
  blocks_agreement: false,
  blocks_start: false,
  status: "open",
  detail: "",
  resolution: "",
};

test("conditions require accountable owners and resolved decisions require rationale", () => {
  assert.equal(preconDecisionSchema.safeParse(decision).success, true);
  assert.equal(
    preconDecisionSchema.safeParse({ ...decision, blocks_start: true }).success,
    false,
  );
  assert.equal(
    preconDecisionSchema.safeParse({
      ...decision,
      owner_user_id: randomUUID(),
      blocks_start: true,
    }).success,
    true,
  );
  for (const status of ["resolved", "waived"]) {
    assert.equal(
      preconDecisionSchema.safeParse({ ...decision, status }).success,
      false,
    );
    assert.equal(
      preconDecisionSchema.safeParse({
        ...decision,
        status,
        resolution: "Owner accepted the documented exception",
      }).success,
      true,
    );
  }
});

test("legacy brief preferences remain readable and direct agreement needs no justification", () => {
  const { pricing_path, direct_agreement_reason, ...legacyBrief } =
    EMPTY_PRECON_BRIEF;
  const parsed = preconBriefSchema.parse(legacyBrief);
  assert.equal(parsed.pricing_path, "budget_review");
  assert.equal(parsed.direct_agreement_reason, "");
  for (const reason of [undefined, "", "   ", "ab"]) {
    const result = preconBriefSchema.safeParse({
      ...legacyBrief,
      pricing_path: "direct_agreement",
      direct_agreement_reason: reason,
    });
    assert.equal(result.success, true);
  }
  assert.equal(
    preconBriefSchema.safeParse({
      ...legacyBrief,
      pricing_path: "skip_everything",
      direct_agreement_reason: "Client agreed",
    }).success,
    false,
  );
  assert.equal(
    preconBriefSchema.parse({
      ...legacyBrief,
      pricing_path: "direct_agreement",
      direct_agreement_reason: "  Client has approved the scope and budget  ",
    }).direct_agreement_reason,
    "Client has approved the scope and budget",
  );
});


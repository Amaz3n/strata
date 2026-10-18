require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { pricingBasisChanges } = require("../lib/precon/pricing-basis");
const {
  preconBriefSchema,
  EMPTY_PRECON_BRIEF,
} = require("../lib/precon/workspace");
const file = { id: "file", name: "Specifications", version_id: "v1" };
const drawing = { id: "a", drawing_set_id: "set", revision_label: "Issue A" };
test("new drawing issuance and changed file versions flag review without altering the saved basis", () => {
  const saved = {
    brief_version: 1,
    governing_documents: [file],
    drawing_revisions: [drawing],
  };
  const original = JSON.stringify(saved);
  const changes = pricingBasisChanges(
    saved,
    {
      files: [{ ...file, version_id: "v2" }],
      drawings: [{ ...drawing, id: "b", revision_label: "Issue B" }],
    },
    2,
  );
  assert.equal(changes.length, 3);
  assert.match(changes.join(" "), /Issue A → Issue B/);
  assert.equal(JSON.stringify(saved), original);
});
test("missing access never fabricates missing files or a current revision check", () => {
  assert.deepEqual(
    pricingBasisChanges(
      { governing_documents: [file], drawing_revisions: [drawing] },
      { files: null, drawings: null },
      1,
    ),
    [],
  );
  assert.equal(
    pricingBasisChanges(
      { governing_documents: [file], drawing_revisions: [drawing] },
      { files: [], drawings: [] },
      1,
    ).length,
    2,
  );
});
test("adding the first plans after a recorded empty drawing basis requires review; legacy basis remains unknown", () => {
  const current = { files: [], drawings: [drawing] };
  assert.equal(
    pricingBasisChanges({ drawing_revisions: [] }, current, 1).length,
    1,
  );
  assert.deepEqual(pricingBasisChanges({}, current, 1), []);
});
test("milestone dates round trip and earlier saved briefs remain compatible", () => {
  const older = { ...EMPTY_PRECON_BRIEF };
  delete older.estimate_due;
  delete older.client_decision_due;
  delete older.permit_target;
  assert.equal(preconBriefSchema.parse(older).estimate_due, null);
  const saved = preconBriefSchema.parse({
    ...older,
    estimate_due: "2026-10-12",
    permit_target: "2026-11-01",
  });
  assert.equal(saved.estimate_due, "2026-10-12");
  assert.equal(saved.permit_target, "2026-11-01");
  assert.equal(
    preconBriefSchema.safeParse({ ...older, permit_target: "invalid" }).success,
    false,
  );
});

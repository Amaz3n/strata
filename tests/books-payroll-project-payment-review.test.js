require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const { id } = require("./helpers/books-payroll-register-fixture");
let calls = [],
  denied = false,
  api;
const original = Module._load;
try {
  Module._load = function (name, ...args) {
    if (name === "./payroll-draft-workspace")
      return {
        getProjectPayrollDraftDetail: async (input) => {
          calls.push(["draft-scope", input]);
          if (denied) throw Error("Denied project scope");
        },
        requireProjectPayrollImportScope: async (projectId, importId) => {
          calls.push(["immutable-scope", projectId, importId]);
          if (denied) throw Error("Denied project scope");
        },
      };
    if (name === "./payroll-payment-reviews")
      return {
        previewPayrollPaymentReview: async (input) => {
          calls.push(["preview", input]);
          return { evidenceDigest: "b".repeat(64) };
        },
        preparePayrollPaymentReview: async (input) => {
          calls.push(["prepare", input]);
          return input.request.id;
        },
      };
    return original.call(this, name, ...args);
  };
  api = require("../lib/services/books/payroll-project-payment-review");
} finally {
  Module._load = original;
}
const request = () => ({
  id: id(72),
  payroll_import_id: id(6),
  decisions: [
    {
      journal_id: id(61),
      disposition: "unrelated",
      explanation: "Unrelated retained payroll source movement",
      document_version_id: id(71),
      claims: [],
    },
  ],
});
test("project attribution preview gates source scope first and never accepts caller evidence", async () => {
  calls = [];
  denied = true;
  await assert.rejects(
    api.previewProjectPayrollPaymentReview({
      projectId: id(4),
      request: request(),
    }),
    /Denied/,
  );
  assert.equal(calls.length, 1);
  denied = false;
  calls = [];
  await api.previewProjectPayrollPaymentReview({
    projectId: id(4),
    request: request(),
  });
  assert.equal(calls[0][0], "draft-scope");
  assert.deepEqual(calls[0][1], { projectId: id(4), importId: id(6) });
  assert.equal(calls[1][0], "preview");
  await assert.rejects(
    api.previewProjectPayrollPaymentReview({
      projectId: id(4),
      request: request(),
      evidence: {},
    }),
  );
});
test("project preparation requires the verified preview pin and preserves immutable relationship scope for committed-request recovery", async () => {
  const input = {
    projectId: id(4),
    request: request(),
    notes: "Verified retained statement and original journal lines",
    idempotencyKey: "project-payment-intent-key",
    expectedEvidenceDigest: "b".repeat(64),
  };
  calls = [];
  assert.equal(await api.prepareProjectPayrollPaymentReview(input), id(72));
  assert.deepEqual(calls[0], ["immutable-scope", id(4), id(6)]);
  assert.equal(
    calls[1][1].expectedEvidenceDigest,
    input.expectedEvidenceDigest,
  );
  delete input.expectedEvidenceDigest;
  calls = [];
  await assert.rejects(api.prepareProjectPayrollPaymentReview(input));
  assert.deepEqual(calls, []);
});

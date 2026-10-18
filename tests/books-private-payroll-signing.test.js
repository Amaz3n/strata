require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const { id, org } = require("./helpers/books-payroll-register-fixture");
const original = Module._load;
let storage;
try {
  Module._load = function (name, ...args) {
    if (name === "@/lib/services/context")
      return {
        requireOrgContext: async () => ({
          orgId: org,
          userId: id(50),
          supabase: {},
        }),
      };
    if (name === "@/lib/services/books/access")
      return { requireBooksAuthorization: async () => {} };
    if (name === "@/lib/services/books/module")
      return { requireBooksWorkspaceEnabled: async () => {} };
    return original.call(this, name, ...args);
  };
  storage = require("../lib/storage/payroll-private-storage");
} finally {
  Module._load = original;
}
test("real AWS SDK presigning binds size/type/create-only intent and actor metadata without an empty-body CRC32 checksum", async (t) => {
  const keys = [
    "R2_PAYROLL_BUCKET",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  Object.assign(process.env, {
    R2_PAYROLL_BUCKET: "private-payroll-test",
    R2_BUCKET: "project-files",
    R2_ENDPOINT: "https://synthetic.r2.example",
    R2_ACCESS_KEY_ID: "synthetic",
    R2_SECRET_ACCESS_KEY: "synthetic",
  });
  const path = org + "/books/payroll-private/" + id(8700) + "/source.csv",
    checksum = "f".repeat(64);
  const signed = await storage.createPrivatePayrollUploadUrl({
      orgId: org,
      path,
      size: 12345,
      checksum,
    }),
    url = new URL(signed.uploadUrl);
  assert.equal(
    url.searchParams.get("X-Amz-SignedHeaders"),
    "content-length;content-type;host;if-none-match",
  );
  assert.equal(url.searchParams.get("x-amz-meta-arc_actor_id"), id(50));
  assert.equal(url.searchParams.get("x-amz-meta-arc_org_id"), org);
  assert.equal(url.searchParams.get("x-amz-meta-arc_sha256"), checksum);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.ok(![...url.searchParams.keys()].some((k) => /checksum/i.test(k)));
  assert.deepEqual(signed.headers, {
    "Content-Type": "text/csv",
    "If-None-Match": "*",
    "Cache-Control": "private, no-store",
  });
  assert.ok(
    url.hostname.startsWith("private-payroll-test.") ||
      url.pathname.startsWith("/private-payroll-test/"),
  );
  assert.ok(decodeURI(url.pathname).endsWith("/books-payroll/" + path));
});

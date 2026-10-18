require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const id = "00000000-0000-4000-8000-000000000001"
function service({ allowed = false, missing = null, project = null } = {}) {
  const writes = [], reads = []
  const db = { from(table) {
    const filters = []
    let operation = null
    const rows = { bid_invites: { id, bid_package_id: id }, bid_packages: { id, community_id: project ? null : id, project_id: project }, communities: { id, division_id: allowed ? "assigned" : "other" }, bid_submissions: { id, bid_invite_id: id }, bid_submission_items: { id, bid_submission_id: id }, rfis: { id, bid_package_id: id } }
    const result = () => { reads.push({ table, filters }); if (operation) writes.push({ table, operation }); return { data: table === missing ? null : rows[table] ?? [], error: null } }
    const query = { select() { return query }, eq(k,v) { filters.push([k,v]); return query }, is() { return query }, not() { return query }, update() { operation = "update"; return query }, insert() { operation = "insert"; return query },
      async maybeSingle() { return result() }, async single() { return result() }, then(resolve,reject) { return Promise.resolve(result()).then(resolve,reject) } }
    return query
  } }
  const auth = { getDivisionAccessForUser: async () => ({ assignedOnly: true, divisionIds: ["assigned"] }), getDivisionScopedProjectIds: async () => ["allowed-project"] }
  const compile = (path, requireDependency) => {
    const compiled = { exports: {} }
    const code = ts.transpileModule(fs.readFileSync(require.resolve(path), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(code, { exports: compiled.exports, module: compiled, require: requireDependency })
    return compiled.exports
  }
  const productionAccess = compile("../lib/services/production-bid-access.ts", () => auth)
  const api = compile("../lib/services/bids.ts", (name) => {
    if (name === "crypto") return require("node:crypto")
    if (name === "@/lib/services/production-bid-access") return productionAccess
    if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: db, orgId: "org", userId: "actor" }) }
    if (name === "@/lib/services/authorization") return auth
    if (name === "@/lib/services/permissions") return { requirePermission: async () => {}, requireAnyPermission: async () => {} }
    if (name === "@/lib/services/audit") return { recordAudit: async () => {} }
    if (name === "@/lib/services/events") return { recordEvent: async () => {} }
    if (name === "@/lib/services/portal-credentials") return { hashBidToken: () => "hash" }
    if (name === "@/lib/services/rfis") return { listRfiResponses: async () => ["response"] }
    if (name === "@/lib/validation/bids") return require("../lib/validation/bids")
    return {}
  })
  return { api, writes, reads }
}
const operations = {
  pause: (api) => api.pauseBidInviteAccess(id),
  resume: (api) => api.resumeBidInviteAccess(id),
  revoke: (api) => api.revokeBidInviteAccess(id),
  account: (api) => api.setBidInviteRequireAccount({ inviteId: id, requireAccount: true }),
  link: (api) => api.generateBidInviteLink(id),
  resend: (api) => api.resendBidInvite({ inviteId: id }),
  bulk: (api) => api.bulkCreateBidInvites({ input: { bid_package_id: id, invites: [{ company_id: id }] } }),
  leveling: (api) => api.updateBidSubmissionLeveling({ input: { bid_submission_id: id } }),
  cell: (api) => api.updateBidSubmissionItemLeveling({ input: { bid_submission_item_id: id } }),
  responses: (api) => api.listBidPackageRfiResponses({ rfiId: id }),
}
for (const [name, operation] of Object.entries(operations)) test(`${name} rejects another division before writes or secondary reads`, async () => {
  const instance = service()
  await assert.rejects(operation(instance.api), /outside your division access/)
  assert.equal(instance.writes.length, 0)
  for (const read of instance.reads) assert.ok(read.filters.some(([key,value]) => key === "org_id" && value === "org"))
})
test("assigned community packages remain usable by division-scoped users without a project", async () => {
  const instance = service({ allowed: true })
  await instance.api.pauseBidInviteAccess(id)
  assert.equal(instance.writes.length, 1)
  assert.equal(instance.writes[0].table, "bid_access_tokens")
  assert.deepEqual(await instance.api.listBidPackageRfiResponses({ rfiId: id }), ["response"])
})
test("project packages still require project visibility and missing ancestry fails closed", async () => {
  await assert.rejects(service({ allowed: true, project: "outside-project" }).api.pauseBidInviteAccess(id), /outside your project access/)
  for (const missing of ["bid_submission_items", "bid_submissions", "bid_invites", "bid_packages"]) {
    const instance = service({ allowed: true, missing })
    await assert.rejects(operations.cell(instance.api), /not found/i)
    assert.equal(instance.writes.length, 0)
  }
})

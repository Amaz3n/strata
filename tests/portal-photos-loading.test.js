const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function fixture({ photos = true, denied = false, dataFailure = false } = {}) {
  const reads = [], access = { org_id: "org", project_id: "project", company_id: "company", contact_id: "contact", scoped_rfi_id: "rfi", permissions: { can_view_photos: photos } }, data = { photos: ["fixture"] }, failure = Error("Data unavailable"), exports = {}
  const source = ts.transpileModule(fs.readFileSync("app/p/[token]/load-portal.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const modules = {
    "next/navigation": { notFound: () => { throw Error("Not found") }, unstable_rethrow: require("next/navigation").unstable_rethrow },
    "@/lib/services/portal-access": {
      assertPortalActionAccess: async (token, options) => { reads.push(["access", token, options]); if (denied) throw Error("Denied"); return access },
      loadClientPortalData: async scope => { reads.push(["data", scope]); if (dataFailure) throw failure; return data },
    },
  }
  new Function("exports", "require", source)(exports, name => modules[name] ?? {})
  return { reads, access, data, failure, exports }
}
test("photo-disabled and invalid links never load the portal payload", async () => {
  for (const options of [{ photos: false }, { denied: true }]) {
    const f = fixture(options)
    await assert.rejects(f.exports.loadClientPortalPhotosPage("token"), /Not found/)
    assert.deepEqual(f.reads, [["access", "token", { portalType: "client", requireProject: true }]])
  }
})
test("enabled and unspecified photo permission preserve the authorized payload scope", async () => {
  for (const photos of [true, null]) {
    const f = fixture({ photos })
    if (photos === null) delete f.access.permissions.can_view_photos
    const result = await f.exports.loadClientPortalPhotosPage("token")
    assert.equal(result.access, f.access)
    assert.equal(result.data, f.data)
    assert.deepEqual(f.reads[1], ["data", { orgId: "org", projectId: "project", permissions: f.access.permissions, companyId: "company", contactId: "contact", scopedRfiId: "rfi", portalToken: "token" }])
  }
})
test("portal data errors propagate instead of becoming an authorization 404", async () => {
  const f = fixture({ dataFailure: true })
  await assert.rejects(f.exports.loadClientPortalPhotosPage("token"), error => error === f.failure)
  assert.equal(f.reads.length, 2)
})
test("shared Overview and Roadmap loader preserves its existing photo-disabled payload behavior", async () => {
  const f = fixture({ photos: false }), result = await f.exports.loadClientPortalPage("token")
  assert.equal(result.data, f.data)
  assert.equal(f.reads.length, 2)
})

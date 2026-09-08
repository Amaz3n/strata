require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const { payableFileDuplicateWarning } = require("../lib/services/payable-file-duplicates")
const { payableIntakeError } = require("../lib/payables/intake")

function fileResolver() {
  const source = fs.readFileSync("lib/services/files.ts", "utf8")
  const tree = ts.createSourceFile("files.ts", source, ts.ScriptTarget.Latest, true)
  const names = new Set(["splitFileName", "folderScopeLabel", "assertNoDuplicateFile", "resolveUniqueFileName", "resolveUploadFileName"])
  const code = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(tree)).join("\n")
  const testModule = { exports: {} }
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module: testModule, exports: testModule.exports, MAX_NAME_COLLISION_CANDIDATES: 500 })
  return testModule.exports.resolveUploadFileName
}
function db(rows) {
  return { from() { const query = { select() { return query }, eq() { return query }, neq() { return query }, is() { return query }, ilike() { return query }, limit() { return query },
    maybeSingle: async () => ({ data: rows[0], error: null }), then: resolve => Promise.resolve({ data: rows, error: null }).then(resolve) }; return query } }
}
test("invoice intake accepts identical content and chooses a free filename", async () => {
  const resolve = fileResolver()
  const input = { supabase: db([{ id: "old-file", file_name: "invoice.pdf" }, { file_name: "invoice (2).pdf" }]), orgId: "org", fileName: "invoice.pdf", checksum: "same" }
  assert.equal(await resolve({ ...input, allowDuplicateContent: true }), "invoice (3).pdf")
  await assert.rejects(resolve(input), /Duplicate upload blocked/)
})
test("a leftover document without a bill produces no duplicate warning", async () => {
  assert.equal(await payableFileDuplicateWarning(db([]), "org", "hash"), null)
})
test("another bill with the same PDF is advisory", async () => {
  assert.match(await payableFileDuplicateWarning(db([{ id: "other-bill" }]), "org", "hash"), /May be a duplicate/)
})
test("error details survive while credentials are redacted", () => {
  assert.equal(payableIntakeError(new Error("The PDF is password protected")), "The PDF is password protected")
  assert.equal(payableIntakeError({ message: "Storage unavailable" }), "Storage unavailable")
  assert.doesNotMatch(payableIntakeError(new Error("Invalid Bearer secret-token key=sk-secret123")), /secret-token|sk-secret123/)
})

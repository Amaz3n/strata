const assert = require("node:assert/strict")
const test = require("node:test")
const { stubModule, freshRequire } = require("./support/modules")

stubModule("server-only", {})
const { SCHEMA_FLAGS, missingSchemaForFlag, schemaFlagIsOn, schemaFlagRefusal } = freshRequire("lib/schema-flags.ts")

const FLAG = "ARC_TRADE_DATABASE_WORKSPACE_ENABLED"
const versionsOf = (flag) => SCHEMA_FLAGS[flag].requires.map((stem) => stem.slice(0, 14))

test("every schema flag is an ARC_ flag naming real migration stems", () => {
  for (const [flag, entry] of Object.entries(SCHEMA_FLAGS)) {
    assert.match(flag, /^ARC_[A-Z0-9_]+$/)
    assert.ok(entry.requires.length > 0, `${flag} names no migration`)
    for (const stem of entry.requires) assert.match(stem, /^\d{14}_[a-z0-9_]+$/)
  }
})

test("only the exact string true turns a flag on", () => {
  assert.equal(schemaFlagIsOn(FLAG, { [FLAG]: "true" }), true)
  for (const value of [undefined, "", "1", "TRUE", "yes", "false"]) assert.equal(schemaFlagIsOn(FLAG, { [FLAG]: value }), false)
})

test("missing schema is reported by migration, and a complete ledger reports none", () => {
  const [first, ...rest] = SCHEMA_FLAGS[FLAG].requires
  assert.deepEqual(missingSchemaForFlag(FLAG, new Set(versionsOf(FLAG))), [])
  assert.deepEqual(missingSchemaForFlag(FLAG, new Set(versionsOf(FLAG).slice(1))), [first])
  assert.deepEqual(missingSchemaForFlag(FLAG, new Set()), [first, ...rest])
  assert.match(schemaFlagRefusal(FLAG, [first]), new RegExp(`^${FLAG} is on, but this database is missing the migration it needs: ${first}\\.`))
})

function loadService(reply) {
  const calls = []
  stubModule("server-only", {})
  stubModule("lib/supabase/server.ts", {
    createServiceSupabaseClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return reply(args) } }),
  })
  return { calls, service: freshRequire("lib/services/schema-flags.ts") }
}

test("a flag that is off never touches the database", async () => {
  delete process.env[FLAG]
  const { calls, service } = loadService(() => ({ data: [], error: null }))
  assert.equal(await service.schemaFlagEnabled(FLAG), false)
  assert.deepEqual(calls, [])
})

test("a flag turned on ahead of its migrations fails loudly, naming them, every time it is read", async () => {
  process.env[FLAG] = "true"
  try {
    const { calls, service } = loadService(() => ({ data: versionsOf(FLAG).slice(0, 1), error: null }))
    const missing = SCHEMA_FLAGS[FLAG].requires.slice(1)
    await assert.rejects(service.schemaFlagEnabled(FLAG), new RegExp(`missing the migration it needs: ${missing[0]}`))
    await assert.rejects(service.schemaFlagEnabled(FLAG), /missing/)
    assert.deepEqual(calls.map((call) => call.name), ["applied_migration_versions", "applied_migration_versions"])
    assert.deepEqual(calls[0].args, { p_versions: versionsOf(FLAG) })
  } finally { delete process.env[FLAG] }
})

test("an unreadable ledger fails closed", async () => {
  process.env[FLAG] = "true"
  try {
    const { service } = loadService(() => ({ data: null, error: { message: "function public.applied_migration_versions(text[]) does not exist" } }))
    await assert.rejects(service.schemaFlagEnabled(FLAG), /could not be read to confirm its schema .* Apply 20261021201000_applied_migration_versions or turn the flag off/)
  } finally { delete process.env[FLAG] }
})

test("a flag whose schema is present is on, and the ledger is read once per process", async () => {
  process.env[FLAG] = "true"
  try {
    const { calls, service } = loadService(() => ({ data: versionsOf(FLAG), error: null }))
    assert.equal(await service.schemaFlagEnabled(FLAG), true)
    assert.equal(await service.schemaFlagEnabled(FLAG), true)
    assert.equal(calls.length, 1)
  } finally { delete process.env[FLAG] }
})

require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const original = Module._load
let authorized = false,
  deny = false,
  reads = [],
  rows = {}
const org = "org",
  pid = "11111111-1111-4111-8111-111111111111"
const client = {
  from(table) {
    assert.ok(authorized, "authorization precedes register reads")
    const filters = [],
      record = { table, filters }
    reads.push(record)
    let bounds = null
    const q = {
      select() {
        return q
      },
      eq(k, v) {
        filters.push([k, v])
        return q
      },
      gt() {
        return q
      },
      not() {
        return q
      },
      in(k, v) {
        filters.push([k, v])
        return q
      },
      order() {
        return q
      },
      range(a, b) {
        bounds = [a, b]
        return q
      },
      single() {
        return Promise.resolve({
          data: { name: "Project", require_subtier_waivers: true },
          error: null,
        })
      },
      then(resolve, reject) {
        let data = rows[table] ?? []
        for (const [k, v] of filters)
          if (k !== "org_id")
            data = data.filter((r) =>
              r[k] === undefined || Array.isArray(v)
                ? r[k] === undefined || v.includes(r[k])
                : r[k] === v,
            )
        if (bounds) data = data.slice(bounds[0], bounds[1] + 1)
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      },
    }
    return q
  },
}
Module._load = function (request, parent, isMain) {
  if (request === "@/lib/services/context")
    return {
      requireOrgContext: async () => ({
        supabase: client,
        orgId: org,
        userId: "user",
      }),
    }
  if (request === "@/lib/services/authorization")
    return {
      requireAuthorization: async (input) => {
        assert.equal(input.projectId, pid)
        if (deny) throw new Error("denied")
        authorized = true
      },
    }
  if (request === "@/lib/services/compliance")
    return {
      getComplianceRulesWithClient: async () => ({ require_lien_waiver: true }),
    }
  if (request === "@/lib/services/files")
    return { buildInternalFileUrl: (id) => `/files/${id}` }
  return original.call(this, request, parent, isMain)
}
const { getProjectWaiverRegister } = require("../lib/services/waiver-register")
Module._load = original
function reset(count = 1) {
  authorized = false
  deny = false
  reads = []
  rows = {
    vendor_bills: Array.from({ length: count }, (_, i) => ({
      id: String(i).padStart(4, "0"),
      project_id: pid,
      company_id: "vendor",
      commitment_id: "commit",
      total_cents: 10000,
      paid_cents: 0,
      retainage_cents: 1000,
      status: "approved",
      metadata: { billing_period_end: "2026-08-31" },
    })),
    companies: [{ id: "vendor", name: "Trade" }],
    lien_waivers: [],
    subtier_waiver_requirements: [],
    commitments: [],
  }
}
test("denied project does not read financial records", async () => {
  reset()
  deny = true
  await assert.rejects(getProjectWaiverRegister(pid), /denied/)
  assert.equal(reads.length, 0)
})
test("every financial read is scoped to the active organization", async () => {
  reset()
  await getProjectWaiverRegister(pid)
  for (const read of reads)
    assert.ok(
      read.filters.some(([k, v]) => k === "org_id" && v === org),
      read.table,
    )
})
test("pagination totals include all database pages, without silently truncating", async () => {
  reset(601)
  const result = await getProjectWaiverRegister(pid, "", undefined, {
    page: 7,
    status: "outstanding",
  })
  assert.equal(result.total, 601)
  assert.equal(result.entries.length, 1)
  assert.equal(result.pages, 7)
  assert.equal(result.totals.heldCents, 601 * 9000)
})
test("full export includes every filtered payable", async () => {
  reset(501)
  const result = await getProjectWaiverRegister(pid, "", undefined, {
    exportAll: true,
  })
  assert.equal(result.entries.length, 501)
})
test("claimants without matching bills remain visible", async () => {
  reset()
  rows.subtier_waiver_requirements = [
    {
      id: "req",
      project_id: pid,
      commitment_id: "future",
      period_end: "2026-09-30",
      claimant_company_name: "Supply",
      waiver_type: "conditional_progress",
      amount_cents: 5000,
      is_active: true,
    },
  ]
  const result = await getProjectWaiverRegister(pid)
  assert.equal(result.unbilledTotal, 1)
  assert.equal(result.unbilledClaimants[0].received, false)
})
test("vendor identity falls back to the linked commitment", async () => {
  reset()
  rows.vendor_bills[0].company_id = null
  rows.commitments = [{ id: "commit", company_id: "vendor", project_id: pid }]
  const result = await getProjectWaiverRegister(pid)
  assert.equal(result.entries[0].companyName, "Trade")
})
test("default has no date restriction and explicit period uses work coverage", async () => {
  reset()
  rows.vendor_bills[0].due_date = "2026-09-30"
  assert.equal((await getProjectWaiverRegister(pid, "2026-09-30")).total, 0)
  assert.equal((await getProjectWaiverRegister(pid, "2026-08-31")).total, 1)
})

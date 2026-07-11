const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const sql = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260711190500_budget_transfer_lifecycle.sql"), "utf8")

for (const functionName of ["close_budget_transfer", "post_budget_transfer"]) {
  test(`${functionName} binds actor identity and checks budget approval permission`, () => {
    const start = sql.indexOf(`function public.${functionName}`)
    assert.notEqual(start, -1)
    const body = sql.slice(start, sql.indexOf("$$;", start) + 3)
    assert.match(body, /p_actor_id is distinct from \(select auth\.uid\(\)\)/)
    assert.match(body, /has_org_permission\(v_transfer\.org_id, 'budget\.approve'\)/)
    assert.match(body, /auth\.jwt\(\)->>'role'.*service_role/)
  })

  test(`${functionName} is not executable by PUBLIC or anon`, () => {
    assert.match(sql, new RegExp(`revoke all on function public\\.${functionName}\\([^;]+\\) from public, anon;`))
  })
}

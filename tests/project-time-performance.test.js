const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const page = fs.readFileSync(path.join(root, "app/(app)/projects/[id]/time/page.tsx"), "utf8")

test("project time starts independent page reads together", () => {
  const dataLoader = page.slice(page.indexOf("async function ProjectTimeData"))
  const parallelStart = dataLoader.indexOf("await Promise.all")

  assert.notEqual(parallelStart, -1)
  assert.ok(parallelStart < dataLoader.indexOf("if (!project) notFound()"))
  assert.match(dataLoader, /getProjectAction\(id\)[\s\S]*listCostCodes\(\)[\s\S]*listProjectTimeEntries\(id\)/)
})

test("project time only loads the org roster for crew managers", () => {
  assert.match(page, /canManageCrewPromise\.then\(\(canManageCrew\) =>/)
  assert.match(page, /canManageCrew\s*\? listTeamMembers/)
  assert.match(page, /: \[\]/)
})

test("certified payroll uses in-app navigation", () => {
  assert.match(page, /<Link href=\{`\/projects\/\$\{project\.id\}\/time\/certified-payroll`\}>/)
  assert.doesNotMatch(page, /<a href=\{`\/projects\/\$\{project\.id\}\/time\/certified-payroll`\}>/)
})

// SCALE-01 — a first builder at full size (EP13-01, EP13-02). Long-running: seeding takes
// a few minutes and the load runs for the minutes its expected file names, so the
// all-scenarios run leaves it out unless asked (LONG_RUNNING in catalog.cjs).
//
//   first-builder-dataset  production-scale-seed.cjs builds the first-builder profile in an isolated org;
//                          the census matches what the profile places, within the seed-time budget
//   desk-render-at-scale   each role's desk and a home, opened by one member with nobody else on the app,
//                          against the 2 s p95 desk target (blocked: needs a production build)
//   mixed-role-load        50 sessions on their desks for the run's minutes, writing through the services
//                          their pages call; invariants and write latency (service-call time, in-process)
//   desk-p95-under-load    the page side of the same run against the frozen desk target (blocked: the
//                          acceptance app is `next dev`, one development process)
//
// Page targets are NOT PROVEN by this scenario on the acceptance stack: both page subcases
// are BLOCKED until they run against a production build (`--include-pending` measures them
// anyway, and on `next dev` they fail).
//
// The subcases share one seeded builder, so they run in order and a later one refuses to
// run without the dataset. Expected values are in expected/SCALE-01.json.
const { seedAtProfile } = require("../production-scale-seed.cjs")
const { runLoad, deskSweep, loadInvariants } = require("../production-load.cjs")

const APP_URL = process.env.ARC_ACCEPTANCE_APP_URL ?? "http://localhost:3210"
const state = {}
const need = (key) => {
  if (!state[key]) throw Error(`Needs the ${key} from the earlier subcase of this run`)
  return state[key]
}

async function firstBuilderDataset(kit, expected, check) {
  const { profile, seedBudgetSeconds } = expected.inputs
  const password = require("node:crypto").randomBytes(18).toString("base64url")
  const seeded = await seedAtProfile(kit, profile, { name: "Production builder (first-builder scale)", password })
  state.seeded = { ...seeded, password }
  const { census } = seeded
  const byStatus = (rows) => Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]))
  check.equal("the divisions, communities, members and homes the profile names", expected.expected.shape,
    { divisions: census.divisions, communities: census.communities, members: census.members, homes: census.homes, closedHomes: census.closedHomes, warrantyCoverage: census.warrantyCoverage })
  check.equal("active homes by stage and installed homes by warranty history", expected.expected.placement, { active: seeded.profile.activeByStage, installed: seeded.profile.installedByHistory })
  check.equal("lots by status", expected.expected.lots, byStatus(census.lots))
  check.equal("the starts queue, reservations and warranty requests", expected.expected.queues,
    { startPackages: byStatus(census.startPackages), reservations: byStatus(census.reservations), warrantyRequests: byStatus(census.warrantyRequests), prospects: census.prospects })
  check.equal("agreements and purchase orders, with their money", expected.expected.money,
    { agreements: { n: Number(census.agreements.n), cents: String(census.agreements.cents) }, purchaseOrders: Object.fromEntries(census.purchaseOrders.map((row) => [row.status, { n: Number(row.n), cents: String(row.cents) }])) })
  check.equal("every sold home holds its deposits", true, Number(census.deposits.n) >= Number(census.agreements.n))
  check.equal(`the dataset is built within ${seedBudgetSeconds} seconds`, true, seeded.seconds.total <= seedBudgetSeconds)
  return { orgId: seeded.org.orgId, seconds: seeded.seconds, census, parameters: { profile, prngSeed: seeded.profile.prngSeed } }
}

async function deskRenderAtScale(kit, expected, check) {
  const { rounds, deskP95Ms } = expected.inputs
  const sweep = await deskSweep(kit, need("seeded"), { appUrl: APP_URL, rounds })
  for (const [surface, figures] of Object.entries(sweep.surfaces))
    check.equal(`${surface}: renders every time, p95 within ${deskP95Ms} ms on its own`, { errors: 0, withinTarget: true }, { errors: figures.errors, withinTarget: figures.p95 <= deskP95Ms })
  return sweep
}

async function mixedRoleLoad(kit, expected, check) {
  const { sessions, minutes, thinkSeconds, mutationP95Ms } = expected.inputs
  const result = await runLoad(kit, need("seeded"), { appUrl: APP_URL, sessions, durationMs: minutes * 60000, thinkMs: thinkSeconds.map((s) => s * 1000), prngSeed: need("seeded").profile.prngSeed })
  state.load = result
  const invariants = loadInvariants(result)
  check.equal("what must not move did not, and what the workload added is exactly what it wrote", Object.fromEntries(Object.keys(invariants).map((key) => [key, true])), invariants)
  const writes = Object.entries(result.surfaces).filter(([surface]) => surface.startsWith("write "))
  check.equal("every role made its write during the run", expected.expected.writeSurfaces, writes.map(([surface]) => surface).sort())
  for (const [surface, figures] of writes)
    check.equal(`${surface}: no errors, service-call p95 within ${mutationP95Ms} ms`, { errors: 0, withinTarget: true }, { errors: figures.errors, withinTarget: figures.p95 <= mutationP95Ms })
  const { before, after, ...report } = result
  return report
}

async function deskP95UnderLoad(kit, expected, check) {
  const { deskP95Ms } = expected.inputs
  const pages = Object.entries(need("load").surfaces).filter(([surface]) => surface.startsWith("page "))
  for (const [surface, figures] of pages)
    check.equal(`${surface}: no errors, p95 within ${deskP95Ms} ms at ${need("load").parameters.sessions} sessions`, { errors: 0, withinTarget: true }, { errors: figures.errors, withinTarget: figures.p95 <= deskP95Ms })
  return Object.fromEntries(pages)
}

module.exports = {
  id: "SCALE-01",
  subcases: {
    "first-builder-dataset": firstBuilderDataset,
    "desk-render-at-scale": deskRenderAtScale,
    "mixed-role-load": mixedRoleLoad,
    "desk-p95-under-load": deskP95UnderLoad,
  },
}

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const fileOption = process.argv.indexOf("--checklist")
const path = fileOption === -1
  ? resolve(root, "docs/enterprise-production/completion-checklist.json")
  : resolve(process.argv[fileOption + 1] ?? "")
const checklist = JSON.parse(readFileSync(path, "utf8"))
const states = ["not_audited", "pending", "partial", "implemented", "verified", "accepted"]
const implemented = new Set(["implemented", "verified", "accepted"])
const verified = new Set(["verified", "accepted"])
const errors = []
const warnings = []
const hash = (value) => createHash("sha256").update(value).digest("hex")
// Unapplied migrations consolidated before deploy keep their SQL as a section of
// the consolidated file, marked `-- ==== <name> ====`.
const migrationsDir = resolve(root, "supabase/migrations")
const migrationSections = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql"))
  .map((file) => readFileSync(resolve(migrationsDir, file), "utf8")).join("\n")
const consolidatedMigration = (source) => {
  const name = /^supabase\/migrations\/(\d{14}_[a-z0-9_]+)\.sql$/.exec(source)?.[1]
  return Boolean(name) && migrationSections.includes(`\n-- ==== ${name} ====\n`)
}
const scopeKeys = ["id", "workstream", "outcome", "mandatory", "weight", "acceptanceCriteria", "verificationRequired", "dependencies"]
const projection = checklist.items.map((item) => Object.fromEntries(scopeKeys.map((key) => [key, item[key]])))
if (JSON.stringify(projection) !== JSON.stringify(checklist.scopeBaseline)) {
  errors.push("Scope differs from the frozen baseline. Obtain explicit user scope-change approval before changing the denominator.")
}
if (hash(JSON.stringify(checklist.scopeBaseline)) !== checklist.scopeSha256) errors.push("Frozen scope fingerprint is invalid.")
const ids = new Set(checklist.items.map((item) => item.id))
if (ids.size !== checklist.items.length) errors.push("Duplicate checklist IDs.")
const workstreams = new Set(checklist.workstreams.map((stream) => stream.id))
const visited = new Set()
const visiting = new Set()
function visit(id) {
  if (visiting.has(id)) { errors.push(`Dependency cycle at ${id}.`); return }
  if (visited.has(id)) return
  visiting.add(id)
  const item = checklist.items.find((row) => row.id === id)
  for (const dependency of item?.dependencies ?? []) visit(dependency)
  visiting.delete(id)
  visited.add(id)
}
for (const item of checklist.items) {
  if (!states.includes(item.status)) errors.push(`${item.id}: invalid status.`)
  if (!workstreams.has(item.workstream)) errors.push(`${item.id}: unknown workstream.`)
  if (!Number.isInteger(item.weight) || item.weight < 1 || item.weight > 3) errors.push(`${item.id}: invalid frozen weight.`)
  if (!item.acceptanceCriteria.length || !item.verificationRequired.length) errors.push(`${item.id}: missing criteria or verification requirements.`)
  for (const dependency of item.dependencies) if (!ids.has(dependency)) errors.push(`${item.id}: unknown dependency ${dependency}.`)
  for (const source of [...item.sources, ...item.testFiles]) {
    if (!existsSync(resolve(root, source)) && !consolidatedMigration(source)) errors.push(`${item.id}: missing source ${source}.`)
  }
  if (implemented.has(item.status) && !item.sources.length && !item.evidence.some((proof) => proof.kind === "engineering_artifact")) {
    errors.push(`${item.id}: implemented without source or engineering artifact.`)
  }
  if (verified.has(item.status)) {
    for (const tier of item.verificationRequired) {
      if (!item.evidence.some((proof) => proof.tier === tier && proof.result === "passed" && proof.freshness === "current")) {
        errors.push(`${item.id}: ${item.status} without current passing ${tier} evidence.`)
      }
    }
    if (!item.evidence.some((proof) => {
      const covered = new Set(proof.criteriaCovered ?? [])
      return covered.size === item.acceptanceCriteria.length && item.acceptanceCriteria.every((_, index) => covered.has(index))
    })) {
      errors.push(`${item.id}: verified without explicit coverage of every criterion.`)
    }
  }
  if (item.status === "accepted") {
    if (!["deployed", "not_applicable"].includes(item.releaseState)) errors.push(`${item.id}: accepted without deployment or justified non-applicability.`)
    if (!item.acceptance?.owner || !item.acceptance?.date || !item.acceptance?.evidence) errors.push(`${item.id}: missing release-owner acceptance record.`)
    for (const dependency of item.dependencies) {
      if (checklist.items.find((row) => row.id === dependency)?.status !== "accepted") errors.push(`${item.id}: unaccepted dependency ${dependency}.`)
    }
  }
  visit(item.id)
}
for (const stream of checklist.workstreams) {
  const covered = new Set(checklist.items.filter((item) => item.workstream === stream.id).flatMap((item) => item.sourceAcceptanceIndices ?? []))
  for (let index = 0; index < stream.originalAcceptance.length; index++) {
    if (!covered.has(index)) errors.push(`${stream.id}: original acceptance criterion ${index} has no checklist mapping.`)
  }
}
for (const run of checklist.auditRuns) {
  if (run.supersededBy) continue
  for (const [source, digest] of Object.entries(run.sourceHashes ?? {})) {
    const location = resolve(root, source)
    if (!existsSync(location) || !statSync(location).isFile() || hash(readFileSync(location)) !== digest) {
      warnings.push(`${run.id}: source changed since proof: ${relative(root, location)}`)
    }
  }
}
const mandatory = checklist.items.filter((item) => item.mandatory)
const weight = mandatory.reduce((total, item) => total + item.weight, 0)
const pct = (predicate) => Number((100 * mandatory.filter(predicate).reduce((total, item) => total + item.weight, 0) / weight).toFixed(1))
const statusCounts = Object.fromEntries(states.map((state) => [state, mandatory.filter((item) => item.status === state).length]))
const remaining = mandatory.filter((item) => item.status !== "accepted").map((item) => ({ id: item.id, outcome: item.outcome, status: item.status, priority: item.priority, next: item.remainingWork[0], blockers: item.blockers }))
const summary = {
  baseline: checklist.baselineId,
  mandatoryItems: mandatory.length,
  frozenWeight: weight,
  statusCounts,
  percentages: {
    implemented: pct((item) => implemented.has(item.status)),
    verified: pct((item) => verified.has(item.status)),
    releaseReady: pct((item) => item.status === "accepted"),
  },
  automatedCoverageItems: mandatory.filter((item) => item.evidence.some((proof) => proof.kind === "isolated_automated" && proof.result === "passed" && proof.freshness === "current")).length,
  qualificationComplete: statusCounts.not_audited === 0,
  finishLineReached: mandatory.every((item) => item.status === "accepted") && errors.length === 0 && warnings.length === 0 && !checklist.launchBlockingDefects?.length,
  auditRuns: checklist.auditRuns.map(({id,counts,scope,changedDuringRun}) => ({id,counts,scope,changedDuringRun})),
  errors, warnings,
  nextMilestone: checklist.nextMilestones[0],
  remaining,
}
if (process.argv.includes("--markdown")) {
  const escape = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
  const lines = [
    "# Arc Production completion baseline",
    "",
    `Baseline: ${checklist.baselineId}. Audit date: ${checklist.baselineDate}. Generated from completion-checklist.json; update that file and regenerate this report.`,
    "",
    checklist.goalObjective,
    "",
    `**${summary.mandatoryItems} mandatory items, ${weight} fixed complexity units.** Scope, criteria, weights and dependencies are frozen; additions require explicit user approval. Defects that prevent an existing criterion stay within that item. Optional improvements belong in the deferred backlog.`,
    "",
    "| Measure | Current result |",
    "| --- | --- |",
    `| Implemented | ${summary.percentages.implemented}% — a documented lower bound, not an ETA |`,
    `| Fully verified | ${summary.percentages.verified}% |`,
    `| Release ready | ${summary.percentages.releaseReady}% |`,
    `| Code implemented | ${statusCounts.implemented} items |`,
    `| Partially implemented | ${statusCounts.partial} items |`,
    `| Known pending tasks | ${statusCounts.pending} items |`,
    `| Existing capability not yet qualified | ${statusCounts.not_audited} items |`,
    `| Isolated automated evidence | ${summary.automatedCoverageItems} items; this does not imply full workflow verification |`,
    "",
    `Latest result per test file: ${checklist.baselineAudit.latestUniqueAutomatedTests.passed} passed, ${checklist.baselineAudit.latestUniqueAutomatedTests.failed} failed across ${checklist.baselineAudit.latestUniqueAutomatedTests.testFiles} files. Real network requests were blocked. One drawing test failed during concurrent source edits in the first run; stable reassessment passed, and the original failure remains in the audit history.`,
    "",
    "The earlier rough 30% estimate is superseded by this evidence-based reporting. The lower-bound implementation percentage excludes partially implemented and unqualified features. It will increase when existing functionality is demonstrated complete, even without new code. No complete customer workflow, national-scale benchmark, independent-session race or approved rollout is inferred from isolated tests.",
    "",
    "## Execution rules",
    "",
    "1. Finish M1: qualify existing capabilities and classify candidate pages before implementing an unaudited feature. Reuse shared Books, Documents, Signing and mobile work.",
    "2. Name checklist IDs and the next evidence requirement at the start of each turn. Close exact gaps; stop improving a satisfied criterion.",
    "3. Update item status, evidence, remaining steps and blockers at the end of each turn. Run `node scripts/qa/production-readiness.mjs --check` and regenerate this report with `--markdown`.",
    "4. Do not count source review, mocks or representative single-session SQL as full integration, browser, provider, concurrency or performance acceptance.",
    "5. If only external gates remain, report implementation complete awaiting acceptance. Do not invent more engineering work. Complete the goal only when `node scripts/qa/production-readiness.mjs --release` passes.",
    "",
    "## Milestones",
    "",
    ...checklist.nextMilestones.map((milestone) => `- **${milestone.id}: ${milestone.outcome}.** ${milestone.doneWhen}`),
    "",
    "## Concrete audit findings",
    "",
    ...checklist.baselineAudit.concreteFindings.map((finding) => `- ${finding}`),
    "",
    "## Finite checklist",
    "",
    "Every row has full observable criteria, dependencies, source/test links, evidence and remaining work in completion-checklist.json. Implemented means the functional code exists; verified requires every declared proof tier; accepted additionally requires release-state and owner evidence. Pending release tasks do not mean their underlying feature is missing.",
    "",
  ]
  for (const stream of checklist.workstreams) {
    lines.push(`### ${stream.id}: ${stream.name}`, "", "| ID | Outcome | Status | Next concrete step |", "| --- | --- | --- | --- |")
    for (const item of checklist.items.filter((row) => row.workstream === stream.id)) {
      lines.push(`| ${item.id} | ${escape(item.outcome)} | ${item.status} | ${escape(item.remainingWork[0] ?? "Accepted; no required work remains.")} |`)
    }
    lines.push("")
  }
  lines.push("## Scope and acceptance limits", "", `${checklist.surfaceInventory.pages.length} candidate authenticated/portal pages are inventoried. This is an exposure inventory awaiting role/posture/module qualification, not a claim that every candidate page belongs in production.`, "", "Sizing and operating assumptions are frozen engineering targets awaiting launch-owner approval under EP14-11. QA access, chosen-system sandbox credentials, migration/activation approval, independent security review and operational sign-off remain explicit external gates. No customer database, storage or email mutations were performed.", "", checklist.goalMetadataUpdate.limitation, "")
  if (errors.length || warnings.length) lines.push("## Tracking issues", "", ...[...errors, ...warnings].map((issue) => `- ${issue}`), "")
  console.log(lines.join("\n"))
}
else if (process.argv.includes("--json")) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`${summary.baseline}: ${summary.mandatoryItems} mandatory items / ${weight} frozen weight units`)
  console.log(`Implemented ${summary.percentages.implemented}% | Verified ${summary.percentages.verified}% | Release ready ${summary.percentages.releaseReady}%`)
  console.log(JSON.stringify(statusCounts))
  console.log(`${summary.automatedCoverageItems} items have current isolated automated evidence. This is not full workflow verification.`)
  console.log(summary.qualificationComplete ? "Baseline qualification complete." : "Implementation percentage is a lower bound until existing capabilities are qualified.")
  console.log(`Finish line reached: ${summary.finishLineReached}`)
  for (const error of errors) console.error(`ERROR: ${error}`)
  for (const warning of warnings) console.error(`STALE EVIDENCE: ${warning}`)
  if (process.argv.includes("--remaining")) for (const item of remaining) console.log(`${item.id} [${item.status}] ${item.outcome}: ${item.next}`)
}
if (errors.length || (process.argv.includes("--check") && warnings.length) || (process.argv.includes("--release") && !summary.finishLineReached)) process.exitCode = 1

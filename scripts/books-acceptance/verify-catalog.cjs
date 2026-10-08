#!/usr/bin/env node
// Verifies the golden scenario catalog against the plan's scenario list, the
// expected files, the scenario modules, the completion tracker and the saved
// evidence (B00.1/B00.3). Offline: reads files only. Exits nonzero on any finding.
require("../register-ts-node-test")
const fs = require("node:fs"),
  path = require("node:path")
const { GOLDEN_SCENARIOS } = require("./runtime.cjs")
const { IMPLEMENTED, NOT_IMPLEMENTED, OPEN_SUBCASES } = require("./catalog.cjs")

const root = path.join(__dirname, "../..")

function verifyCatalog({ trackerPath = path.join(root, "advisor-plans/013-arc-books-completion-checklist.json"), evidenceRoot = path.join(root, "docs/books-evidence") } = {}) {
  const findings = []
  const catalogued = [...Object.keys(IMPLEMENTED), ...Object.keys(NOT_IMPLEMENTED)]
  for (const id of GOLDEN_SCENARIOS) if (!catalogued.includes(id)) findings.push(`${id} is in the plan but not in the catalog`)
  for (const id of catalogued) if (!GOLDEN_SCENARIOS.includes(id)) findings.push(`${id} is in the catalog but not in the plan`)
  for (const id of Object.keys(IMPLEMENTED)) if (NOT_IMPLEMENTED[id]) findings.push(`${id} is both built and not built`)

  for (const [id, modulePath] of Object.entries(IMPLEMENTED)) {
    const expectedPath = path.join(__dirname, "expected", `${id}.json`)
    if (!fs.existsSync(path.join(__dirname, modulePath))) { findings.push(`${id} module ${modulePath} is missing`); continue }
    if (!fs.existsSync(expectedPath)) { findings.push(`${id} has no reviewed expected file`); continue }
    const subcases = require(path.join(__dirname, modulePath)).subcases
    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")).subcases
    const open = OPEN_SUBCASES[id] ?? {}
    for (const [name, spec] of Object.entries(expected)) {
      const unbuilt = !subcases[name] || spec.status === "NOT_IMPLEMENTED"
      if (unbuilt && !open[name]) findings.push(`${id} ${name} is not implemented and has no owning package`)
      if (!unbuilt && open[name]) findings.push(`${id} ${name} is implemented but still listed as open`)
    }
    for (const name of Object.keys(subcases)) if (!expected[name]) findings.push(`${id} ${name} runs without a reviewed expectation`)
    for (const name of Object.keys(open)) if (!expected[name]) findings.push(`${id} ${name} is listed as open but not expected`)
  }
  for (const file of fs.readdirSync(path.join(__dirname, "expected"))) {
    const id = file.replace(/\.json$/, "")
    if (!IMPLEMENTED[id]) findings.push(`expected/${file} has no built scenario`)
  }
  for (const [id, entry] of Object.entries(NOT_IMPLEMENTED)) {
    if (!["not_built", "blocked", "deferred"].includes(entry.status)) findings.push(`${id} has an unknown disposition`)
    if (!entry.packages?.length || !entry.reason) findings.push(`${id} needs an owning package and a reason`)
  }

  const tracker = JSON.parse(fs.readFileSync(trackerPath, "utf8"))
  const items = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== "object") return
    if (typeof node.id === "string" && node.status && node.title) { items.push(node); return }
    Object.values(node).forEach(walk)
  }
  walk(tracker.items)
  const ids = new Set(items.map((item) => item.id))
  const owners = [...Object.values(NOT_IMPLEMENTED).flatMap((entry) => entry.packages), ...Object.values(OPEN_SUBCASES).flatMap((open) => Object.values(open))]
  for (const owner of owners) if (!ids.has(owner) && ![...ids].some((id) => id.startsWith(`${owner}.`))) findings.push(`package ${owner} is not in the tracker`)
  for (const item of items) {
    for (const id of item.scenario_ids ?? []) if (!GOLDEN_SCENARIOS.includes(id)) findings.push(`${item.id} names unknown scenario ${id}`)
    if (item.status !== "LOCALLY_VERIFIED") continue
    const latest = (item.evidence ?? []).at(-1)
    const artifacts = (latest?.artifact_paths_and_hashes ?? []).map(artifactReference).filter(Boolean)
    if (!latest?.evidence_dir && !artifacts.length) findings.push(`${item.id} is verified without saved evidence`)
    if (latest?.evidence_dir && !fs.existsSync(path.join(root, latest.evidence_dir))) findings.push(`${item.id} evidence ${latest.evidence_dir} is missing`)
    for (const artifact of artifacts) {
      if (artifact.path.startsWith("/")) continue
      // A file later rewritten in place is pinned to the commit that verified it.
      const [file, commit] = artifact.path.split("@")
      const bytes = commit ? gitShow(commit, file) : fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null
      if (!bytes) findings.push(`${item.id} evidence ${artifact.path} is missing`)
      else if (artifact.sha256 && sha256(bytes) !== artifact.sha256) findings.push(`${item.id} evidence ${artifact.path} no longer matches its recorded hash`)
    }
  }

  const secret = /"(password|encrypted_password|secret_ref|access_token|refresh_token|service_role_key)"\s*:\s*"[^"]+"/i
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (entry.name.endsWith(".json") && secret.test(fs.readFileSync(full, "utf8"))) findings.push(`${path.relative(root, full)} contains a credential-like value`)
    }
  }
  if (fs.existsSync(evidenceRoot)) scan(evidenceRoot)
  return { findings, scenarios: { built: Object.keys(IMPLEMENTED).length, notBuilt: Object.keys(NOT_IMPLEMENTED).length }, trackerItems: items.length }
}

// "path sha256:hex" or { path, sha256 }; temporary files outside the repository are not retained.
function artifactReference(entry) {
  if (typeof entry === "string") { const [file, hash] = entry.split(/\s+sha256:/); return file ? { path: file.trim(), sha256: hash?.trim() ?? null } : null }
  return entry && typeof entry.path === "string" ? { path: entry.path, sha256: entry.sha256 ?? null } : null
}
function sha256(bytes) { return require("node:crypto").createHash("sha256").update(bytes).digest("hex") }
function gitShow(commit, file) {
  const result = require("node:child_process").spawnSync("git", ["show", `${commit}:${file}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

module.exports = { verifyCatalog }

if (require.main === module) {
  const result = verifyCatalog()
  for (const finding of result.findings) console.log(`FINDING ${finding}`)
  console.log(`Catalog: ${result.scenarios.built} built, ${result.scenarios.notBuilt} not built; ${result.trackerItems} tracker items; ${result.findings.length} findings`)
  if (result.findings.length) process.exitCode = 1
}

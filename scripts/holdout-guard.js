/**
 * Refuses to run the engine on a registered holdout drawing.
 *
 * A holdout is only honest while nobody has looked at Arc's output on it. Every
 * script that runs detection on a source PDF or reference calls
 * `assertNotHoldout()` first. Scoring a holdout at a gameplan gate is the one
 * exception: pass `--gate`, and the run is appended to that project's
 * `gateRuns` in the registry so the exposure is on record.
 * See docs/takeoff-evaluation.md §1.
 */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const REGISTRY = process.env.ARC_EXPOSURE_REGISTRY ??
  path.join(__dirname, '../tmp/takeoff-corpus/qualification-exposure-registry-v1.json')

function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY)) return null
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
}

/** @param {{sha256: string, label: string, script: string, gate?: boolean, engine?: number}} options */
function assertNotHoldout({ sha256, label, script, gate = false, engine }) {
  const registry = readRegistry()
  if (!registry) {
    console.warn(`Holdout guard: no exposure registry at ${REGISTRY}; cannot check ${label}.`)
    return
  }
  const project = registry.projects.find((p) => p.sourceFiles.some((s) => s.sha256 === sha256))
  if (!project || project.split !== 'holdout') return
  if (!gate) {
    throw new Error(`${label} is registered holdout project ${project.projectId}. Running the engine on it exposes it. ` +
      'Score holdouts only at a gameplan gate with --gate.')
  }
  project.gateRuns = [...(project.gateRuns ?? []), { at: new Date().toISOString(), script, engine }]
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 1))
  console.warn(`Holdout gate run recorded for ${project.projectId} (${label}).`)
}

module.exports = { assertNotHoldout, fileSha256 }

#!/usr/bin/env node
/**
 * Development scoreboard: score the current engine on every traced development
 * reference, compare with the previous run, and append the result to history.
 *
 *   node scripts/dev-scoreboard.mjs [REFERENCE_DIR]
 *
 * REFERENCE_DIR defaults to $ARC_DEV_REFERENCES or ~/Desktop/arc-holdout/traces.
 * Holdout references are skipped, never scored. A sheet that loses more than one
 * found room against the previous run is flagged as a regression (exit code 1).
 * See docs/plans/plan-recognition-engine-gameplan.md, "Rules of the game".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { scoreReferenceFile } from './score-area-reference.mjs'

const HISTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tmp/takeoff-corpus/dev-scoreboard-history.jsonl')
const directory = process.argv[2] ?? process.env.ARC_DEV_REFERENCES ?? path.join(os.homedir(), 'Desktop/arc-holdout/traces')

const files = fs.readdirSync(directory)
  .filter((f) => f.endsWith('.json') && !/\.(scoring|orig)\.json$/.test(f))
  .sort()
const sheets = []
for (const file of files) {
  const reference = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
  if (reference.split === 'holdout') { console.log(`skip ${file}: holdout`); continue }
  if (!reference.truth?.areas?.length) { console.log(`skip ${file}: no traced areas`); continue }
  const report = await scoreReferenceFile(path.join(directory, file))
  sheets.push({ file, complete: report.complete, elapsedMs: report.elapsedMs, ...report.summary })
}
if (!sheets.length) throw Error(`No development references in ${directory}`)

const sum = (key) => sheets.reduce((s, x) => s + x[key], 0)
const total = { rooms: sum('rooms'), found: sum('found'), exact: sum('exact'), within2pct: sum('within2pct'), errorSqft: sum('errorSqft'), truthSqft: sum('truthSqft') }
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')

const history = fs.existsSync(HISTORY) ? fs.readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const previous = history.at(-1)
const regressions = previous
  ? sheets.filter((s) => { const before = previous.sheets.find((p) => p.file === s.file); return before && before.found - s.found > 1 })
  : []

console.log('\nsheet'.padEnd(42) + 'found     exact  ≤2%   SF err   total   time')
for (const s of sheets) {
  const before = previous?.sheets.find((p) => p.file === s.file)
  const delta = before ? ` (${s.found - before.found >= 0 ? '+' : ''}${s.found - before.found})` : ''
  console.log(`${(s.file + (s.complete ? '' : '*')).padEnd(41)} ${`${s.found}/${s.rooms}${delta}`.padEnd(9)} ${String(s.exact).padEnd(6)} ${String(s.within2pct).padEnd(5)} ${pct(s.errorSqft, s.truthSqft).padEnd(8)} ${`${s.totalErrorPct >= 0 ? '+' : ''}${s.totalErrorPct.toFixed(1)}%`.padEnd(7)} ${(s.elapsedMs / 1000).toFixed(1)}s`)
}
console.log(`${'ALL'.padEnd(41)} ${pct(total.found, total.rooms).padEnd(9)} ${pct(total.exact, total.found).padEnd(6)} ${pct(total.within2pct, total.found).padEnd(5)} ${pct(total.errorSqft, total.truthSqft)}`)
console.log('* partial reference: extra proposals are not judged')

const { AREA_ENGINE_VERSION } = createRequire(import.meta.url)('../lib/drawings/area-takeoff')
fs.mkdirSync(path.dirname(HISTORY), { recursive: true })
fs.appendFileSync(HISTORY, JSON.stringify({ at: new Date().toISOString(), engine: AREA_ENGINE_VERSION, total, sheets }) + '\n')
if (regressions.length) {
  console.error(`\nREGRESSION vs ${previous.at} (engine ${previous.engine}): ${regressions.map((r) => r.file).join(', ')} lost more than one found room.`)
  process.exitCode = 1
}

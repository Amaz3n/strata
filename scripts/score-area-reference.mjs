#!/usr/bin/env node
/**
 * Score the current area engine against one traced reference.
 *
 *   node scripts/score-area-reference.mjs REFERENCE.json [--out report.json] [--gate]
 *
 * The reference carries its own source evidence, text and scale (it was made by
 * create-area-review), so the engine sees exactly the input the tracer saw.
 * Polygon overlap is exact (scripts/recognition-metrics.mjs). Open-plan rooms
 * traced as separate areas can be scored as one zone by a sidecar
 * `REFERENCE.scoring.json`: {"groups": [["Living Room", "Kitchen", "Dining"]]}.
 * See docs/takeoff-evaluation.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { polygonIoU, oneToOneMatch } from './recognition-metrics.mjs'

const require = createRequire(import.meta.url)
require('./register-ts-node-test.js')
const { assertNotHoldout } = require('./holdout-guard.js')
const { runAreaEngine } = require('../lib/drawings/area-engine')
const { AREA_ENGINE_VERSION } = require('../lib/drawings/area-takeoff')

const FOUND_IOU = 0.5
const EXACT_IOU = 0.95
const AREA_TOLERANCE = 0.02

/** Truth areas, with sidecar groups merged into one multi-polygon zone each. */
function truthZones(reference, groups, toFeet) {
  const areas = reference.truth.areas.map((a) => ({ label: a.label, polygon: a.points.map(toFeet), holes: (a.holes ?? []).map((h) => h.map(toFeet)) }))
  const grouped = new Set()
  const zones = []
  for (const group of groups) {
    const members = areas.filter((a) => group.includes(a.label) && !grouped.has(a))
    const missing = group.filter((label) => !areas.some((a) => a.label === label))
    if (missing.length) throw Error(`Scoring group names unknown areas: ${missing.join(', ')}`)
    members.forEach((m) => grouped.add(m))
    zones.push({ label: group.join(' + '), parts: members })
  }
  for (const a of areas) if (!grouped.has(a)) zones.push({ label: a.label, parts: [a] })
  return zones
}

/** Exact comparison of a (possibly multi-part) truth zone with one proposal. */
function compare(zone, prediction) {
  let intersection = 0, truthArea = 0, predictionArea = 0
  for (const part of zone.parts) {
    const c = polygonIoU(part, prediction)
    intersection += c.intersectionSqft
    truthArea += c.referenceAreaSqft
    predictionArea = c.predictionAreaSqft
  }
  return { intersection, truthArea, predictionArea, iou: intersection / (truthArea + predictionArea - intersection) }
}

export function scoreAreas(reference, proposals, { groups = [] } = {}) {
  const { imageWidth, imageHeight, feetPerImagePx } = reference.input
  const toFeet = ([x, y]) => [x * imageWidth * feetPerImagePx, y * imageHeight * feetPerImagePx]
  const zones = truthZones(reference, groups, toFeet)
  const predictions = proposals.map((p) => ({ label: p.label, polygon: p.points.map(toFeet), holes: (p.holes ?? []).map((h) => h.map(toFeet)) }))
  const pairs = zones.map((zone) => predictions.map((prediction) => compare(zone, prediction)))
  const candidates = []
  pairs.forEach((row, i) => row.forEach((c, j) => { if (c.iou >= FOUND_IOU) candidates.push({ left: i, right: j, cost: 1 - c.iou }) }))
  const matchOf = new Map(oneToOneMatch(zones.length, predictions.length, candidates).map((m) => [m.left, m.right]))

  const rooms = zones.map((zone, i) => {
    const truthArea = pairs[i][0]?.truthArea ?? zone.parts.reduce((s, p) => s + polygonIoU(p, p).referenceAreaSqft, 0)
    const j = matchOf.get(i)
    const overlapping = pairs[i].map((c, k) => ({ k, share: c.intersection / truthArea })).filter((o) => o.share > 0.2)
    const base = { label: zone.label, truthSqft: truthArea, splitInto: overlapping.length }
    if (j === undefined) {
      const swallowedBy = pairs[i].map((c, k) => ({ k, share: c.intersection / truthArea })).filter((o) => o.share > 0.5).map((o) => predictions[o.k].label)
      return { ...base, status: swallowedBy.length ? 'merged' : 'missed', swallowedBy, errorSqft: truthArea }
    }
    const c = pairs[i][j]
    const areaError = (c.predictionArea - truthArea) / truthArea
    return { ...base, status: 'found', prediction: predictions[j].label, predictionSqft: c.predictionArea, iou: c.iou, areaErrorPct: areaError * 100,
      exact: c.iou >= EXACT_IOU, within2pct: Math.abs(areaError) <= AREA_TOLERANCE, errorSqft: Math.abs(c.predictionArea - truthArea) }
  })
  const matchedPredictions = new Set(matchOf.values())
  const extras = predictions.map((p, j) => ({ label: p.label, sqft: pairs[0]?.[j]?.predictionArea ?? 0,
    insideTraceShare: pairs.reduce((s, row) => s + row[j].intersection, 0) / (pairs[0]?.[j]?.predictionArea || 1) }))
    .filter((_p, j) => !matchedPredictions.has(j))

  const complete = reference.annotation?.completeness !== 'partial'
  const truthTotal = rooms.reduce((s, r) => s + r.truthSqft, 0)
  const found = rooms.filter((r) => r.status === 'found')
  const extraOutside = extras.reduce((s, e) => s + e.sqft * (1 - Math.min(1, e.insideTraceShare)), 0)
  return {
    engine: AREA_ENGINE_VERSION,
    reference: reference.name,
    complete,
    summary: {
      rooms: rooms.length,
      found: found.length,
      exact: found.filter((r) => r.exact).length,
      within2pct: found.filter((r) => r.within2pct).length,
      merged: rooms.filter((r) => r.status === 'merged').length,
      missed: rooms.filter((r) => r.status === 'missed').length,
      split: rooms.filter((r) => r.splitInto > 1).length,
      extras: extras.length,
      // SF-weighted error: what a wrong answer would cost in square feet.
      errorSqft: rooms.reduce((s, r) => s + r.errorSqft, 0) + (complete ? extraOutside : 0),
      truthSqft: truthTotal,
      totalErrorPct: (proposals.reduce((s, p) => s + p.areaSqft, 0) - truthTotal) / truthTotal * 100,
    },
    rooms,
    extras: complete ? extras : extras.map((e) => ({ ...e, note: 'reference is partial; cannot judge' })),
  }
}

export async function scoreReferenceFile(file, { gate = false } = {}) {
  const reference = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!reference.input || !reference.truth?.areas?.length) throw Error(`${file} has no input evidence or traced areas`)
  if (reference.source?.sha256) assertNotHoldout({ sha256: reference.source.sha256, label: path.basename(file), script: 'score-area-reference', gate, engine: AREA_ENGINE_VERSION })
  const sidecar = file.replace(/\.json$/, '.scoring.json')
  const groups = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')).groups ?? [] : []
  const started = performance.now()
  const run = await runAreaEngine({ ...reference.input, region: { x0: 0, y0: 0, x1: 1, y1: 1 } }, { wholeSheet: true })
  return { ...scoreAreas(reference, run.detection.proposals, { groups }), elapsedMs: performance.now() - started, warnings: run.detection.warnings }
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out')
  if (!file) throw Error('Usage: node scripts/score-area-reference.mjs REFERENCE.json [--out report.json] [--gate]')
  const report = await scoreReferenceFile(file, { gate: args.includes('--gate') })
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  const s = report.summary
  console.log(`${report.reference} — engine ${report.engine}${report.complete ? '' : ' (partial reference)'}`)
  console.log(`found ${s.found}/${s.rooms} (${pct(s.found, s.rooms)})  exact ${s.exact}  within 2% ${s.within2pct}  merged ${s.merged}  missed ${s.missed}  split ${s.split}  extras ${s.extras}`)
  console.log(`SF error ${s.errorSqft.toFixed(0)} of ${s.truthSqft.toFixed(0)} SF (${pct(s.errorSqft, s.truthSqft)})  sheet total ${s.totalErrorPct >= 0 ? '+' : ''}${s.totalErrorPct.toFixed(1)}%  ${(report.elapsedMs / 1000).toFixed(1)} s`)
  for (const r of report.rooms) console.log(`  ${r.label.padEnd(28)} ${r.truthSqft.toFixed(1).padStart(7)}  ${r.status === 'found' ? `IoU ${r.iou.toFixed(2)}  ${r.areaErrorPct >= 0 ? '+' : ''}${r.areaErrorPct.toFixed(1)}%  ← ${r.prediction}` : `${r.status}${r.swallowedBy?.length ? ` into ${r.swallowedBy.join(', ')}` : ''}`}`)
}

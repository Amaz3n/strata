#!/usr/bin/env node
// Offline only: no database writes, network calls, or automatic AI uploads.
require('./register-ts-node-test')
const fs = require('node:fs')
const path = require('node:path')
const { interpretLevel } = require('../lib/drawings/floorplan-interpret')
const { modelToNormalized } = require('../lib/drawings/floorplan-model')
const { scoreRooms, validateRooms } = require('./lib/room-benchmark.cjs')

function run(fixture) {
  if (fixture.version !== 1 || !fixture.id || !fixture.project || !['synthetic', 'real'].includes(fixture.kind) || !['development', 'holdout'].includes(fixture.split)) throw new Error('Fixture requires version:1, id, project, kind and split')
  if (fixture.units !== 'sheet-feet' || fixture.boundary !== 'interior-face') throw new Error('Reference polygons must use sheet-feet and interior-face boundaries')
  validateRooms(fixture.truth)
  const input = fixture.input
  for (const key of ['imageWidth', 'imageHeight', 'feetPerImagePx']) if (!(Number.isFinite(input?.[key]) && input[key] > 0)) throw new Error(`Invalid input.${key}`)
  if (!Array.isArray(input.segments) || input.segments.length % 4 || !input.segments.every(Number.isFinite)) throw new Error('Invalid segments')
  const started = performance.now()
  const level = interpretLevel({ ...input, sheetVersionId: fixture.id, sheetNumber: null, sheetTitle: null, name: fixture.id, order: 0, textRuns: input.textRuns ?? [], flags: input.flags ?? null })
  const elapsedMs = performance.now() - started
  const baseline = level.rooms.map(room => ({ id: room.id, label: room.label, polygon: room.polygon.map(([x, y]) => {
    const n = modelToNormalized(level.source, x, y)
    return [n.x * input.imageWidth * input.feetPerImagePx, n.y * input.imageHeight * input.feetPerImagePx]
  }) }))
  const entries = [{ name: 'arc-current-centerlines', rooms: baseline, inferenceMs: elapsedMs }, ...(fixture.candidates ?? [])]
  const names = new Set()
  const results = entries.map(entry => {
    if (!entry.name || names.has(entry.name)) throw new Error('Candidate names must be unique')
    names.add(entry.name)
    const timing = entry.timing ?? null
    if (timing && !['manualSeconds', 'assistedSeconds'].every(key => Number.isFinite(timing[key]) && timing[key] > 0)) throw new Error('Timings must be positive measured seconds')
    return { name: entry.name, inferenceMs: entry.inferenceMs ?? null, timing,
      timeSavedPercent: timing ? 100 * (1 - timing.assistedSeconds / timing.manualSeconds) : null,
      ...scoreRooms(fixture.truth, entry.rooms), rooms: entry.rooms }
  })
  return { id: fixture.id, project: fixture.project, kind: fixture.kind, split: fixture.split, boundary: fixture.boundary, matchingIoU: 0.5, boundarySampleSpacingFt: 0.1, results }
}
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function reviewHtml(fixture, report) {
  const width = fixture.input.imageWidth * fixture.input.feetPerImagePx
  const height = fixture.input.imageHeight * fixture.input.feetPerImagePx
  const draw = (rooms, color) => rooms.map(room => `<polygon points="${room.polygon.map(p => p.join(',')).join(' ')}" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-width="0.06"><title>${escape(room.label ?? room.id)}</title></polygon>`).join('')
  const vectors = fixture.input.segments
  let ink = ''
  for (let i = 0; i < vectors.length; i += 4) ink += `<line x1="${vectors[i] * width}" y1="${vectors[i + 1] * height}" x2="${vectors[i + 2] * width}" y2="${vectors[i + 3] * height}"/>`
  return `<!doctype html><meta charset="utf-8"><title>Room benchmark ${escape(fixture.id)}</title><style>body{font:16px system-ui;margin:32px;max-width:1200px;background:#f6f6f3;color:#202520}svg{background:white;width:100%;max-height:75vh;border:1px solid #ccc}pre{white-space:pre-wrap}section{margin-bottom:40px}</style><h1>${escape(fixture.id)}</h1><p>${escape(fixture.kind)} · ${escape(fixture.split)}. Green: reference interior boundaries. Magenta: detector output. Gray: source vectors. This is a benchmark overlay, not an approved takeoff.</p>${report.results.map(result => `<section><h2>${escape(result.name)}</h2><svg viewBox="0 0 ${width} ${height}"><g stroke="#888" stroke-width="0.025">${ink}</g>${draw(fixture.truth, '#00894e')}${draw(result.rooms, '#c00091')}</svg><pre>${escape(JSON.stringify({ ...result, rooms: undefined }, null, 2))}</pre></section>`).join('')}`
}
if (require.main === module) {
  try {
    const [file, output] = process.argv.slice(2)
    if (!file || !output) throw new Error('Usage: node scripts/benchmark-rooms.cjs CASE.json OUTPUT_DIRECTORY')
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
    const report = run(fixture)
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(output, 'review.html'), reviewHtml(fixture, report))
    console.log(JSON.stringify({ ...report, results: report.results.map(({ rooms, ...result }) => result) }, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { run, reviewHtml }

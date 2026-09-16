const test = require('node:test')
const assert = require('node:assert/strict')
const { iou, scoreRooms, validateRooms } = require('../scripts/lib/room-benchmark.cjs')
const rect = (id, x, y, w, h) => ({ id, polygon: [[x,y],[x+w,y],[x+w,y+h],[x,y+h]] })
test('exact overlap handles concavity and opposite winding', () => {
  const p = [[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]
  assert.ok(Math.abs(iou(p, [...p].reverse()) - 1) < 1e-10)
  assert.ok(Math.abs(iou(p, rect('x',0,0,2,2).polygon) - 0.75) < 1e-10)
  assert.equal(iou(p, rect('x',4,4,1,1).polygon), 0)
})
test('merged rooms cannot count as two correct detections', () => {
  const result = scoreRooms([rect('a',0,0,10,10),rect('b',10,0,10,10)], [rect('merged',0,0,20,10)])
  assert.equal(result.matchedCount, 1)
  assert.equal(result.missed.length, 1)
  assert.equal(result.matches[0].areaErrorPercent, 100)
})
test('duplicate predictions remain false positives', () => {
  const result = scoreRooms([rect('a',0,0,10,10)], [rect('x',0,0,10,10),rect('y',0,0,10,10)])
  assert.equal(result.precision, 0.5)
  assert.equal(result.extra.length, 1)
})
test('centerline inflation is visible despite a successful room match', () => {
  const result = scoreRooms([rect('a',0.25,0.25,9.5,9.5)], [rect('x',0,0,10,10)])
  assert.equal(result.recall, 1)
  assert.ok(result.matches[0].areaErrorPercent > 10)
  assert.ok(result.matches[0].boundaryP95Ft >= 0.25)
})
test('no predictions means missed rooms and undefined precision', () => {
  const result = scoreRooms([rect('a',0,0,10,10)], [])
  assert.equal(result.recall, 0)
  assert.equal(result.precision, null)
})
test('invalid reference geometry fails loudly', () => {
  assert.throws(() => validateRooms([{id:'a',polygon:[[0,0],[2,2],[0,2],[2,0]]}]), /self-intersecting/)
  assert.throws(() => validateRooms([{...rect('a',0,0,10,10),holes:[rect('h',1,1,1,1).polygon]}]), /holes/)
})
test('baseline preserves the sheet origin and exposes interior-area inflation', () => {
  const { run, reviewHtml } = require('../scripts/benchmark-rooms.cjs')
  const fixture = require('./fixtures/room-benchmark/synthetic-two-rooms.json')
  const report = run(fixture)
  assert.equal(report.kind, 'synthetic')
  assert.equal(report.results[0].matchedCount, 2)
  for (const match of report.results[0].matches) assert.ok(Math.abs(match.areaErrorPercent - 9.8398) < 0.01)
  assert.equal(report.results[0].timeSavedPercent, null)
  assert.ok(reviewHtml(fixture, report).includes('arc-current-centerlines'))
})
test('alternate detector results use the same reference and measured timings', () => {
  const { run } = require('../scripts/benchmark-rooms.cjs')
  const fixture = require('./fixtures/room-benchmark/synthetic-two-rooms.json')
  const result = run({ ...fixture, candidates: [{name:'test-oracle',rooms:fixture.truth,timing:{manualSeconds:100,assistedSeconds:40}}] }).results[1]
  assert.equal(result.timeSavedPercent, 60)
  assert.equal(result.matchedCount, 2)
  assert.ok(result.matches.every(m => Math.abs(m.areaErrorPercent) < 1e-8 && m.boundaryP95Ft < 1e-8))
})

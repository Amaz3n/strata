require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const {
  SHEET_BUILDING_ENGINE_VERSION, sheetBuildingInputKey, sheetBuildingRunKey,
  reusableSheetBuildingRun, storableSheetBuildingRun, withSheetBuildingRun,
} = require('../lib/drawings/sheet-building-record')
const { AREA_ENGINE_VERSION } = require('../lib/drawings/area-takeoff')

const source = { segments: new Float32Array([0, 0, 1, 1]), flags: new Uint8Array([1]), imageWidth: 1000, imageHeight: 800, feetPerImagePx: 0.02,
  textRuns: [{ text: 'KITCHEN', x: .2, y: .2, w: .1, h: .02 }],
  evidence: { version: 1, paths: [], truncated: false, rasterText: { runs: [{ text: 'BATH', x: .6, y: .6, w: .1, h: .02 }] } } }
const run = (recognition = 'completed') => ({ detection: { engine: AREA_ENGINE_VERSION, proposals: [], warnings: [], segmentCount: 1 }, recognition })
const stored = (inputKey, runs, engineVersion = SHEET_BUILDING_ENGINE_VERSION) => ({ engineVersion, inputKey, record: { runs } })

test('takeoff and model agree on the input key whether or not text runs were pre-merged', () => {
  const merged = { ...source, segments: [0, 0, 1, 1], textRuns: [...source.textRuns, ...source.evidence.rasterText.runs] }
  assert.equal(sheetBuildingInputKey(source), sheetBuildingInputKey(merged))
  assert.equal(sheetBuildingInputKey({ ...source, flags: undefined }), sheetBuildingInputKey({ ...source, flags: [] }))
})

test('a recalibrated scale or changed evidence is a different input', () => {
  const key = sheetBuildingInputKey(source)
  assert.notEqual(key, sheetBuildingInputKey({ ...source, feetPerImagePx: 0.021 }))
  assert.notEqual(key, sheetBuildingInputKey({ ...source, segments: new Float32Array([0, 0, 1, 2]) }))
  assert.notEqual(key, sheetBuildingInputKey({ ...source, evidence: { ...source.evidence, truncated: true } }))
})

test('a stored run is reused only for the same engine, evidence and run policy', () => {
  const runKey = sheetBuildingRunKey('include-fixtures', 'hybrid')
  const record = stored('k', { [runKey]: run() })
  assert.ok(reusableSheetBuildingRun(record, 'k', runKey))
  assert.equal(reusableSheetBuildingRun(record, 'other', runKey), null)
  assert.equal(reusableSheetBuildingRun(record, 'k', sheetBuildingRunKey('drawn', 'hybrid')), null)
  assert.equal(reusableSheetBuildingRun(stored('k', { [runKey]: run() }, 'old'), 'k', runKey), null)
  assert.equal(reusableSheetBuildingRun(stored('k', { [runKey]: { ...run(), detection: { ...run().detection, engine: -1 } } }), 'k', runKey), null)
  assert.equal(reusableSheetBuildingRun(null, 'k', runKey), null)
})

test('runs from the same evidence accumulate; new evidence replaces them', () => {
  const drawn = sheetBuildingRunKey('drawn', 'hybrid'), fixtures = sheetBuildingRunKey('include-fixtures', 'hybrid')
  const first = stored('k', { [drawn]: run() })
  assert.deepEqual(Object.keys(withSheetBuildingRun(first, 'k', fixtures, run()).runs).sort(), [fixtures, drawn].sort())
  assert.deepEqual(Object.keys(withSheetBuildingRun(first, 'new', fixtures, run()).runs), [fixtures])
  assert.deepEqual(Object.keys(withSheetBuildingRun(stored('k', { [drawn]: run() }, 'old'), 'k', fixtures, run()).runs), [fixtures])
})

test('incomplete recognition never becomes the record', () => {
  assert.equal(storableSheetBuildingRun(run('partial')), false)
  assert.equal(storableSheetBuildingRun(run('unavailable')), false)
  for (const r of ['completed', 'not-needed', 'vector-only']) assert.equal(storableSheetBuildingRun(run(r)), true)
})

const { ensureSheetBuildingRun } = require('../lib/services/sheet-building-records')
const fakeClient = (state) => ({ from(table) {
  assert.equal(table, 'sheet_building_records')
  const filters = {}; let write
  const q = {
    select() { return q }, eq(k, v) { filters[k] = v; return q },
    insert(values) { write = { kind: 'insert', values }; return q }, update(values) { write = { kind: 'update', values }; return q },
    async maybeSingle() {
      assert.equal(filters.org_id, 'org')
      if (state.missing) return { data: null, error: { code: '42P01', message: 'missing' } }
      return { data: state.row ?? null, error: null }
    },
    then(resolve, reject) {
      assert.equal(write.kind === 'insert' ? write.values.org_id : filters.org_id, 'org')
      if (write.kind === 'insert') state.row = { id: 'row', updated_at: 't1', ...write.values }
      else if (filters.updated_at === state.row.updated_at) state.row = { ...state.row, ...write.values, updated_at: 't2' }
      state.writes++
      return Promise.resolve({ error: null }).then(resolve, reject)
    },
  }
  return q
} })
const scope = (state) => ({ supabase: fakeClient(state), orgId: 'org', projectId: 'project', sheetVersionId: 'sheet' })

test('the record is computed once and then read by the other caller', async () => {
  const state = { writes: 0 }, runKey = sheetBuildingRunKey('include-fixtures', 'hybrid')
  let computed = 0
  const compute = async () => { computed++; return run() }
  await ensureSheetBuildingRun(scope(state), { inputKey: 'k', runKey }, compute)
  const second = await ensureSheetBuildingRun(scope(state), { inputKey: 'k', runKey }, compute)
  assert.equal(computed, 1); assert.equal(state.writes, 1); assert.equal(second.recognition, 'completed')
  assert.equal(state.row.engine_version, SHEET_BUILDING_ENGINE_VERSION); assert.equal(state.row.project_id, 'project')
  await ensureSheetBuildingRun(scope(state), { inputKey: 'k', runKey: sheetBuildingRunKey('drawn', 'hybrid') }, compute)
  assert.equal(computed, 2); assert.deepEqual(Object.keys(state.row.record.runs).length, 2)
})

test('partial recognition is returned but not stored; a missing table computes nothing', async () => {
  const state = { writes: 0 }
  const partial = await ensureSheetBuildingRun(scope(state), { inputKey: 'k', runKey: 'x' }, async () => run('partial'))
  assert.equal(partial.recognition, 'partial'); assert.equal(state.writes, 0)
  const missing = { writes: 0, missing: true }
  assert.equal(await ensureSheetBuildingRun(scope(missing), { inputKey: 'k', runKey: 'x' }, async () => { throw new Error('must not compute') }), null)
})

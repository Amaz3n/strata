const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs')
const { expandReferences, components, assessDependencies } = require('../scripts/enterprise-production-dependencies.cjs')
const fixture = () => JSON.parse(fs.readFileSync('docs/enterprise-production/acceptance.json', 'utf8'))
test('shorthand preserves individual task IDs, complete workstreams and unknown references', () => {
  assert.deepEqual(expandReferences('F01/F02 and E03-01/02, E02, E99-01', ['F01', 'F02', 'E03-01', 'E03-02', 'E02-01', 'E02-02']), { references: ['E02-01', 'E02-02', 'E03-01', 'E03-02', 'F01', 'F02'], unknown: ['E99-01'] })
})
test('reciprocal cycles retain all members and references instead of silently dropping an edge', () => {
  const groups = components(['A', 'B', 'C', 'D'], [{ taskId: 'A', prerequisiteId: 'B' }, { taskId: 'B', prerequisiteId: 'A' }, { taskId: 'C', prerequisiteId: 'B' }])
  assert.deepEqual(groups, [['A', 'B'], ['C'], ['D']])
})
test('actual finish-line audit covers all50 tasks and56 original criteria and exposes reciprocal producer design', () => {
  const tracker = fixture(), result = assessDependencies(tracker)
  assert.equal(result.tasks.length, 50)
  assert.equal(result.originalTraceability.length, 14)
  assert.equal(result.originalTraceability.reduce((n, row) => n + row.criteria.length, 0), 56)
  for (const pair of [['E03-02', 'E04-02'], ['E05-01', 'E04-03'], ['E05-04', 'E11-01']]) assert.ok(result.reciprocalGroups.some(group => pair.every(id => group.taskIds.includes(id))), pair.join('/'))
  const position = new Map(result.condensedOrder.map((id, i) => [id, i]))
  for (const group of result.condensedGroups) for (const dependency of group.prerequisites) assert.ok(position.get(dependency) < position.get(group.id))
  const represented = result.condensedGroups.flatMap(group => group.taskIds)
  assert.equal(new Set(represented).size, 50)
  assert.equal(represented.length, 50)
  assert.ok(result.unresolved.some(row => row.taskId === 'E12-01'))
  assert.ok(result.blockedTasks.find(row => row.taskId === 'E03-01').reasons.some(reason => reason.includes('F03')))
})
test('unknown producer and domain receipt dependencies remain unresolved', () => {
  const tracker = fixture(); tracker.taskContracts.find(task => task.id === 'E03-01').dependencies.contract = 'E99-01 and domain receipts'
  const result = assessDependencies(tracker)
  assert.ok(result.unresolved.some(row => row.taskId === 'E03-01' && row.reference === 'E99-01'))
  assert.ok(result.unresolved.some(row => row.taskId === 'E03-01' && row.reference === 'domain contract detail'))
})
test('duplicate tasks, missing dependency text and unknown original traceability cannot pass the audit', () => {
  let tracker = fixture(); tracker.taskContracts.push(tracker.taskContracts[0]); assert.throws(() => assessDependencies(tracker), /Duplicate/)
  tracker = fixture(); delete tracker.taskContracts[0].dependencies.contract; assert.throws(() => assessDependencies(tracker), /Missing/)
  tracker = fixture(); tracker.originalAcceptanceTraceability[0].criteriaInOriginalOrder[0] = 'E99-01'; assert.throws(() => assessDependencies(tracker), /traceability/)
})
test('an accepted label with failing DoD cannot unlock a dependent task', () => {
  const tracker = fixture(), producer = tracker.taskContracts.find(task => task.id === 'F03')
  producer.acceptanceStatus = 'accepted'
  producer.specificDoD.forEach(row => { row.passed = true }); producer.universalDoD.forEach(row => { row.passed = true }); producer.universalDoD[0].passed = false
  const result = assessDependencies(tracker)
  assert.ok(result.blockedTasks.find(row => row.taskId === 'E03-01').reasons.includes('Unaccepted prerequisite F03'))
})

test('empty or undocumented DoD cannot turn an accepted label into a passing prerequisite', () => {
  for (const mutate of [task => { task.specificDoD = [] }, task => { task.universalDoD = [] }, task => { task.universalDoD[0].evidence = [] }]) {
    const tracker = fixture(), producer = tracker.taskContracts.find(task => task.id === 'F03')
    producer.acceptanceStatus = 'accepted'
    for (const row of [...producer.specificDoD, ...producer.universalDoD]) { row.passed = true; row.evidence = [{ candidate: 'Test only' }] }
    mutate(producer)
    assert.ok(assessDependencies(tracker).blockedTasks.find(row => row.taskId === 'E03-01').reasons.includes('Unaccepted prerequisite F03'))
  }
})

test('original lifecycle ranges retain every required scenario and unknown scenarios fail closed', () => {
  const tracker = fixture(), result = assessDependencies(tracker)
  const ep14 = result.originalTraceability.find(row => row.workstream === 'EP14')
  assert.deepEqual(ep14.criteria[0].scenarioIds, ['A01', 'A02', 'A03', 'A04', 'A05', 'A06'])
  assert.deepEqual(ep14.criteria[1].scenarioIds, ['A07', 'A08', 'A09'])
  tracker.originalAcceptanceTraceability[0].criteriaInOriginalOrder[0] += ', A99'
  assert.throws(() => assessDependencies(tracker), /Unknown scenario/)
})
test('a fully checked documented prerequisite clears only its own dependency reason', () => {
  const tracker = fixture(), producer = tracker.taskContracts.find(task => task.id === 'F03')
  producer.acceptanceStatus = 'accepted'
  for (const row of [...producer.specificDoD, ...producer.universalDoD]) { row.passed = true; row.evidence = [{ candidate: 'Synthetic complete prerequisite' }] }
  const reasons = assessDependencies(tracker).blockedTasks.find(row => row.taskId === 'E03-01').reasons
  assert.ok(!reasons.includes('Unaccepted prerequisite F03'))
  assert.ok(reasons.includes('Unaccepted prerequisite F04'))
})

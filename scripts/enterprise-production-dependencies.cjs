'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** Expand shorthand without silently turning unknown requirements into no deps. */
function expandReferences(text, taskIds) {
  const ids = new Set(taskIds), references = new Set(), unknown = new Set()
  for (const match of text.matchAll(/\b(F\d{2}|E\d{2}(?:-\d{2})?)(?:\/\d{2})*\b/g)) {
    const [first, ...suffixes] = match[0].split('/')
    if (/^E\d{2}$/.test(first)) {
      const members = taskIds.filter(id => id.startsWith(`${first}-`))
      if (members.length) members.forEach(id => references.add(id))
      else unknown.add(first)
      if (suffixes.length) unknown.add(match[0])
    } else {
      const expanded = [first, ...suffixes.map(suffix => `${first.slice(0, -2)}${suffix}`)]
      expanded.forEach(id => ids.has(id) ? references.add(id) : unknown.add(id))
    }
  }
  return { references: [...references].sort(), unknown: [...unknown].sort() }
}

function components(nodes, edges) {
  const adjacency = new Map(nodes.map(id => [id, []]))
  edges.forEach(({ taskId, prerequisiteId }) => adjacency.get(taskId).push(prerequisiteId))
  let next = 0
  const index = new Map(), low = new Map(), stack = [], active = new Set(), result = []
  function visit(id) {
    index.set(id, next); low.set(id, next++); stack.push(id); active.add(id)
    for (const dependency of adjacency.get(id)) {
      if (!index.has(dependency)) { visit(dependency); low.set(id, Math.min(low.get(id), low.get(dependency))) }
      else if (active.has(dependency)) low.set(id, Math.min(low.get(id), index.get(dependency)))
    }
    if (low.get(id) === index.get(id)) {
      const group = []
      let member
      do { member = stack.pop(); active.delete(member); group.push(member) } while (member !== id)
      result.push(group.sort())
    }
  }
  nodes.forEach(id => { if (!index.has(id)) visit(id) })
  return result.sort((a, b) => a[0].localeCompare(b[0]))
}

function assessDependencies(tracker) {
  const tasks = tracker.taskContracts
  if (!Array.isArray(tasks) || !tasks.length) throw Error('Task contracts are required')
  const ids = tasks.map(task => task.id)
  if (new Set(ids).size !== ids.length) throw Error('Duplicate task IDs')
  const edges = [], unresolved = [], descriptions = []
  for (const task of tasks) {
    const text = task.dependencies?.contract
    if (typeof text !== 'string' || !text.trim()) throw Error(`Missing dependency contract: ${task.id}`)
    const parsed = expandReferences(text, ids)
    const dependencies = parsed.references.filter(id => id !== task.id)
    descriptions.push({ taskId: task.id, originalContract: text, resolvedTaskIds: dependencies })
    dependencies.forEach(prerequisiteId => edges.push({ taskId: task.id, prerequisiteId, semantics: 'required_contract_reference_not_yet_classified_as_design_implementation_or_acceptance' }))
    parsed.unknown.forEach(reference => unresolved.push({ taskId: task.id, reference, reason: 'Unknown task/workstream reference' }))
    if (/pending F01|domain (?:bulk |transaction )?contracts|domain receipts|domain completeness/i.test(text)) unresolved.push({ taskId: task.id, reference: 'domain contract detail', reason: 'Concrete producer/consumer child contracts are not enumerated' })
    if (!dependencies.length && !/nothing/i.test(text)) unresolved.push({ taskId: task.id, reference: 'dependency classification', reason: 'No concrete dependency; absence of IDs is not proof of independence' })
  }
  const groups = components(ids, edges)
  const byId = new Map()
  groups.forEach((members, i) => members.forEach(id => byId.set(id, `F01.DG${String(i + 1).padStart(2, '0')}`)))
  const condensed = groups.map(members => ({
    id: byId.get(members[0]), taskIds: members,
    requiresReciprocalContractDesign: members.length > 1,
    prerequisites: [...new Set(edges.filter(edge => members.includes(edge.taskId) && !members.includes(edge.prerequisiteId)).map(edge => byId.get(edge.prerequisiteId)))].sort(),
    status: 'unaccepted',
  }))
  const order = [], remaining = new Map(condensed.map(group => [group.id, group]))
  while (remaining.size) {
    const available = [...remaining.values()].filter(group => group.prerequisites.every(id => order.includes(id))).sort((a, b) => a.id.localeCompare(b.id))
    if (!available.length) throw Error('Condensed graph must be acyclic')
    available.forEach(group => { order.push(group.id); remaining.delete(group.id) })
  }
  const traceability = (tracker.originalAcceptanceTraceability ?? []).map(row => ({
    workstream: row.workstream,
    criteria: row.criteriaInOriginalOrder.map((text, i) => {
      const parsed = expandReferences(text, ids)
      if (parsed.unknown.length || !parsed.references.length) throw Error(`Unresolved original task traceability ${row.workstream}:${i + 1}`)
      const scenarioIds = new Set()
      for (const match of text.matchAll(/\bA(\d{2})(?:[–-]A(\d{2}))?\b/g)) {
        const start = Number(match[1]), end = match[2] ? Number(match[2]) : start
        if (end < start) throw Error(`Invalid scenario range ${match[0]}`)
        for (let n = start; n <= end; n++) {
          const id = `A${String(n).padStart(2, '0')}`
          if (!tracker.lifecycleScenarios?.some(scenario => scenario.id === id)) throw Error(`Unknown scenario ${id}`)
          scenarioIds.add(id)
        }
      }
      return { ordinal: i + 1, originalReference: text, taskIds: parsed.references, scenarioIds: [...scenarioIds].sort() }
    }),
  }))
  const unresolvedTasks = new Set(unresolved.map(item => item.taskId))
  const accepted = task => task.acceptanceStatus === 'accepted' && task.specificDoD.length > 0 &&
    task.universalDoD.length === 9 && new Set(task.universalDoD.map(row => row.id)).size === 9 &&
    Array.from({ length: 9 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`).every(id => task.universalDoD.some(row => row.id === id)) &&
    [...task.specificDoD, ...task.universalDoD].every(row => row.passed === true && Array.isArray(row.evidence) && row.evidence.length > 0)
  const acceptedIds = new Set(tasks.filter(accepted).map(task => task.id))
  const blockedTasks = tasks.map(task => ({ taskId: task.id,
    reasons: [
      ...(unresolvedTasks.has(task.id) ? ['Dependency child contracts are unresolved'] : []),
      ...(groups.find(group => group.includes(task.id)).length > 1 ? ['Reciprocal dependency design and producer order are unresolved'] : []),
      ...edges.filter(edge => edge.taskId === task.id && !acceptedIds.has(edge.prerequisiteId)).map(edge => `Unaccepted prerequisite ${edge.prerequisiteId}`),
    ],
  }))
  return { version: 1, status: 'source_reference_audit_only_not_implementation_order', tasks: descriptions, edges, unresolved, reciprocalGroups: condensed.filter(group => group.requiresReciprocalContractDesign), condensedGroups: condensed, condensedOrder: order, originalTraceability: traceability, blockedTasks,
    limits: ['Condensation proves a diagnostic DAG, not acceptance or a safe producer order inside reciprocal groups.', 'Every original reference remains present; no cycle edge is discarded or reclassified to claim readiness.', 'Applicable local/full-schema/QA/release criteria remain governed by the original finish-line contract.', 'Scoring weights are not frozen by this source-reference audit.'] }
}

function run(root, mode) {
  if (!['--check', '--refresh'].includes(mode)) throw Error('Usage: node scripts/enterprise-production-dependencies.cjs --check|--refresh')
  const trackerPath = path.join(root, 'docs/enterprise-production/acceptance.json')
  const raw = fs.readFileSync(trackerPath), tracker = JSON.parse(raw)
  const planPath = path.join(root, tracker.acceptanceContract.path)
  const planSha = crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex')
  if (planSha !== tracker.acceptanceContract.sha256) throw Error('Acceptance contract source drift; reconcile the adopted plan before refreshing dependencies')
  const assessment = assessDependencies(tracker)
  assessment.generatorSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  assessment.planSha256 = planSha
  assessment.contractSourceSha256 = crypto.createHash('sha256').update(JSON.stringify({ tasks: tracker.taskContracts.map(task => [task.id, task.dependencies.contract]), traceability: tracker.originalAcceptanceTraceability, scenarios: tracker.lifecycleScenarios.map(scenario => scenario.id) })).digest('hex')
  if (mode === '--refresh') {
    tracker.baselineInventory.dependencyContractAudit = assessment
    for (const row of assessment.tasks) {
      const task = tracker.taskContracts.find(task => task.id === row.taskId)
      task.dependencies.resolvedTaskIds = row.resolvedTaskIds
      task.dependencies.graphStatus = 'source_references_resolved_child_semantics_unaccepted'
    }
    tracker.executionLog.push({ date: new Date().toISOString().slice(0, 10), slice: 'F01.C02: dependency source references and reciprocal groups reconciled', taskCount: assessment.tasks.length, edgeCount: assessment.edges.length, unresolved: assessment.unresolved, reciprocalGroups: assessment.reciprocalGroups, implementationAcceptance: false, releaseAcceptance: false, limits: assessment.limits })
    const temporary = `${trackerPath}.${crypto.randomUUID()}.tmp`
    try {
      const fd = fs.openSync(temporary, 'wx')
      try { fs.writeFileSync(fd, JSON.stringify(tracker, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      if (!fs.readFileSync(trackerPath).equals(raw)) throw Error('Concurrent tracker mutation; refusing to replace newer evidence')
      fs.renameSync(temporary, trackerPath)
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  }
  const previous = tracker.baselineInventory.dependencyContractAudit
  const drift = mode === '--check' && (!previous || previous.contractSourceSha256 !== assessment.contractSourceSha256 || previous.planSha256 !== planSha || previous.generatorSha256 !== assessment.generatorSha256)
  const summary = { mode, taskCount: assessment.tasks.length, edgeCount: assessment.edges.length, reciprocalGroupCount: assessment.reciprocalGroups.length, unresolvedCount: assessment.unresolved.length, drift, implementationOrderAccepted: false }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  return mode === '--check' && (drift || assessment.unresolved.length || assessment.reciprocalGroups.length) ? 1 : 0
}
if (require.main === module) process.exitCode = run(path.resolve(__dirname, '..'), process.argv[2])
module.exports = { expandReferences, components, assessDependencies, run }

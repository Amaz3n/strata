import type { ScheduleItem, ScheduleDependency } from "@/lib/types"
import { addDays, parseDate, toDateString, daysBetween, isWeekend } from "@/components/schedule/types"

export interface ScheduleImpact {
  id: string
  start_date?: string
  end_date?: string
}

export function wouldCreateDependencyCycle(
  dependencies: Array<{ item_id: string; depends_on_item_id: string }>,
  predecessorId: string,
  successorId: string,
) {
  const outgoing = new Map<string, string[]>()
  for (const dependency of dependencies) {
    const list = outgoing.get(dependency.depends_on_item_id) ?? []
    list.push(dependency.item_id)
    outgoing.set(dependency.depends_on_item_id, list)
  }
  const queue = [successorId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    if (current === predecessorId) return true
    if (visited.has(current)) continue
    visited.add(current)
    queue.push(...(outgoing.get(current) ?? []))
  }
  return false
}

function skipWeekends(date: Date, days: number): Date {
  const result = new Date(date)
  let remaining = days
  const step = days > 0 ? 1 : -1
  while (remaining !== 0) {
    result.setDate(result.getDate() + step)
    if (!isWeekend(result)) {
      remaining -= step
    }
  }
  return result
}

export function calculateScheduleImpacts(
  items: ScheduleItem[],
  dependencies: ScheduleDependency[],
  initialUpdate: { id: string; start_date?: string; end_date?: string }
): ScheduleImpact[] {
  const impacts = new Map<string, ScheduleImpact>()
  impacts.set(initialUpdate.id, { id: initialUpdate.id, start_date: initialUpdate.start_date, end_date: initialUpdate.end_date })

  // Build dependency graph (forward direction: what items depend on item X)
  const forwardDeps = new Map<string, ScheduleDependency[]>()
  for (const dep of dependencies) {
    if (!forwardDeps.has(dep.depends_on_item_id)) {
      forwardDeps.set(dep.depends_on_item_id, [])
    }
    forwardDeps.get(dep.depends_on_item_id)!.push(dep)
  }

  // Queue for BFS propagation
  const queue = [initialUpdate.id]

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const currentImpact = impacts.get(currentId)!
    const currentItem = items.find(i => i.id === currentId)
    if (!currentItem) continue

    const currentStart = parseDate(currentImpact.start_date || currentItem.start_date || currentImpact.end_date || currentItem.end_date || "")
    const currentEnd = parseDate(currentImpact.end_date || currentItem.end_date || currentImpact.start_date || currentItem.start_date || "")
    if (!currentStart || !currentEnd) continue

    const outgoingDeps = forwardDeps.get(currentId) || []
    
    for (const dep of outgoingDeps) {
      const targetId = dep.item_id // The item that depends on the current item
      const targetItem = items.find(i => i.id === targetId)
      if (!targetItem) continue
      
      const targetStart = parseDate(targetItem.start_date || "")
      const targetEnd = parseDate(targetItem.end_date || "")
      if (!targetStart || !targetEnd) continue

      const duration = daysBetween(targetStart, targetEnd)
      const lag = dep.lag_days ?? 0
      const newStart = dep.dependency_type === "SS"
        ? addDays(currentStart, lag)
        : dep.dependency_type === "FF"
          ? addDays(addDays(currentEnd, lag), -duration)
          : dep.dependency_type === "SF"
            ? addDays(addDays(currentStart, lag), -duration)
            : addDays(currentEnd, lag)
      const newStartStr = toDateString(newStart)
      const newEndStr = toDateString(addDays(newStart, duration))

      const existingImpact = impacts.get(targetId)
      if (!existingImpact || existingImpact.start_date !== newStartStr || existingImpact.end_date !== newEndStr) {
        impacts.set(targetId, { id: targetId, start_date: newStartStr, end_date: newEndStr })
        queue.push(targetId)
      }
    }
  }

  // Convert map to array
  return Array.from(impacts.values())
}

export function calculateCriticalPath(items: ScheduleItem[], dependencies: ScheduleDependency[]): Set<string> {
  const criticalItems = new Set<string>()
  if (items.length === 0) return criticalItems

  const itemById = new Map(items.map((item) => [item.id, item]))
  const duration = new Map(items.map((item) => [item.id, getDuration(item)]))
  const outgoing = new Map<string, Array<{ target: string; weight: number }>>()
  const inDegree = new Map<string, number>()
  for (const item of items) { outgoing.set(item.id, []); inDegree.set(item.id, 0) }

  for (const dep of dependencies) {
    const predecessor = dep.depends_on_item_id
    const successor = dep.item_id
    if (!itemById.has(predecessor) || !itemById.has(successor)) continue
    const predecessorDuration = duration.get(predecessor) ?? 1
    const successorDuration = duration.get(successor) ?? 1
    const lag = dep.lag_days ?? 0
    const weight = dep.dependency_type === "SS" ? lag
      : dep.dependency_type === "FF" ? predecessorDuration + lag - successorDuration
        : dep.dependency_type === "SF" ? lag - successorDuration
          : predecessorDuration + lag
    outgoing.get(predecessor)?.push({ target: successor, weight })
    inDegree.set(successor, (inDegree.get(successor) ?? 0) + 1)
  }

  const earlyStart = new Map(items.map((item) => [item.id, 0]))
  const queue = items.filter((item) => inDegree.get(item.id) === 0).map((item) => item.id)
  const topoOrder: string[] = []
  while (queue.length > 0) {
    const predecessor = queue.shift()
    if (!predecessor) break
    topoOrder.push(predecessor)
    for (const edge of outgoing.get(predecessor) ?? []) {
      earlyStart.set(edge.target, Math.max(earlyStart.get(edge.target) ?? 0, (earlyStart.get(predecessor) ?? 0) + edge.weight))
      const nextDegree = (inDegree.get(edge.target) ?? 1) - 1
      inDegree.set(edge.target, nextDegree)
      if (nextDegree === 0) queue.push(edge.target)
    }
  }
  if (topoOrder.length !== items.length) return criticalItems

  const projectFinish = Math.max(...items.map((item) => (earlyStart.get(item.id) ?? 0) + (duration.get(item.id) ?? 1)))
  const lateStart = new Map(items.map((item) => [item.id, projectFinish - (duration.get(item.id) ?? 1)]))
  for (let index = topoOrder.length - 1; index >= 0; index -= 1) {
    const predecessor = topoOrder[index]
    for (const edge of outgoing.get(predecessor) ?? []) {
      lateStart.set(predecessor, Math.min(lateStart.get(predecessor) ?? projectFinish, (lateStart.get(edge.target) ?? projectFinish) - edge.weight))
    }
  }
  for (const item of items) if ((lateStart.get(item.id) ?? 0) - (earlyStart.get(item.id) ?? 0) <= 0) criticalItems.add(item.id)

  return criticalItems
}

function getDuration(item?: ScheduleItem): number {
  if (!item || !item.start_date || !item.end_date) return 1
  const start = parseDate(item.start_date)
  const end = parseDate(item.end_date)
  if (!start || !end) return 1
  return Math.max(1, daysBetween(start, end))
}

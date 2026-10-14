import type { ScheduleItem, ScheduleDependency } from "@/lib/types"
import { parseDate, daysBetween } from "@/components/schedule/types"

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

const MS_PER_DAY = 86_400_000

function dayNumber(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY
  return dayToString(day) === value ? day : null
}

function dayToString(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

export interface ScheduleMove {
  id: string
  start_date: string
  end_date: string
}

export interface PlannedScheduleChange {
  id: string
  start_date: string
  end_date: string
  /** The move that was asked for, or a successor the dependencies pulled along. */
  cause: "requested" | "dependency"
}

export type ScheduleMovePlan =
  | { ok: true; changes: PlannedScheduleChange[] }
  | { ok: false; error: string }

type PlannableItem = {
  id: string
  start_date?: string | null
  end_date?: string | null
  status?: string | null
  constraint_type?: string | null
}
type PlannableDependency = Pick<ScheduleDependency, "item_id" | "depends_on_item_id" | "dependency_type" | "lag_days">

/**
 * What the schedule looks like once the requested moves land and every
 * successor has been pushed to the latest date its predecessors allow.
 *
 * A successor with several predecessors starts when the LAST one lets it, so
 * each item is settled once, after all of its predecessors, in topological
 * order. Successors only move later: a predecessor finishing early never pulls
 * work forward. Completed and cancelled work, and tasks pinned by a "must"
 * constraint, keep their dates. Lags and durations are calendar days, computed
 * in UTC so the plan does not shift with the viewer's timezone. A cycle in the
 * stored graph is refused rather than looped over.
 */
export function planScheduleMove(
  items: PlannableItem[],
  dependencies: PlannableDependency[],
  moves: ScheduleMove[],
): ScheduleMovePlan {
  const itemById = new Map(items.map((item) => [item.id, item]))
  const current = new Map<string, { start: number; end: number }>()
  for (const item of items) {
    const start = dayNumber(item.start_date)
    const end = dayNumber(item.end_date)
    if (start === null && end === null) continue
    current.set(item.id, { start: start ?? end ?? 0, end: end ?? start ?? 0 })
  }

  const planned = new Map<string, { start: number; end: number }>()
  const requested = new Set<string>()
  for (const move of moves) {
    if (!itemById.has(move.id)) return { ok: false, error: "A schedule item in this move was not found" }
    if (requested.has(move.id)) return { ok: false, error: "A schedule item appears twice in this move" }
    const start = dayNumber(move.start_date)
    const end = dayNumber(move.end_date)
    if (start === null || end === null) return { ok: false, error: "Dates must be valid calendar dates" }
    if (end < start) return { ok: false, error: "A task cannot end before it starts" }
    requested.add(move.id)
    planned.set(move.id, { start, end })
  }

  const forward = new Map<string, PlannableDependency[]>()
  const incoming = new Map<string, PlannableDependency[]>()
  for (const dependency of dependencies) {
    if (!itemById.has(dependency.item_id) || !itemById.has(dependency.depends_on_item_id)) continue
    forward.set(dependency.depends_on_item_id, [...(forward.get(dependency.depends_on_item_id) ?? []), dependency])
    incoming.set(dependency.item_id, [...(incoming.get(dependency.item_id) ?? []), dependency])
  }

  const reachable = new Set<string>(requested)
  const frontier = [...requested]
  while (frontier.length > 0) {
    const id = frontier.pop()
    if (!id) break
    for (const dependency of forward.get(id) ?? []) {
      if (reachable.has(dependency.item_id)) continue
      reachable.add(dependency.item_id)
      frontier.push(dependency.item_id)
    }
  }

  const pending = new Map<string, number>()
  for (const id of reachable) {
    pending.set(id, (incoming.get(id) ?? []).filter((dependency) => reachable.has(dependency.depends_on_item_id)).length)
  }
  const ready = [...reachable].filter((id) => pending.get(id) === 0).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()
    if (!id) break
    order.push(id)
    for (const dependency of forward.get(id) ?? []) {
      const left = (pending.get(dependency.item_id) ?? 0) - 1
      pending.set(dependency.item_id, left)
      if (left === 0) ready.push(dependency.item_id)
    }
  }
  if (order.length !== reachable.size) return { ok: false, error: "These tasks depend on each other in a loop; remove one dependency first" }

  for (const id of order) {
    if (requested.has(id)) continue
    const item = itemById.get(id)
    const own = current.get(id)
    if (!item || !own) continue
    if (item.status === "completed" || item.status === "cancelled") continue
    if (item.constraint_type === "must_start_on" || item.constraint_type === "must_finish_on") continue
    const duration = own.end - own.start
    let start = own.start
    for (const dependency of incoming.get(id) ?? []) {
      const predecessor = planned.get(dependency.depends_on_item_id) ?? current.get(dependency.depends_on_item_id)
      if (!predecessor) continue
      const lag = dependency.lag_days ?? 0
      const earliest = dependency.dependency_type === "SS" ? predecessor.start + lag
        : dependency.dependency_type === "FF" ? predecessor.end + lag - duration
          : dependency.dependency_type === "SF" ? predecessor.start + lag - duration
            : predecessor.end + lag
      if (earliest > start) start = earliest
    }
    if (start !== own.start) planned.set(id, { start, end: start + duration })
  }

  const changes: PlannedScheduleChange[] = []
  for (const id of [...requested, ...order.filter((candidate) => !requested.has(candidate))]) {
    const next = planned.get(id)
    if (!next) continue
    const before = current.get(id)
    if (before && before.start === next.start && before.end === next.end) continue
    changes.push({ id, start_date: dayToString(next.start), end_date: dayToString(next.end), cause: requested.has(id) ? "requested" : "dependency" })
  }
  return { ok: true, changes }
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

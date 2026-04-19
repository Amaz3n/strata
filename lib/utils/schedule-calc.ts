import type { ScheduleItem, ScheduleDependency } from "@/lib/types"
import { addDays, parseDate, toDateString, daysBetween, isWeekend } from "@/components/schedule/types"

export interface ScheduleImpact {
  id: string
  start_date?: string
  end_date?: string
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

    const currentEndDateStr = currentImpact.end_date || currentItem.end_date || currentImpact.start_date || currentItem.start_date
    if (!currentEndDateStr) continue
    const currentEnd = parseDate(currentEndDateStr)
    if (!currentEnd) continue

    const outgoingDeps = forwardDeps.get(currentId) || []
    
    for (const dep of outgoingDeps) {
      const targetId = dep.item_id // The item that depends on the current item
      const targetItem = items.find(i => i.id === targetId)
      if (!targetItem) continue
      
      // If the target has a "Must Start On" constraint, it might not move, but for now we'll propagate FS (Finish to Start)
      if (dep.dependency_type === "FS") {
        const targetStartStr = targetItem.start_date
        const targetEndStr = targetItem.end_date
        if (!targetStartStr || !targetEndStr) continue
        
        const targetStart = parseDate(targetStartStr)
        const targetEnd = parseDate(targetEndStr)
        if (!targetStart || !targetEnd) continue
        
        const duration = daysBetween(targetStart, targetEnd)
        
        // Target should start after current finishes + lag_days
        // In business days or calendar days? Usually we might want to skip weekends.
        // Simplified approach: just calendar days for now, plus lag
        const newStart = addDays(currentEnd, Math.max(1, dep.lag_days || 1)) 
        
        // If the new start date is strictly later than the target's current start date, we push it.
        // In a true auto-schedule, we might also pull it back if it can start earlier. But usually, we only push.
        // Let's implement full auto-schedule (push and pull) based strictly on dependencies.
        const newStartStr = toDateString(newStart)
        const newEnd = addDays(newStart, duration)
        const newEndStr = toDateString(newEnd)
        
        const existingImpact = impacts.get(targetId)
        if (!existingImpact || existingImpact.start_date !== newStartStr) {
          impacts.set(targetId, {
            id: targetId,
            start_date: newStartStr,
            end_date: newEndStr
          })
          queue.push(targetId)
        }
      }
    }
  }

  // Convert map to array
  return Array.from(impacts.values())
}

export function calculateCriticalPath(items: ScheduleItem[], dependencies: ScheduleDependency[]): Set<string> {
  const criticalItems = new Set<string>()
  if (items.length === 0) return criticalItems

  // Build graph
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  
  items.forEach(i => {
    adj.set(i.id, [])
    inDegree.set(i.id, 0)
  })

  dependencies.forEach(dep => {
    // FS: depends_on finishes -> item starts
    if (adj.has(dep.depends_on_item_id) && inDegree.has(dep.item_id)) {
      adj.get(dep.depends_on_item_id)!.push(dep.item_id)
      inDegree.set(dep.item_id, inDegree.get(dep.item_id)! + 1)
    }
  })

  // Find longest path (critical path)
  // Simplified CPM:
  // 1. Calculate Early Start/Finish (Forward Pass)
  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  
  // Initialize nodes with 0 in-degree
  const q: string[] = []
  inDegree.forEach((deg, id) => {
    if (deg === 0) {
      q.push(id)
      es.set(id, 0)
      const duration = getDuration(items.find(i => i.id === id))
      ef.set(id, duration)
    }
  })

  const topoOrder: string[] = []
  
  while (q.length > 0) {
    const u = q.shift()!
    topoOrder.push(u)
    
    const uEf = ef.get(u) || 0
    
    adj.get(u)?.forEach(v => {
      const vEs = es.get(v) || 0
      if (uEf > vEs) {
        es.set(v, uEf)
      }
      
      inDegree.set(v, inDegree.get(v)! - 1)
      if (inDegree.get(v) === 0) {
        const duration = getDuration(items.find(i => i.id === v))
        ef.set(v, (es.get(v) || 0) + duration)
        q.push(v)
      }
    })
  }

  // Get max project duration
  let maxEf = 0
  ef.forEach(val => {
    if (val > maxEf) maxEf = val
  })

  // 2. Calculate Late Start/Finish (Backward Pass)
  const ls = new Map<string, number>()
  const lf = new Map<string, number>()

  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const u = topoOrder[i]
    if (!adj.get(u) || adj.get(u)!.length === 0) {
      lf.set(u, maxEf)
    } else {
      let minLs = Number.MAX_SAFE_INTEGER
      adj.get(u)!.forEach(v => {
        const vLs = ls.get(v) ?? maxEf
        if (vLs < minLs) minLs = vLs
      })
      lf.set(u, minLs)
    }
    const duration = getDuration(items.find(item => item.id === u))
    ls.set(u, (lf.get(u) || 0) - duration)
  }

  // 3. Float = LS - ES. If Float == 0, it's critical.
  items.forEach(item => {
    const earlyS = es.get(item.id) || 0
    const lateS = ls.get(item.id) || 0
    const float = lateS - earlyS
    if (float <= 0) {
      criticalItems.add(item.id)
    }
  })

  return criticalItems
}

function getDuration(item?: ScheduleItem): number {
  if (!item || !item.start_date || !item.end_date) return 1
  const start = parseDate(item.start_date)
  const end = parseDate(item.end_date)
  if (!start || !end) return 1
  return Math.max(1, daysBetween(start, end))
}

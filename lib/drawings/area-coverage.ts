import { containsPoint, type AreaProposal } from './area-takeoff'
import type { AreaPoint } from './area-evidence'
import type { TextRun } from './text-runs'
import { areaRoomLabel, areaTextRuns } from './area-labels'

export interface AreaCoverageLabel {
  label: string
  point: AreaPoint
  status: 'covered' | 'shared-zone' | 'unresolved'
  proposalIds: string[]
}
export interface AreaCoverage {
  /** Label coverage is not a claim that all rooms or all boundaries are correct. */
  labels: AreaCoverageLabel[]
}
export function assessAreaCoverage(runs: TextRun[], proposals: AreaProposal[]): AreaCoverage {
  const labels = areaTextRuns(runs).flatMap(run => {
    const label = areaRoomLabel(run.text)
    if (!label) return []
    const point: AreaPoint = [run.x + run.w / 2, run.y + run.h / 2]
    const proposalIds = proposals.filter(p => containsPoint(point, p.points) && !p.holes.some(h => containsPoint(point, h))).map(p => p.id)
    return [{ label, point, proposalIds }]
  })
  const counts = new Map<string, number>()
  for (const label of labels) for (const id of label.proposalIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  return { labels: labels.map(label => ({ ...label, status: label.proposalIds.length !== 1 ? 'unresolved' : (counts.get(label.proposalIds[0]) ?? 0) > 1 ? 'shared-zone' : 'covered' })) }
}

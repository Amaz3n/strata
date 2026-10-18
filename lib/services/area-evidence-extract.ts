import "server-only"
import type * as MuPDF from "mupdf"
import { AREA_EVIDENCE_VERSION, AREA_EXTRACTION_PROFILE, type AreaEvidence, type EvidencePath, type PathCommand } from "@/lib/drawings/area-evidence"
import { areaPathRole } from '@/lib/drawings/area-paths'

/** Preserve path identity and all cubic controls before snapping/noise filtering. */
export function extractAreaEvidence(mupdf: typeof MuPDF, page: MuPDF.Page, transform: {
  pageToImageScale: number; imageWidth: number; imageHeight: number; pageOriginX?: number; pageOriginY?: number
}): AreaEvidence {
  const result: AreaEvidence = { version: AREA_EVIDENCE_VERSION, extractionProfile: AREA_EXTRACTION_PROFILE, paths: [], truncated: false, unrepresentedPaint: false, omittedDecorationPaths: 0 }
  const clips: number[] = [], layers: string[] = [], groups: number[] = []
  let groupId = 0
  const budgets = new Map<string, { paths: number; commands: number }>()
  const record = (path: MuPDF.Path, ctm: MuPDF.Matrix, attributes: Partial<EvidencePath>): number => {
    const role = attributes.kind === 'clip' ? 'clip' : areaPathRole({ layer: layers })
    const budget = budgets.get(role) ?? { paths: 0, commands: 0 }
    budgets.set(role, budget)
    const exhausted = () => {
      if (role === 'decoration') { result.omittedDecorationPaths = (result.omittedDecorationPaths ?? 0) + 1; result.unrepresentedPaint = true }
      else result.truncated = true
    }
    // Independent budgets prevent early furniture/hatch paint starving walls.
    // Never expose a partially captured path or a missing clip as complete.
    if (budget.paths >= (role === 'decoration' ? 50_000 : 100_000) || budget.commands >= 1_000_000) { exhausted(); return -1 }
    const commands: PathCommand[] = []
    const point = (x: number, y: number): [number, number] => [
      ((ctm[0] * x + ctm[2] * y + ctm[4] - (transform.pageOriginX ?? 0)) * transform.pageToImageScale) / transform.imageWidth,
      ((ctm[1] * x + ctm[3] * y + ctm[5] - (transform.pageOriginY ?? 0)) * transform.pageToImageScale) / transform.imageHeight,
    ]
    const push = (command: PathCommand) => {
      if (commands.length <= 1_000_000 - budget.commands) commands.push(command)
    }
    path.walk({
      moveTo: (x, y) => push(["M", ...point(x, y)]),
      lineTo: (x, y) => push(["L", ...point(x, y)]),
      curveTo: (a, b, c, d, e, f) => push(["C", ...point(a, b), ...point(c, d), ...point(e, f)]),
      closePath: () => push(["Z"]),
    })
    if (commands.length > 1_000_000 - budget.commands) { exhausted(); return -1 }
    budget.paths++; budget.commands += commands.length
    const id = result.paths.length
    result.paths.push({ id, commands, kind: "stroke", color: [], colorSpace: "", opacity: 1,
      width: 0, dashes: [], layer: [...layers], groups: [...groups], clips: [...clips], evenOdd: false, ...attributes })
    return id
  }
  const device = new mupdf.Device({
    strokePath: (path, stroke, ctm, space, color, opacity) => {
      record(path, ctm, { kind: "stroke", color, colorSpace: space.getName(), opacity,
        width: stroke.getLineWidth() * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])), dashes: stroke.getDashes() ?? [] })
    },
    fillPath: (path, evenOdd, ctm, space, color, opacity) => { record(path, ctm, { kind: "fill", evenOdd, color, colorSpace: space.getName(), opacity }) },
    clipPath: (path, evenOdd, ctm) => { clips.push(record(path, ctm, { kind: "clip", evenOdd })) },
    clipStrokePath: () => { clips.push(-1) },
    clipText: () => { clips.push(-1) },
    clipStrokeText: () => { clips.push(-1) },
    clipImageMask: () => { clips.push(-1) },
    popClip: () => { clips.pop() },
    beginLayer: (name) => { layers.push(name) },
    endLayer: () => { layers.pop() },
    beginGroup: () => { groups.push(++groupId) },
    endGroup: () => { groups.pop() },
    fillImage: () => { result.unrepresentedPaint = true },
    fillImageMask: () => { result.unrepresentedPaint = true },
    fillShade: () => { result.unrepresentedPaint = true },
    beginMask: () => { result.unrepresentedPaint = true },
  })
  try { page.runPageContents(device, mupdf.Matrix.identity) } finally { device.close(); device.destroy() }
  return result
}

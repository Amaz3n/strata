/**
 * The drawings workspace has no modes. One dock of tools is always there; a
 * measuring tool always measures INTO a takeoff item, and the item is chosen
 * the moment the tool is picked. These are the tools and the vocabulary every
 * part of the workspace shares.
 */

import type { MeasureToolType } from "../viewer/use-measure-tools"
import type { ConditionUom, MeasureUom } from "@/lib/drawings/measure"

export type WorkspaceTool =
  | "select"
  | "pan"
  | "length"
  | "area"
  | "count"
  | "ruler"
  | "redline"
  | "issue"

export type MeasuringTool = Extract<WorkspaceTool, "length" | "area" | "count">

export type RedlineKind = "cloud" | "arrow" | "text" | "freehand"

export type WorkspaceView = "sheet" | "split" | "3d"

/** Redlines are red. One colour is the convention on every set of drawings. */
export const REDLINE_COLOR = "#CC272E"
export const REDLINE_STROKE = 3

/** What a measuring tool measures on the sheet. */
export const TOOL_SOURCE_UOM: Record<MeasuringTool, MeasureUom> = {
  length: "lf",
  area: "sf",
  count: "ea",
}

/** The measure-tools hook's name for each measuring tool. */
export const TOOL_MEASURE_TYPE: Record<Exclude<MeasuringTool, "count">, MeasureToolType> = {
  length: "polyline",
  area: "area",
}

/** The tool that measures a condition whose members measure in `source`. */
export function toolForSourceUom(source: MeasureUom): MeasuringTool {
  return source === "lf" ? "length" : source === "sf" ? "area" : "count"
}

/** The unit a brand-new item gets when it is created from a tool. */
export const TOOL_DEFAULT_UOM: Record<MeasuringTool, ConditionUom> = {
  length: "lf",
  area: "sf",
  count: "ea",
}

export const TOOL_LABELS: Record<WorkspaceTool, string> = {
  select: "Select",
  pan: "Pan",
  length: "Length",
  area: "Area",
  count: "Count",
  ruler: "Ruler",
  redline: "Redline",
  issue: "Issue or photo",
}

export const TOOL_KEYS: Record<WorkspaceTool, string> = {
  select: "V",
  pan: "H",
  length: "L",
  area: "A",
  count: "C",
  ruler: "R",
  redline: "M",
  issue: "I",
}

export const VIEW_LABELS: Record<WorkspaceView, string> = {
  sheet: "Sheet",
  split: "Split",
  "3d": "3D",
}

export const WORKSPACE_SHORTCUTS: Array<{ keys: string[]; description: string }> = [
  { keys: ["V"], description: "Select" },
  { keys: ["H", "Space"], description: "Pan (hold Space)" },
  { keys: ["L"], description: "Measure a length" },
  { keys: ["A"], description: "Measure an area" },
  { keys: ["C"], description: "Count" },
  { keys: ["R"], description: "Ruler — nothing is saved" },
  { keys: ["M"], description: "Redline" },
  { keys: ["I"], description: "Pin an issue or photo" },
  { keys: ["Enter"], description: "Finish the shape" },
  { keys: ["Backspace"], description: "Remove the last point" },
  { keys: ["Esc"], description: "Stop, then close" },
  { keys: ["1", "2", "3"], description: "Sheet, split, 3D" },
  { keys: ["[", "]"], description: "Previous / next sheet" },
  { keys: ["/"], description: "Find on this sheet" },
  { keys: ["+", "-"], description: "Zoom" },
  { keys: ["0"], description: "Fit the sheet" },
  { keys: ["W"], description: "Walk the model (pointer over 3D)" },
  { keys: ["\\"], description: "Hide the interface" },
  { keys: ["?"], description: "These shortcuts" },
]

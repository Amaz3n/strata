import type { TextRun } from "./text-runs";
import { normalizeFeetInchesText, parseFeetInches } from "../validation/drawings";

/** A versioned source, not a filename: marks can be reused by other revisions. */
export interface ScheduleTextPage {
  sourceId: string;
  pageNumber?: number;
  textRuns: TextRun[];
}
export interface ScheduleCell {
  text: string;
  runIndices: number[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
}
export interface WindowScheduleRow {
  sourceId: string;
  pageNumber?: number;
  titleRunIndex: number;
  headerRunIndices: number[];
  mark: string;
  cells: {
    mark: ScheduleCell;
    width: ScheduleCell | null;
    height: ScheduleCell | null;
    type: ScheduleCell | null;
    quantity: ScheduleCell | null;
    notes: ScheduleCell | null;
    sizeBasis: ScheduleCell | null;
    transom: ScheduleCell | null;
    transomSize: ScheduleCell | null;
    headReference: ScheduleCell | null;
  };
  /** Printed sizes. Never substitute these for a measured wall cutout. */
  scheduledWidthFt: number | null;
  scheduledHeightFt: number | null;
  dimensionBasis: "unit-size" | "rough-opening" | "unspecified";
  quantity: number | null;
  issues: string[];
}
export interface WindowScheduleExtraction {
  rows: WindowScheduleRow[];
  issues: Array<{ sourceId: string; titleRunIndex: number; message: string }>;
}
type Run = TextRun & { index: number };
type Header = { text: string; x: number; y: number; h: number; index: number };
const centerX = (r: TextRun) => r.x + r.w / 2;
const centerY = (r: TextRun) => r.y + r.h / 2;
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();
const titlePattern = /^WINDOW\s+SCHEDULE(?:\s*[-–:]\s*.+)?$/i;
const markPattern = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

/** Require explicit units; a bare 2040/3050 is not a decimal-foot dimension. */
export function scheduleDimensionFt(text: string): number | null {
  const clean = normalizeFeetInchesText(text);
  if (!/(?:['"]|\bft\b|\bfeet\b|\bin\b|\binches\b)/.test(clean)) return null;
  return parseFeetInches(clean);
}
function pairedDimensions(text: string): [number | null, number | null] {
  // Explicit axis labels are required: do not guess the order of a bare WxH
  // product code, nor silently discard a multiplier or transom qualification.
  const pair = text.trim().match(/^(.+?)\s*w\s*[x×]\s*(.+?)\s*h$/i);
  return pair ? [scheduleDimensionFt(pair[1]), scheduleDimensionFt(pair[2])] : [null, null];
}
function cell(runs: Run[]): ScheduleCell | null {
  if (!runs.length) return null;
  const ordered = [...runs].sort((a, b) => a.x - b.x || a.index - b.index);
  return {
    text: ordered.map(r => r.text.trim()).join(" "),
    runIndices: ordered.map(r => r.index),
    bounds: {
      x0: Math.min(...runs.map(r => r.x)), y0: Math.min(...runs.map(r => r.y)),
      x1: Math.max(...runs.map(r => r.x + r.w)), y1: Math.max(...runs.map(r => r.y + r.h)),
    },
  };
}

/** Conservative positional extraction for horizontal, text-backed schedules.
 * Text order in a PDF is not row order. Locate an explicit title + aligned
 * MARK/WIDTH/HEIGHT columns, then bind cells by position. Unsupported layouts
 * remain unresolved. HEAD/JAMB/SILL detail references are never elevations.
 * The caller must supply pages from the intended drawing revision/scope.
 */
export function extractWindowSchedules(pages: ScheduleTextPage[]): WindowScheduleExtraction {
  const result: WindowScheduleExtraction = { rows: [], issues: [] };
  for (const page of pages) {
    if (!page.sourceId.trim()) continue;
    const runs: Run[] = page.textRuns.map((r, index) => ({ ...r, index })).filter(r =>
      r.text.trim() && [r.x, r.y, r.w, r.h].every(Number.isFinite) &&
      r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1.00001 && r.y + r.h <= 1.00001);
    const titles = runs.filter(r => titlePattern.test(normalize(r.text)));
    for (const title of titles) {
      const issue = (message: string) => result.issues.push({ sourceId: page.sourceId, titleRunIndex: title.index, message });
      if (title.w < title.h * 2) { issue("Rotated window schedule text needs an aligned source before extraction."); continue; }
      const rightTableEdge = runs.filter(r => /\bSCHEDULE\b/i.test(r.text) && r.index !== title.index &&
        Math.abs(centerY(r) - centerY(title)) < Math.max(r.h, title.h) * 2 && r.x > title.x + title.w)
        .reduce((x, r) => Math.min(x, r.x), 1);
      const leftTableEdge = runs.filter(r => /\bSCHEDULE\b/i.test(r.text) && r.index !== title.index &&
        Math.abs(centerY(r) - centerY(title)) < Math.max(r.h, title.h) * 2 && r.x + r.w < title.x)
        .reduce((x, r) => Math.max(x, r.x + r.w), 0);
      const sizeGroups = runs.filter(r => /^(UNIT SIZE|NOMINAL SIZE|ROUGH OPENING|WINDOW SIZE)$/i.test(normalize(r.text)));
      // Split only a run made entirely of header words (common PDF exports
      // combine WIDTH HEIGHT). Approximate token centers locate columns only;
      // the exact original run indices remain the evidence.
      const headers: Header[] = runs.flatMap(r => {
        const clean = normalize(r.text);
        if (/^(WINDOW SIZE|ROOM NAME|NOTE\/REMARKS|MFR\. & SERIES)$/.test(clean)) return [{text:clean === 'WINDOW SIZE' ? 'DIMENSIONS' : clean === 'NOTE/REMARKS' ? 'NOTES' : clean, x:centerX(r), y:centerY(r),h:r.h,index:r.index}];
        const words = clean.split(" ");
        if (!words.every(w => /^(MARK|ID|TAG|W|H|WIDTH|HEIGHT|TYPE|QTY\.?|QUANTITY|SIZE|MATL|GLAZING|HEAD|JAMB|SILL|NOTES|REMARKS|RATED|Y\/N|MANUFACTURER|EGRESS)$/.test(w))) return [];
        let offset = 0;
        return words.flatMap(word => {
          const x = r.x + r.w * (offset + word.length / 2) / normalize(r.text).length;
          offset += word.length + 1;
          if ((word === 'W' || word === 'H') && !sizeGroups.some(g => g.y < r.y && r.y - g.y < r.h * 3 && x >= g.x - r.h && x <= g.x + g.w + r.h)) return [];
          const headHeight = word === 'HEIGHT' && runs.some(g => normalize(g.text) === 'HEAD' && g.y < r.y && r.y - g.y < r.h * 1.5 && Math.abs(centerX(g)-x) < r.h);
          return [{ text: headHeight ? 'HEAD_HEIGHT' : /^(ID|TAG)$/.test(word) ? 'MARK' : word === 'W' ? 'WIDTH' : word === 'H' ? 'HEIGHT' : word === 'REMARKS' ? 'NOTES' : word, x, y: centerY(r), h: r.h, index: r.index }];
        });
      });
      const marks = headers.filter(h => h.text === "MARK" && h.y > title.y + title.h &&
        h.y < title.y + title.h * 8 && h.x >= leftTableEdge && h.x <= title.x + title.w);
      const candidates = marks.flatMap(mark => {
        const row = headers.filter(h => Math.abs(h.y - mark.y) <= Math.min(h.h, mark.h) * (h.text === 'NOTES' ? 1 : .4) && h.x >= mark.x && h.x < rightTableEdge)
          .sort((a, b) => a.x - b.x);
        // A neighboring table starts at another MARK column.
        const nextMark = row.findIndex((h, i) => i > 0 && h.text === "MARK");
        const columns = nextMark < 0 ? row : row.slice(0, nextMark);
        const separate = !columns.some(h => h.text === 'DIMENSIONS') && columns.filter(h => h.text === "WIDTH").length === 1 && columns.filter(h => h.text === "HEIGHT").length === 1;
        const combined = !columns.some(h => h.text === 'WIDTH' || h.text === 'HEIGHT') && columns.filter(h => h.text === 'DIMENSIONS').length === 1;
        return (separate || combined) && columns.at(-1)!.x >= title.x
          ? [{ mark, columns }] : [];
      });
      if (candidates.length !== 1) { issue("Window schedule columns could not be identified uniquely."); continue; }
      const { mark, columns } = candidates[0];
      const column = (name: string) => columns.findIndex(h => h.text === name);
      const combined = column('DIMENSIONS') >= 0;
      const dimensionColumns = columns.filter(h => combined ? h.text === 'DIMENSIONS' : h.text === 'WIDTH' || h.text === 'HEIGHT');
      const dimensionLeft = Math.min(...dimensionColumns.map(h => h.x)), dimensionRight = Math.max(...dimensionColumns.map(h => h.x));
      const basisRuns = sizeGroups.filter(g => g.y < mark.y && mark.y - g.y < mark.h * 3 &&
        g.x - mark.h <= dimensionLeft && g.x + g.w + mark.h >= dimensionRight && normalize(g.text) !== 'WINDOW SIZE');
      const sizeBasis = cell(basisRuns);
      const dimensionBasis = basisRuns.length === 1 ? (normalize(basisRuns[0].text) === 'ROUGH OPENING' ? 'rough-opening' : 'unit-size') : 'unspecified';
      const range = (i: number): [number, number] => [
        i ? (columns[i - 1].x + columns[i].x) / 2 : columns[i].x - (columns[i + 1].x - columns[i].x) / 2,
        i + 1 < columns.length ? (columns[i].x + columns[i + 1].x) / 2 : columns[i].x + (columns[i].x - columns[i - 1].x) / 2,
      ];
      const [markLeft, markRight] = range(0);
      const nextTitleY = runs.filter(r => /\b(?:SCHEDULE|NOTES)\s*$/i.test(r.text.trim()) && r.y > mark.y &&
        r.x <= dimensionRight && r.x + r.w >= markLeft).reduce((y, r) => Math.min(y, r.y), 1);
      const rowMarks = runs.filter(r => centerX(r) >= markLeft && centerX(r) < markRight &&
        centerY(r) > mark.y + mark.h * .8 && centerY(r) < nextTitleY && markPattern.test(normalize(r.text)))
        .sort((a, b) => centerY(a) - centerY(b) || a.index - b.index);
      let previousY = mark.y, count = 0;
      for (const rowMark of rowMarks) {
        const y = centerY(rowMark);
        if (y - previousY > mark.h * 4 || count >= 500) break;
        previousY = y;
        const rowRuns = runs.filter(r => Math.abs(centerY(r) - y) <= Math.min(r.h, rowMark.h) * .4);
        const read = (name: string) => {
          const i = column(name);
          if (i < 0) return null;
          const [left, right] = range(i);
          // Remarks are commonly left aligned in a wide column whose header
          // is centered. A midpoint between header centers cuts off legitimate
          // notes. Keep the prior header's actual right edge as a lower bound.
          const preceding = i ? runs.find(r => r.index === columns[i - 1].index) : undefined;
          const notesLeft = preceding ? Math.min(left, preceding.x + preceding.w) : left;
          return cell(rowRuns.filter(r => name === 'NOTES' ? r.x >= notesLeft && r.x < right && r.x + r.w <= rightTableEdge : centerX(r) >= left && centerX(r) < right));
        };
        const width = read(combined ? 'DIMENSIONS' : "WIDTH"), height = read(combined ? 'DIMENSIONS' : "HEIGHT");
        // A letter in a note below the table is not a schedule row.
        if (!width && !height) break;
        const markCell = read("MARK")!;
        const quantity = read(columns.some(h => h.text === "QUANTITY") ? "QUANTITY" : columns.some(h => h.text === "QTY.") ? "QTY." : "QTY");
        const notes = read('NOTES');
        const issues: string[] = [];
        if (notes && /(?:…|\.{3})\s*$/.test(notes.text)) issues.push("The source note is truncated; check the referenced detail before applying these sizes.");
        if (basisRuns.length > 1) issues.push("More than one size basis applies to these columns; confirm the intended dimensions.");
        const [scheduledWidthFt, scheduledHeightFt] = combined ? pairedDimensions(width?.text ?? '') : [width ? scheduleDimensionFt(width.text) : null, height ? scheduleDimensionFt(height.text) : null];
        if (scheduledWidthFt === null) issues.push("Scheduled width is missing, variable or unsupported.");
        if (scheduledHeightFt === null) issues.push("Scheduled height is missing, variable or unsupported.");
        if (markCell.runIndices.length !== 1) issues.push("Schedule mark has overlapping or combined source text.");
        const n = quantity && /^\d+$/.test(quantity.text) ? Number(quantity.text) : null;
        const parsedQuantity = n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
        if (quantity && parsedQuantity === null) issues.push("Scheduled quantity could not be read as a positive count.");
        result.rows.push({
          sourceId: page.sourceId, pageNumber: page.pageNumber, titleRunIndex: title.index,
          headerRunIndices: [...new Set(columns.map(h => h.index))], mark: normalize(rowMark.text),
          cells: { mark: markCell, width, height, type: read("TYPE"), quantity, notes, sizeBasis,
            transom: read('Y/N'), transomSize: read('SIZE'), headReference: read(column('HEAD_HEIGHT') >= 0 ? 'HEAD_HEIGHT' : 'HEAD') },
          scheduledWidthFt, scheduledHeightFt, dimensionBasis, quantity: parsedQuantity, issues,
        });
        count++;
      }
      if (!count) issue("Window schedule header was found, but no supported rows were readable.");
    }
  }
  const byMark = new Map<string, WindowScheduleRow[]>();
  for (const row of result.rows) byMark.set(row.mark, [...(byMark.get(row.mark) ?? []), row]);
  for (const rows of byMark.values()) if (rows.length > 1) {
    for (const row of rows) row.issues.push("This mark occurs more than once in the supplied schedule scope; select the applicable source.");
  }
  return result;
}

/** An exact tag resolves a row only inside the explicitly supplied scope.
 * Duplicate marks stay ambiguous even when their dimensions happen to agree.
 */
export function resolveWindowScheduleMark(rows: WindowScheduleRow[], mark: string):
  { status: "missing" | "ambiguous"; rows: WindowScheduleRow[] } | { status: "matched"; row: WindowScheduleRow } {
  const matches = rows.filter(row => row.mark === normalize(mark));
  if (!matches.length) return { status: "missing", rows: [] };
  if (matches.length !== 1 || matches[0].cells.mark.runIndices.length !== 1) return { status: "ambiguous", rows: matches };
  return { status: "matched", row: matches[0] };
}

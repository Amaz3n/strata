import type { TextRun } from './text-runs'
import { roomLabelFromText, ROOM_NAME_LEXICON } from './room-names'
const words=new Set([...ROOM_NAME_LEXICON,'ROOM','ROOMS','MAIN','SECOND','FIRST','UPPER','LOWER','WALK','IN','LINEN','TOILET','WC','CL','OUTDOOR','POOL'])
/** Annotation sentences containing a room noun are not room tags. */
export function areaRoomLabel(raw:string):string|null {
  const possessive=raw.trim().match(/^(HIS|HERS)\s+(.+)$/i)
  if(possessive){const name=areaRoomLabel(possessive[2]);return name&&/^(?:WIC|CLOSET|BATH(?:ROOM)?)(?:\s+\d+[A-Z]?)?$/.test(name)?`${possessive[1].toUpperCase()} ${name}`:null}
  const generic = raw.trim().match(/^(ROOM|CORRIDOR)(?:\s+(\d+[A-Z]?))?$/i)
  if (generic) return generic[1].toUpperCase() + (generic[2] ? ` ${generic[2]}` : '')
  // Standalone abbreviations only: do not turn keynote prose into room tags.
  const abbreviation = raw.trim().match(/^(CL\.?|W\.?I\.?C\.?|(?:PWDR|PDR)\.?)(?:\s+(\d+[A-Z]?))?$/i)
  if (abbreviation && (!/^CL/i.test(abbreviation[1]) || abbreviation[2])) {
    const name = /^CL/i.test(abbreviation[1]) ? 'CLOSET' : /^W/i.test(abbreviation[1]) ? 'WIC' : 'POWDER'
    return name + (abbreviation[2] ? ` ${abbreviation[2]}` : '')
  }
  const label=roomLabelFromText(raw)
  if(!label)return null
  const tokens=label.toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  if(tokens.some(t=>!words.has(t)))return null
  return label.replace(/\/+$/,'').trim()
}

/** Join only aligned, adjacent lines of conventional room tags. This preserves
 * OUTDOOR LIVING versus LIVING without interpreting nearby keynote sentences. */
export function areaTextRuns(runs: TextRun[]): TextRun[] {
  const consumed = new Set<number>(), replacements = new Map<number, TextRun>()
  for (let i = 0; i < runs.length; i++) {
    const first = runs[i]
    const modifier = first.text.trim().replace(/[.,:;]+$/, '')
    if (!/^(OUTDOOR|COVERED|MASTER|PRIMARY|GREAT|POOL)$/i.test(modifier)) continue
    const candidates = runs.flatMap((second, j) => {
      if (i === j || consumed.has(j) || !/^(LIVING|KITCHEN|BEDROOM|ROOM|PATIO|PORCH|DINING|BATH|BATHROOM)$/i.test(second.text.trim()) || (modifier.toUpperCase() === 'POOL' && !/^BATH(?:ROOM)?$/i.test(second.text.trim()))) return []
      const dy = second.y + second.h / 2 - first.y - first.h / 2
      const dx = Math.abs(second.x + second.w / 2 - first.x - first.w / 2)
      return dy > 0 && dy <= Math.max(first.h, second.h) * 1.5 && dx <= Math.max(first.w, second.w) * .3 ? [{ j, second, dy }] : []
    }).sort((a, b) => a.dy - b.dy)
    if (candidates.length !== 1) continue
    const { j, second } = candidates[0], text = `${modifier} ${second.text.trim()}`
    if (!areaRoomLabel(text)) continue
    const x = Math.min(first.x, second.x), y = Math.min(first.y, second.y)
    const ocr = first.ocr ?? second.ocr
    replacements.set(i, { text, x, y, w: Math.max(first.x + first.w, second.x + second.w) - x, h: Math.max(first.y + first.h, second.y + second.h) - y,
      ...(ocr ? { ocr: { profile: ocr.profile, confidence: Math.min(first.ocr?.confidence ?? 100, second.ocr?.confidence ?? 100) } } : {}) })
    consumed.add(j)
  }
  return runs.flatMap((run, i) => consumed.has(i) ? [] : [replacements.get(i) ?? run])
}

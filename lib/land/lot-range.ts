export interface LotRangeInput {
  fromNumber: number
  toNumber: number
  prefix?: string
  phaseId?: string | null
  takedownId?: string | null
}

export interface ExpandedLotRangeItem {
  lotNumber: string
  phaseId: string | null
  takedownId: string | null
}

export function expandLotRange(input: LotRangeInput): ExpandedLotRangeItem[] {
  if (!Number.isInteger(input.fromNumber) || !Number.isInteger(input.toNumber)) {
    throw new Error("Lot range bounds must be whole numbers.")
  }
  if (input.fromNumber < 0 || input.toNumber < input.fromNumber) {
    throw new Error("Lot range bounds are invalid.")
  }
  const count = input.toNumber - input.fromNumber + 1
  if (count > 500) {
    throw new Error("A lot range may contain at most 500 lots.")
  }
  const prefix = input.prefix?.trim() ?? ""
  return Array.from({ length: count }, (_, index) => ({
    lotNumber: `${prefix}${input.fromNumber + index}`,
    phaseId: input.phaseId ?? null,
    takedownId: input.takedownId ?? null,
  }))
}

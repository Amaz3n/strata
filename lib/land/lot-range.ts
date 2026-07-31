import type { LotStatus } from "@/lib/land/lot-lifecycle"

export interface LotRangeInput {
  fromNumber: number
  toNumber: number
  /** Recorded block, kept out of the lot number so the plat can group by it. */
  block?: string | null
  phaseId?: string | null
  takedownId?: string | null
  status?: LotStatus
  /** Street name for generated addresses; without it no address is written. */
  street?: string | null
  /** House number of the first lot in the range. */
  addressFrom?: number | null
  /** Usually 1, or 2 where one side of the street is odd and the other even. */
  addressStep?: number
  widthFt?: number | null
  depthFt?: number | null
  costBasisCents?: number | null
}

export interface ExpandedLotRangeItem {
  lotNumber: string
  block: string | null
  address: string | null
  phaseId: string | null
  takedownId: string | null
  status: LotStatus
  dimensions: { widthFt?: number; depthFt?: number }
  costBasisCents: number | null
}

export const MAX_LOT_RANGE = 500

/**
 * A numbered run of lots, as recorded on a plat.
 *
 * Addresses are generated because they are sequential in practice — a phase
 * opens as "4100, 4102, 4104 Cypress Landing Way" — and typing 48 of them by
 * hand is how a community ends up with none at all.
 */
export function expandLotRange(input: LotRangeInput): ExpandedLotRangeItem[] {
  if (!Number.isInteger(input.fromNumber) || !Number.isInteger(input.toNumber)) {
    throw new Error("Lot range bounds must be whole numbers.")
  }
  if (input.fromNumber < 0 || input.toNumber < input.fromNumber) {
    throw new Error("Lot range bounds are invalid.")
  }
  const count = input.toNumber - input.fromNumber + 1
  if (count > MAX_LOT_RANGE) {
    throw new Error(`A lot range may contain at most ${MAX_LOT_RANGE} lots.`)
  }

  const block = input.block?.trim() || null
  const street = input.street?.trim() || null
  const step = input.addressStep && input.addressStep > 0 ? Math.floor(input.addressStep) : 1
  const dimensions: { widthFt?: number; depthFt?: number } = {}
  if (input.widthFt != null) dimensions.widthFt = input.widthFt
  if (input.depthFt != null) dimensions.depthFt = input.depthFt

  return Array.from({ length: count }, (_, index) => ({
    lotNumber: String(input.fromNumber + index),
    block,
    address:
      street && input.addressFrom != null ? `${input.addressFrom + index * step} ${street}` : null,
    phaseId: input.phaseId ?? null,
    takedownId: input.takedownId ?? null,
    status: input.status ?? "controlled",
    dimensions,
    costBasisCents: input.costBasisCents ?? null,
  }))
}

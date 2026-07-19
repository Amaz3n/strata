import { createHash } from "node:crypto"

export type PoGenerationResolvedLine = {
  sourceKind: "takeoff_line" | "option"
  sourceId: string
  companyId: string
  companyName: string
  agreementId: string
  costCodeId: string
  costType?: string | null
  description: string
  quantity: number
  unit: string
  unitCostCents: number
  totalCents: number
  scopeText?: string
  optionDescriptor?: string
}

export type GeneratedPoGroup = {
  companyId: string
  companyName: string
  totalCents: number
  sourceAgreementIds: string[]
  lines: PoGenerationResolvedLine[]
}

export type GeneratedBudgetGroup = {
  costCodeId: string
  costType: string | null
  description: string
  amountCents: number
  sourceIds: string[]
}

export function groupPurchaseOrderLines(lines: PoGenerationResolvedLine[]): GeneratedPoGroup[] {
  const groups = new Map<string, GeneratedPoGroup>()
  for (const line of lines) {
    const group = groups.get(line.companyId) ?? {
      companyId: line.companyId,
      companyName: line.companyName,
      totalCents: 0,
      sourceAgreementIds: [],
      lines: [],
    }
    group.lines.push(line)
    group.totalCents += line.totalCents
    if (!group.sourceAgreementIds.includes(line.agreementId)) group.sourceAgreementIds.push(line.agreementId)
    groups.set(line.companyId, group)
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      sourceAgreementIds: group.sourceAgreementIds.sort(),
      lines: group.lines.sort((a, b) => `${a.costCodeId}|${a.sourceId}`.localeCompare(`${b.costCodeId}|${b.sourceId}`)),
    }))
    .sort((a, b) => a.companyId.localeCompare(b.companyId))
}

export function groupGeneratedBudgetLines(lines: PoGenerationResolvedLine[]): GeneratedBudgetGroup[] {
  const groups = new Map<string, GeneratedBudgetGroup>()
  for (const line of lines) {
    const key = `${line.costCodeId}|${line.costType ?? ""}`
    const group = groups.get(key) ?? {
      costCodeId: line.costCodeId,
      costType: line.costType ?? null,
      description: line.description,
      amountCents: 0,
      sourceIds: [],
    }
    group.amountCents += line.totalCents
    group.sourceIds.push(`${line.sourceKind}:${line.sourceId}`)
    groups.set(key, group)
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, sourceIds: group.sourceIds.sort() }))
    .sort((a, b) => `${a.costCodeId}|${a.costType ?? ""}`.localeCompare(`${b.costCodeId}|${b.costType ?? ""}`))
}

export type PoFingerprintInput = {
  asOfDate: string
  lines: Array<{
    sourceKind: "takeoff_line" | "option"
    sourceId: string
    quantity: number
    unit: string
    agreementId?: string | null
    totalCents?: number | null
  }>
}

export function createPoGenerationFingerprint(input: PoFingerprintInput) {
  const canonical = {
    asOfDate: input.asOfDate,
    lines: input.lines
      .map((line) => ({
        sourceKind: line.sourceKind,
        sourceId: line.sourceId,
        quantity: line.quantity,
        unit: line.unit.trim().toLowerCase(),
        agreementId: line.agreementId ?? null,
        totalCents: line.totalCents ?? null,
      }))
      .sort((a, b) => `${a.sourceKind}|${a.sourceId}`.localeCompare(`${b.sourceKind}|${b.sourceId}`)),
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

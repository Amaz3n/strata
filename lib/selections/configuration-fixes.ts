import { evaluateConfigurationRules, type ConfigurationRule, type ConfigurationViolation } from "@/lib/selections/configuration-rules"

/**
 * Fix-it suggestions for a configuration that breaks a rule ("the chef kitchen
 * requires the electrical upgrade"). Every suggestion is proven by re-running
 * the rules on the configuration it would produce: a fix is offered only when
 * it clears the rule it targets and introduces no conflict that was not there
 * before. A suggestion is advice, never authority — applying one goes through
 * the same mutation a person would use, which re-checks locks and rules.
 */

/** Why a change cannot be made in place; the change-order path owns it. */
export type ConfigurationLockReason = "cutoff" | "structural" | "confirmed" | "locked"

export type ConfigurationFixOption = {
  name: string
  /** Every selection category the option is accepted in (base and community). */
  categoryIds: string[]
  /** The canonical option a community override stands in for; rules are written against it. */
  parentOptionId: string | null
  /** Draft only: one choice per category, so choosing it replaces a sibling instead of joining it. */
  exclusive: boolean
}

/** A home's selection: one category, one chosen (effective) option. */
export type ConfigurationFixSlot = { selectionId: string; categoryId: string; optionId: string | null }

/** A draft agreement line as the draft names it (option or package), with the effective options it puts on the home. */
export type ConfigurationFixPick = { optionId?: string; packageId?: string; name: string; optionIds: string[] }

export type ConfigurationFixInput = {
  violations: ConfigurationViolation[]
  rules: ConfigurationRule[]
  optionMeta: Record<string, ConfigurationFixOption>
  /** Effective option IDs that may be chosen in this scope. */
  availableOptionIds: string[]
  /** Price in cents by option or package ID. */
  prices: Record<string, number>
  /** Home: changes land in these selections. */
  slots?: ConfigurationFixSlot[]
  /** Draft: changes add and remove these lines. Ignored when `slots` is given. */
  picks?: ConfigurationFixPick[]
  locks?: {
    bySelectionId?: Record<string, ConfigurationLockReason>
    /** Options a binding agreement has frozen on this home. */
    structuralOptionIds?: string[]
  }
}

export type ConfigurationFix = {
  /** Stable for the same change, so a server can recognise a fix it suggested. */
  id: string
  kind: "add_option" | "remove_option" | "swap_option"
  label: string
  /** Rule IDs this fix clears. */
  resolves: string[]
  /** Home fixes: the selection the change lands in. */
  selectionId: string | null
  add: { optionId: string; name: string } | null
  remove: { optionId?: string; packageId?: string; name: string } | null
  priceDeltaCents: number
  /** What is still wrong after the fix — only conflicts that already existed. */
  resultingViolations: ConfigurationViolation[]
  blockedBy: ConfigurationLockReason | null
  applicable: boolean
}

const FIXES_PER_VIOLATION = 4

type Change = {
  kind: ConfigurationFix["kind"]
  selectionId: string | null
  add: { optionId: string; name: string } | null
  remove: { optionId?: string; packageId?: string; name: string } | null
  next: string[]
  touchedOptionIds: string[]
}

export function suggestConfigurationFixes(input: ConfigurationFixInput): ConfigurationFix[] {
  if (!input.violations.length) return []
  const meta = (optionId: string): ConfigurationFixOption =>
    input.optionMeta[optionId] ?? { name: "Option", categoryIds: [], parentOptionId: null, exclusive: false }
  const canonical = (optionId: string) => meta(optionId).parentOptionId ?? optionId
  const matches = (optionId: string, ruleOptionId: string) => optionId === ruleOptionId || canonical(optionId) === ruleOptionId
  const evaluate = (optionIds: string[]) =>
    evaluateConfigurationRules([...optionIds, ...optionIds.map(canonical)], input.rules)
  const price = (id: string | undefined) => (id ? input.prices[id] ?? 0 : 0)
  const available = input.availableOptionIds
  const slots = input.slots
  const picks = slots ? [] : input.picks ?? []
  const current = slots
    ? slots.flatMap((slot) => (slot.optionId ? [slot.optionId] : []))
    : [...new Set(picks.flatMap((pick) => pick.optionIds))]
  const before = new Set(input.violations.map((violation) => violation.id))
  const structural = new Set(input.locks?.structuralOptionIds ?? [])

  const withoutPick = (pick: ConfigurationFixPick) =>
    [...new Set(picks.filter((other) => other !== pick).flatMap((other) => other.optionIds))]

  /** Put `optionId` on the home: into its selection, or as a new draft line. */
  function addChanges(optionId: string): Change[] {
    const option = meta(optionId)
    const added = { optionId, name: option.name }
    if (slots) {
      const slot = slots.find((candidate) => !candidate.optionId && option.categoryIds.includes(candidate.categoryId))
        ?? slots.find((candidate) => option.categoryIds.includes(candidate.categoryId))
      if (!slot || slot.optionId === optionId) return []
      const next = slots.flatMap((candidate) => {
        const chosen = candidate === slot ? optionId : candidate.optionId
        return chosen ? [chosen] : []
      })
      return [{
        kind: slot.optionId ? "swap_option" : "add_option",
        selectionId: slot.selectionId,
        add: added,
        remove: slot.optionId ? { optionId: slot.optionId, name: meta(slot.optionId).name } : null,
        next,
        touchedOptionIds: [optionId, ...(slot.optionId ? [slot.optionId] : [])],
      }]
    }
    const sibling = option.exclusive
      ? picks.find((pick) => pick.optionId && pick.optionIds.some((own) => meta(own).exclusive && meta(own).categoryIds.some((id) => option.categoryIds.includes(id))))
      : undefined
    if (sibling) {
      return [{
        kind: "swap_option",
        selectionId: null,
        add: added,
        remove: { optionId: sibling.optionId, name: sibling.name },
        next: [...new Set([...withoutPick(sibling), optionId])],
        touchedOptionIds: [optionId, ...sibling.optionIds],
      }]
    }
    return [{ kind: "add_option", selectionId: null, add: added, remove: null, next: [...new Set([...current, optionId])], touchedOptionIds: [optionId] }]
  }

  /** Take an option off the home: swap its selection to a sibling, or drop (or swap) its draft line. */
  function removeChanges(ruleOptionId: string): Change[] {
    const alternatives = (categoryIds: string[], replaced: string) => available.filter((candidate) =>
      !current.includes(candidate) && canonical(candidate) !== canonical(replaced)
      && meta(candidate).categoryIds.some((id) => categoryIds.includes(id)))
    if (slots) {
      return slots.filter((slot) => slot.optionId && matches(slot.optionId, ruleOptionId)).flatMap((slot) => {
        const replaced = slot.optionId ?? ""
        return alternatives([slot.categoryId], replaced).map((candidate): Change => ({
          kind: "swap_option",
          selectionId: slot.selectionId,
          add: { optionId: candidate, name: meta(candidate).name },
          remove: { optionId: replaced, name: meta(replaced).name },
          next: slots.flatMap((other) => {
            const chosen = other === slot ? candidate : other.optionId
            return chosen ? [chosen] : []
          }),
          touchedOptionIds: [candidate, replaced],
        }))
      })
    }
    return picks.filter((pick) => pick.optionIds.some((optionId) => matches(optionId, ruleOptionId))).flatMap((pick) => {
      const remaining = withoutPick(pick)
      const removed = pick.optionId ? { optionId: pick.optionId, name: pick.name } : { packageId: pick.packageId, name: pick.name }
      const drop: Change = { kind: "remove_option", selectionId: null, add: null, remove: removed, next: remaining, touchedOptionIds: pick.optionIds }
      const own = pick.optionId ? pick.optionIds[0] : undefined
      if (!own) return [drop]
      const swaps = alternatives(meta(own).categoryIds, own).map((candidate): Change => ({
        kind: "swap_option",
        selectionId: null,
        add: { optionId: candidate, name: meta(candidate).name },
        remove: removed,
        next: [...new Set([...remaining, candidate])],
        touchedOptionIds: [candidate, ...pick.optionIds],
      }))
      return [drop, ...swaps]
    })
  }

  function lockOf(change: Change): ConfigurationLockReason | null {
    if (change.touchedOptionIds.some((optionId) => structural.has(optionId) || structural.has(canonical(optionId)))) return "structural"
    return change.selectionId ? input.locks?.bySelectionId?.[change.selectionId] ?? null : null
  }

  function priceDelta(change: Change) {
    const removed = change.remove ? price(change.remove.optionId ?? change.remove.packageId) : 0
    return price(change.add?.optionId) - removed
  }

  const fixes = new Map<string, ConfigurationFix>()
  for (const violation of input.violations) {
    const changes = violation.kind === "requires"
      ? [
          ...available.filter((optionId) => matches(optionId, violation.targetOptionId)).flatMap(addChanges),
          ...removeChanges(violation.sourceOptionId),
        ]
      : [...removeChanges(violation.sourceOptionId), ...removeChanges(violation.targetOptionId)]
    const proven = changes.flatMap((change) => {
      const resulting = evaluate(change.next)
      if (resulting.some((remaining) => remaining.id === violation.id || !before.has(remaining.id))) return []
      const blockedBy = lockOf(change)
      const fix: ConfigurationFix = {
        id: fixId(change),
        kind: change.kind,
        label: fixLabel(change),
        resolves: input.violations.filter((candidate) => !resulting.some((remaining) => remaining.id === candidate.id)).map((candidate) => candidate.id),
        selectionId: change.selectionId,
        add: change.add,
        remove: change.remove,
        priceDeltaCents: priceDelta(change),
        resultingViolations: resulting,
        blockedBy,
        applicable: blockedBy === null,
      }
      return [fix]
    })
    for (const fix of proven.sort(rank).slice(0, FIXES_PER_VIOLATION)) fixes.set(fix.id, fix)
  }
  return [...fixes.values()].sort(rank)
}

function rank(left: ConfigurationFix, right: ConfigurationFix) {
  return Number(right.applicable) - Number(left.applicable)
    || right.resolves.length - left.resolves.length
    || Math.abs(left.priceDeltaCents) - Math.abs(right.priceDeltaCents)
    || left.id.localeCompare(right.id)
}

function fixId(change: Change) {
  const removed = change.remove ? change.remove.optionId ?? `package:${change.remove.packageId}` : ""
  return [change.kind, change.selectionId ?? "", removed, change.add?.optionId ?? ""].join(":")
}

function fixLabel(change: Change) {
  if (change.add && change.remove) return `Switch ${change.remove.name} to ${change.add.name}`
  if (change.add) return `Add ${change.add.name}`
  return `Remove ${change.remove?.name ?? "this option"}`
}

/** Why a fix cannot be made in place, as a clause: "… because {reason}". */
export const CONFIGURATION_LOCK_REASONS: Record<ConfigurationLockReason, string> = {
  cutoff: "the selection deadline has passed",
  structural: "structural options are fixed by the signed purchase agreement",
  confirmed: "that selection is already confirmed",
  locked: "that selection is locked",
}

import type { SalesDeal } from "@/lib/services/sales-deals"

/**
 * How the button behaves. Everything the Sales desk owns happens in place; only
 * work another desk owns is a link, and only when there is somewhere real to go.
 */
export type DealPrimaryActionKind =
  | "find_home"
  | "reserve"
  | "agreement"
  | "link"
  | "none"

export interface DealPrimaryAction {
  label: string
  kind: DealPrimaryActionKind
  /** Set only for `link`. Null means the destination does not exist yet. */
  href: string | null
  hint: string
}

/**
 * The one thing to do next, gated by real state so the button never lies.
 *
 * The three transitions Sales owns — matching a buyer to a home, taking the
 * reservation, writing the agreement — happen right here, because the deal file
 * is the only page that knows which one this buyer is actually due for. They used
 * to point at the community Sales tab, which no longer exists; a primary action
 * that 404s is worse than no button at all.
 *
 * Anything another desk owns stays a link: the closing workbench owns closings,
 * Design Studio owns selection appointments. Sales points at them, it does not
 * reimplement them.
 */
export function resolveDealPrimaryAction(deal: SalesDeal): DealPrimaryAction {
  switch (deal.stage) {
    case "inquiry":
    case "working":
      return {
        label: "Find a home",
        kind: "find_home",
        href: null,
        hint: "Match this buyer to an available lot and plan.",
      }

    case "hold":
      return {
        label: "Take the reservation",
        kind: "reserve",
        href: null,
        hint: "Collect the deposit and convert the hold to a reservation.",
      }

    case "contract": {
      if (deal.contractStatus === "draft") {
        return {
          label: "View agreement",
          kind: "link",
          href: deal.projectId ? `/projects/${deal.projectId}/documents` : null,
          hint: "Out for signature — waiting on the buyer.",
        }
      }
      if (!deal.contractId) {
        // A won prospect with no reservation came through the residential
        // estimate flow; there is no reserved lot to write an agreement against.
        if (!deal.reservationId) {
          return {
            label: "Open the home",
            kind: "link",
            href: deal.projectId ? `/projects/${deal.projectId}` : null,
            hint: "Sold through the estimate flow — no lot reservation to paper.",
          }
        }
        return {
          label: "Write the purchase agreement",
          kind: "agreement",
          href: null,
          hint: "Lot is reserved and priced.",
        }
      }
      return {
        label: "Schedule the closing",
        kind: "link",
        href: deal.projectId ? `/projects/${deal.projectId}/closing` : null,
        hint: "Agreement executed — set a settlement date.",
      }
    }

    case "building":
      return {
        label: deal.closingScheduledDate ? "Open closing file" : "Schedule the closing",
        kind: "link",
        href: deal.projectId ? `/projects/${deal.projectId}/closing` : null,
        hint: "Home is under construction.",
      }

    case "closing":
      return {
        label: deal.openGateCount > 0 ? "Clear closing gates" : "Open closing file",
        kind: "link",
        href: deal.projectId ? `/projects/${deal.projectId}/closing` : null,
        hint:
          deal.openGateCount > 0
            ? `${deal.openGateCount} gate${deal.openGateCount === 1 ? "" : "s"} still blocking settlement.`
            : "Cleared to close.",
      }

    case "closed":
      return {
        label: "Open the home",
        kind: "link",
        href: deal.projectId ? `/projects/${deal.projectId}` : null,
        hint: "This sale is complete.",
      }

    case "lost":
      return {
        label: "Open the home",
        kind: "link",
        href: deal.projectId ? `/projects/${deal.projectId}` : null,
        hint: "This deal is closed out.",
      }
  }
}

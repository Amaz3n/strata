import type { ProductTier, ProjectPosture } from "@/lib/product-tier"

/**
 * The vendor family exists because the directory needed it and had nothing.
 *
 * A residential builder says "sub"; a commercial GC running CSI divisions says
 * "trade partner" and means something more formal; a production builder buying
 * against a price book calls the same company a "supplier". The directory is
 * where all three postures name the same table, so it is the surface that most
 * needs the vocabulary — and it was the one branch of the app using none of it.
 */
const TERMS = {
  residential: {
    owner: "Client",
    owners: "Clients",
    ownerPortal: "Client portal",
    fee: "Builder's fee",
    primeContract: "Contract",
    project: "Project",
    projects: "Projects",
    vendor: "Sub",
    vendors: "Subs",
    trade: "Trade",
    directory: "Directory",
  },
  commercial: {
    owner: "Owner",
    owners: "Owners",
    ownerPortal: "Owner portal",
    fee: "Fee",
    primeContract: "Prime contract",
    project: "Project",
    projects: "Projects",
    vendor: "Trade partner",
    vendors: "Trade partners",
    // Commercial estimating and prequalification both organize by CSI division.
    trade: "Division",
    directory: "Directory",
  },
  production: {
    owner: "Buyer",
    owners: "Buyers",
    ownerPortal: "Buyer portal",
    fee: "Fee",
    primeContract: "Purchase agreement",
    project: "Home",
    projects: "Homes",
    vendor: "Supplier",
    vendors: "Suppliers",
    trade: "Trade",
    directory: "Directory",
  },
} as const

export type TermKey = keyof (typeof TERMS)["residential"]
export type TerminologyPosture = ProjectPosture | ProductTier

export function terminology(posture: TerminologyPosture) {
  return TERMS[posture]
}

import type { ProductTier, ProjectPosture } from "@/lib/product-tier"

const TERMS = {
  residential: {
    owner: "Client",
    owners: "Clients",
    ownerPortal: "Client portal",
    fee: "Builder's fee",
    primeContract: "Contract",
    project: "Project",
    projects: "Projects",
  },
  commercial: {
    owner: "Owner",
    owners: "Owners",
    ownerPortal: "Owner portal",
    fee: "Fee",
    primeContract: "Prime contract",
    project: "Project",
    projects: "Projects",
  },
  production: {
    owner: "Buyer",
    owners: "Buyers",
    ownerPortal: "Buyer portal",
    fee: "Fee",
    primeContract: "Purchase agreement",
    project: "Home",
    projects: "Homes",
  },
} as const

export type TermKey = keyof (typeof TERMS)["residential"]
export type TerminologyPosture = ProjectPosture | ProductTier

export function terminology(posture: TerminologyPosture) {
  return TERMS[posture]
}

import type { EstimateCommercial } from "@/lib/financials/estimate-commercial";

/** Client-facing names; existing budget records remain compatible proposals. */
export function proposalDocumentLabel(
  commercial: Pick<EstimateCommercial, "purpose" | "maturity">,
) {
  if (commercial.purpose === "preconstruction_agreement")
    return "Preconstruction services agreement";
  // One document hardens over time: a budget while the price is soft, then the
  // proposal the client signs. The client never has to learn a third name.
  if (commercial.purpose === "construction_agreement")
    return "Proposal & agreement";
  return "Budget";
}

/** Copy content into a new document without inheriting the source's autosave identity. */
export function freshDocumentSeed<
  T extends {
    id?: string;
    status?: string;
    updated_at?: string;
    version?: number | null;
  },
>(source: T) {
  const copy = { ...source };
  delete copy.id;
  delete copy.status;
  delete copy.updated_at;
  delete copy.version;
  return copy;
}

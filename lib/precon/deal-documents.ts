import type { Estimate } from "@/lib/types";
import {
  normalizeEstimateCommercial,
  type EstimateCommercial,
} from "@/lib/financials/estimate-commercial";

export type DealDocumentPurpose = EstimateCommercial["purpose"];

/** Keep old families discoverable, but surface only one current document per purpose. */
export function dealDocumentSlot(
  estimates: Estimate[],
  purpose: DealDocumentPurpose,
) {
  const versions = estimates
    .filter(
      (document) =>
        normalizeEstimateCommercial(document.metadata).purpose === purpose,
    )
    .sort(
      (a, b) =>
        (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
        b.version - a.version ||
        b.id.localeCompare(a.id),
    );
  return {
    current: versions.find((document) => document.is_current_version !== false),
    versions,
  };
}

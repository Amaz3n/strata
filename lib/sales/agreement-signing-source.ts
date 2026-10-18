import { canonicalEvidenceJson, type EvidenceJson } from "@/lib/esign/evidence"

export type SigningContract = {
  id: string; org_id: string; project_id: string; title: string; number: string | null;
  terms: string | null; snapshot: unknown; total_cents: number; currency: string;
  effective_date: string | null; buyer_contact_id: string | null; co_buyer_contact_id: string | null;
}

/** Matches purchase_agreement_signing_input in the ownership migration. */
export function agreementSigningInput(contract: SigningContract) {
  return { id: contract.id, org_id: contract.org_id, project_id: contract.project_id, title: contract.title,
    number: contract.number, terms: contract.terms, snapshot: contract.snapshot, total_cents: contract.total_cents,
    currency: contract.currency, effective_date: contract.effective_date,
    buyer_contact_id: contract.buyer_contact_id, co_buyer_contact_id: contract.co_buyer_contact_id }
}

/** JSON object order is immaterial; array order and every source value remain exact. */
export function agreementSigningSourceMatches(savedSource: unknown, contract: SigningContract): boolean {
  try {
    return canonicalEvidenceJson(savedSource as EvidenceJson)
      === canonicalEvidenceJson(agreementSigningInput(contract) as unknown as EvidenceJson)
  } catch {
    return false
  }
}

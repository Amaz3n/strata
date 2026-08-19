/** A document the program asks for, paired with whatever is already on file. */
export interface PortalDocumentSlot {
  document_type_id: string
  name: string
  has_expiry: boolean
  is_required: boolean
  status: "pending_review" | "approved" | "rejected" | "expired" | null
  expiry_date: string | null
}

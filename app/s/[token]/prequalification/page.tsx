import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getLatestPrequalificationWithClient } from "@/lib/services/prequalification"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { PrequalificationClient } from "./prequalification-client"
import type { PortalDocumentSlot } from "./prequal-types"

interface Props {
  params: Promise<{ token: string }>
}

export default async function SubPortalPrequalificationPage({ params }: Props) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const supabase = createServiceSupabaseClient()
  const prequalification = await getLatestPrequalificationWithClient(
    supabase,
    access.org_id,
    access.company_id,
  )

  // Documents the program asks for, paired with anything already on file so the
  // vendor is not asked to upload a certificate the builder already approved.
  const typeIds = prequalification?.template.documents.map((entry) => entry.document_type_id) ?? []
  const [typesResult, documentsResult] = await Promise.all([
    typeIds.length > 0
      ? supabase.from("compliance_document_types").select("id, name, has_expiry").in("id", typeIds)
      : Promise.resolve({ data: [] }),
    typeIds.length > 0
      ? supabase
          .from("compliance_documents")
          .select("id, document_type_id, status, expiry_date, created_at")
          .eq("org_id", access.org_id)
          .eq("company_id", access.company_id)
          .in("document_type_id", typeIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ])

  const typesById = new Map(
    (typesResult.data ?? []).map((row) => [
      String(row.id),
      { name: String(row.name), hasExpiry: Boolean(row.has_expiry) },
    ]),
  )
  const today = new Date().toISOString().slice(0, 10)

  const documentSlots: PortalDocumentSlot[] = (prequalification?.template.documents ?? []).map(
    (entry) => {
      const forType = (documentsResult.data ?? []).filter(
        (row) => row.document_type_id === entry.document_type_id,
      )
      const current =
        forType.find(
          (row) =>
            row.status === "approved" && (!row.expiry_date || String(row.expiry_date) >= today),
        ) ?? forType.find((row) => row.status === "pending_review")

      return {
        document_type_id: entry.document_type_id,
        name: typesById.get(entry.document_type_id)?.name ?? "Document",
        has_expiry: typesById.get(entry.document_type_id)?.hasExpiry ?? true,
        is_required: entry.is_required,
        status: current ? (current.status as PortalDocumentSlot["status"]) : null,
        expiry_date: current?.expiry_date ? String(current.expiry_date) : null,
      }
    },
  )

  return (
    <>
      <PortalPageHeader
        title="Prequalification"
        description="What this builder needs to know about your company before awarding work."
      />
      <PrequalificationClient
        token={token}
        initial={prequalification}
        documentSlots={documentSlots}
      />
    </>
  )
}

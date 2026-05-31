import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { getOrgBranding } from "@/lib/services/estimate-portal"
import { renderEstimatePdf } from "@/lib/pdfs/estimate"
import { downloadFilesObject } from "@/lib/storage/files-storage"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { supabase, orgId } = await requireOrgContext()

  const [estimateResult, branding] = await Promise.all([
    supabase
      .from("estimates")
      .select("*, items:estimate_items(*), project:projects(name), recipient:contacts(full_name, email)")
      .eq("org_id", orgId)
      .eq("id", id)
      .single(),
    getOrgBranding(orgId, supabase),
  ])

  if (estimateResult.error || !estimateResult.data) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 })
  }

  const estimate = estimateResult.data as any
  if (estimate.executed_file_id) {
    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("storage_path, file_name, mime_type")
      .eq("org_id", orgId)
      .eq("id", estimate.executed_file_id)
      .maybeSingle()

    if (!fileError && file?.storage_path) {
      try {
        const bytes = await downloadFilesObject({ supabase, orgId, path: file.storage_path })
        return new NextResponse(new Uint8Array(bytes), {
          headers: {
            "Content-Type": file.mime_type ?? "application/pdf",
            "Content-Disposition": `inline; filename="${(file.file_name ?? `estimate-${estimate.id}.pdf`).replace(/[\r\n"]/g, "_")}"`,
          },
        })
      } catch (error) {
        // Stored executed file unavailable — fall through to re-rendering below
        // instead of failing the download.
        console.error(`[estimates/export] Could not serve executed file for estimate ${estimate.id}; falling back to live render:`, error)
      }
    }
  }

  const sortedItems = [...(estimate.items ?? [])].sort(
    (a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  )
  const signatureData = (estimate.signature_data as Record<string, any> | null) ?? {}
  const clientSigner = signatureData.client ?? {}
  const builderSigner = signatureData.builder ?? {}
  const signers =
    estimate.client_signed_at || estimate.builder_signed_at
      ? [
          {
            role: "Client",
            name: clientSigner.signer_name ?? estimate.recipient?.full_name ?? null,
            signedAt: clientSigner.signed_at ?? estimate.client_signed_at ?? null,
            signatureImage: clientSigner.signature_image ?? null,
          },
          {
            role: branding.name ?? "Builder",
            name: builderSigner.signer_name ?? null,
            signedAt: builderSigner.signed_at ?? estimate.builder_signed_at ?? null,
            signatureImage: builderSigner.signature_image ?? null,
          },
        ]
      : undefined

  const pdf = await renderEstimatePdf({
    orgName: branding.name ?? undefined,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    estimateTitle: estimate.title,
    recipientName: estimate.recipient?.full_name ?? undefined,
    recipientEmail: estimate.recipient?.email ?? null,
    projectName: estimate.project?.name ?? null,
    summary: estimate.metadata?.summary ?? undefined,
    terms: estimate.metadata?.terms ?? undefined,
    subtotalCents: estimate.subtotal_cents,
    taxCents: estimate.tax_cents,
    totalCents: estimate.total_cents,
    validUntil: estimate.valid_until,
    documentLabel: signers ? (estimate.executed_at ? "Executed Estimate" : "Client-Signed Estimate") : undefined,
    signers,
    lines: sortedItems,
  })

  const filename = `estimate-${estimate.id}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  })
}

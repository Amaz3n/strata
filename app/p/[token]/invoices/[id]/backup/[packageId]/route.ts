import { NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getInvoiceForPortal } from "@/lib/services/invoices"
import { getSharedBackupPackageManifestForPortal } from "@/lib/services/owner-billing-packages"

interface Params {
  params: Promise<{ token: string; id: string; packageId: string }>
}

export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: Params) {
  const { token, id, packageId } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_view_invoices",
    })
  } catch {
    return new NextResponse("Not found", { status: 404 })
  }

  const invoice = await getInvoiceForPortal(id, access.org_id, access.project_id)
  if (!invoice || !invoice.client_visible) {
    return new NextResponse("Not found", { status: 404 })
  }

  const pkg = await getSharedBackupPackageManifestForPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    invoiceId: invoice.id,
    packageId,
    portalTokenId: access.id,
  })
  if (!pkg) {
    return new NextResponse("Not found", { status: 404 })
  }

  const body = {
    package: {
      id: pkg.id,
      name: pkg.name,
      status: pkg.status,
      manifest_hash: pkg.manifest_hash,
      generated_at: pkg.generated_at,
      shared_at: pkg.shared_at,
      downloaded_at: pkg.downloaded_at,
    },
    manifest: pkg.manifest,
  }
  const safeInvoiceNumber = String(invoice.invoice_number ?? invoice.id).replace(/[^a-zA-Z0-9._-]/g, "_")
  const safePackageId = String(pkg.id).slice(0, 8)

  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="invoice-${safeInvoiceNumber}-backup-${safePackageId}.json"`,
      "cache-control": "private, no-store",
    },
  })
}

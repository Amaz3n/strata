import { headers } from "next/headers"
import { NextResponse } from "next/server"
import { getFileShareLinkByToken, recordShareLinkDownload } from "@/lib/services/file-share-links"

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const link = await getFileShareLinkByToken(token)
  if (!link?.allow_download || !link.download_url) return NextResponse.json({ error: "File not available" }, { status: 404 })
  const h = await headers()
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || h.get("cf-connecting-ip")
  await recordShareLinkDownload({ linkId: link.id, fileId: link.file.id, orgId: link.org_id, ipAddress: ip, userAgent: h.get("user-agent") })
  return NextResponse.redirect(link.download_url)
}


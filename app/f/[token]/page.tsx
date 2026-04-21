import { headers } from "next/headers"
import { notFound } from "next/navigation"
import Image from "next/image"

import {
  getFileShareLinkByToken,
  recordShareLinkView,
} from "@/lib/services/file-share-links"
import { Button } from "@/components/ui/button"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0
export const dynamic = "force-dynamic"

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatExpiry(iso?: string): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export default async function PublicFileSharePage({ params }: Params) {
  const { token } = await params
  const link = await getFileShareLinkByToken(token)

  if (!link) {
    notFound()
  }

  const h = await headers()
  const getHeader = (name: string) => h.get(name)
  const userAgent = getHeader("user-agent")
  const ip =
    getHeader("x-forwarded-for")?.split(",")?.[0]?.trim() ||
    getHeader("x-real-ip") ||
    getHeader("cf-connecting-ip") ||
    null

  await recordShareLinkView({
    linkId: link.id,
    fileId: link.file.id,
    orgId: link.file.org_id,
    ipAddress: ip,
    userAgent,
  })

  const isImage = link.file.mime_type?.startsWith("image/") ?? false
  const isPdf = link.file.mime_type === "application/pdf"
  const size = formatBytes(link.file.size_bytes)
  const expiry = formatExpiry(link.expires_at)

  return (
    <div className="min-h-screen bg-muted/20">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 sm:py-16">
        <header className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Shared file
          </p>
          <h1 className="truncate text-2xl font-semibold">{link.file.file_name}</h1>
          <p className="text-sm text-muted-foreground">
            {[size, expiry ? `Access expires ${expiry}` : "No expiry"]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </header>

        <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
          {link.download_url && isImage ? (
            <div className="relative flex max-h-[70vh] items-center justify-center bg-muted/40">
              <Image
                src={link.download_url}
                alt={link.file.file_name}
                width={1200}
                height={800}
                className="max-h-[70vh] w-auto object-contain"
                unoptimized
              />
            </div>
          ) : link.download_url && isPdf ? (
            <iframe
              src={link.download_url}
              title={link.file.file_name}
              className="h-[75vh] w-full"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <p className="text-sm font-medium">Preview not available</p>
              <p className="max-w-md text-xs text-muted-foreground">
                This file type can&apos;t be previewed in the browser.
                {link.allow_download
                  ? " Use the download button below to open it."
                  : " The owner has disabled downloads for this link."}
              </p>
            </div>
          )}
        </div>

        {link.allow_download && link.download_url ? (
          <div className="flex justify-end">
            <Button asChild>
              <a
                href={link.download_url}
                download={link.file.file_name}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download
              </a>
            </Button>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          This link was shared with you by the project team. Access is logged.
        </p>
      </div>
    </div>
  )
}

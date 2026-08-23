"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Building2, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { formatMoneyCentsExact, parseLocalDate } from "@/lib/utils"
import type { PortableComplianceDocument } from "@/lib/services/compliance-portability"

import { shareComplianceDocumentAction } from "./actions"

function formatDay(value?: string | null) {
  const parsed = parseLocalDate(value)
  if (!parsed) return null
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/**
 * Documents this vendor has already given another builder on Arc.
 *
 * Uploading the same certificate to four builders four times a year is a
 * feature of siloed compliance, not of construction. Sharing is per document
 * and per builder, the vendor is the only one who can do it, and the receiving
 * builder still reviews the copy against their own requirements — so this saves
 * the vendor work without weakening anybody's file.
 */
export function PortableDocuments({
  token,
  documents,
}: {
  token: string
  documents: PortableComplianceDocument[]
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [sharingId, setSharingId] = useState<string | null>(null)

  const shareable = documents.filter((document) => !document.alreadyShared)
  if (shareable.length === 0) return null

  const share = (document: PortableComplianceDocument) => {
    setSharingId(document.sourceDocumentId)
    startTransition(async () => {
      try {
        unwrapAction(await shareComplianceDocumentAction(token, document.sourceDocumentId))
        toast({
          title: `${document.documentTypeName} sent`,
          description: "The builder will review it like any other submission.",
        })
        router.refresh()
      } catch (error) {
        toast({ title: "Could not share that document", description: (error as Error).message })
      } finally {
        setSharingId(null)
      }
    })
  }

  return (
    <section className="border border-border bg-card">
      <div className="border-b bg-muted/40 px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Building2 className="size-4 shrink-0 text-muted-foreground" />
          Documents you already gave another builder
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Send one across instead of uploading it again. Only you can do this, and only the document
          you pick.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {shareable.map((document) => (
          <li
            key={document.sourceDocumentId}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{document.documentTypeName}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>On file with {document.sourceOrgName}</span>
                {document.carrierName ? <span>{document.carrierName}</span> : null}
                {document.coverageAmountCents != null ? (
                  <span className="tabular-nums">
                    {formatMoneyCentsExact(document.coverageAmountCents)}
                  </span>
                ) : null}
                {document.expiryDate ? (
                  <span className="tabular-nums">Expires {formatDay(document.expiryDate)}</span>
                ) : null}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={pending}
              onClick={() => share(document)}
            >
              {sharingId === document.sourceDocumentId && pending ? "Sending…" : "Send this one"}
            </Button>
          </li>
        ))}
      </ul>
      {documents.some((document) => document.alreadyShared) ? (
        <p className="flex items-center gap-1.5 border-t px-4 py-2 text-xs text-muted-foreground">
          <Check className="size-3.5 shrink-0 text-success" />
          {documents.filter((document) => document.alreadyShared).length} already sent to this
          builder.
        </p>
      ) : null}
    </section>
  )
}

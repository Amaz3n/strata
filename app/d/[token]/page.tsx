import { connection } from "next/server"
import { ensureFrozenSigningSource } from "@/lib/services/esign-execution"
import { hasSigningAccess } from "@/lib/esign/access-code"
import { UnlockSigningClient } from "./components/unlock-signing"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { resolveSigningRequestToken } from "@/lib/esign/signing-tokens"
import { type ReactNode } from "react"
import { notFound } from "next/navigation"

import { AlertTriangle, CheckCircle2, Clock } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ENVELOPE_EVENT_TYPES } from "@/lib/esign/unified-contracts"
import { recordESignEvent } from "@/lib/services/esign-events"
import { createExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { loadEstimateByIdForPortal } from "@/lib/services/estimate-portal"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { WaiverSigningClient } from "@/components/portal/waiver-signing-client"
import { EstimateBuilderSigningClient } from "@/components/portal/estimate-builder-signing-client"
import { DocumentSigningClient } from "./document-signing-client"

export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

interface Params {
  params: Promise<{ token: string }>
}

function buildExecutedDocumentUrl(token: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  return appUrl ? `${appUrl}/api/esign/executed/${token}` : `/api/esign/executed/${token}`
}

function StatusPanel({
  title,
  description,
  tone = "neutral",
  documentTitle,
  meta,
  action,
  icon,
}: {
  title: string
  description: string
  tone?: "neutral" | "warning" | "success"
  documentTitle?: string
  meta?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-xl rounded-lg">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border bg-muted/40">
            {icon ?? <Clock className="h-7 w-7 text-muted-foreground" />}
          </div>
          <CardTitle className="text-2xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{description}</p>
          {documentTitle ? (
            <p className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium">
              {documentTitle}
            </p>
          ) : null}
          {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
          {action ? <div className="pt-2">{action}</div> : null}
        </CardContent>
      </Card>
    </div>
  )
}

async function DocumentSigningPageContent({ params }: Params) {
  await connection()
  const { token } = await params
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }

  const supabase = createServiceSupabaseClient()
  const { data: signingRequest, error } = await resolveSigningRequestToken(supabase, token, `
        *,
        document:documents(
          id,
          org_id,
          project_id,
          title,
          document_type,
          status,
          source_file_id,
          executed_file_id,
          source_entity_type,
          source_entity_id,
          metadata
        )
      `)

  if (error) {
    throw new Error(`Failed to load signing request: ${error.message}`)
  }

  if (!signingRequest || !signingRequest.document) {
    notFound()
  }

  if (!(await hasSigningAccess(signingRequest))) return <UnlockSigningClient token={token} />

  const now = new Date()
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) {
    return (
      <StatusPanel
        tone="warning"
        title="Signing link expired"
        description={`This signing request is no longer valid. It expired on ${new Date(signingRequest.expires_at).toLocaleDateString()}. Please contact the sender if you need a new link.`}
        documentTitle={signingRequest.document.title}
        icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />}
      />
    )
  }

  if (signingRequest.status === "voided" || signingRequest.document.status === "voided") {
    return (
      <StatusPanel
        tone="warning"
        title="Signing request withdrawn"
        description="This signing request was withdrawn by the sender. Please contact them if you need a new link."
        documentTitle={signingRequest.document.title}
        icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />}
      />
    )
  }

  if (signingRequest.status === "expired" || signingRequest.document.status === "expired") {
    return (
      <StatusPanel
        tone="warning"
        title="Signing link expired"
        description="This signing request is no longer valid. Please contact the sender if you need a new link."
        documentTitle={signingRequest.document.title}
        icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />}
      />
    )
  }

  if (signingRequest.status === "signed" || signingRequest.document.status === "signed") {
    const executedFileId = signingRequest.document.executed_file_id as string | null | undefined
    const downloadUrl = executedFileId
      ? buildExecutedDocumentUrl(createExecutedFileAccessToken(executedFileId))
      : null

    return (
      <StatusPanel
        tone="success"
        title={downloadUrl ? "You're all set" : "Your signature is recorded"}
        description={downloadUrl ? "The completed document is ready to download." : "Your signature is safely recorded. The document is awaiting other signers or being prepared. Refresh this page to check for the completed copy."}
        documentTitle={signingRequest.document.title}
        icon={<CheckCircle2 className="h-7 w-7 text-success" />}
        action={
          downloadUrl ? (
            <Button asChild>
              <a href={downloadUrl} target="_blank" rel="noreferrer">Download signed document</a>
            </Button>
          ) : null
        }
      />
    )
  }

  const envelopeId = signingRequest.envelope_id ?? signingRequest.group_id ?? signingRequest.id
  const sequence = signingRequest.sequence ?? 1
  const signerRole = signingRequest.signer_role ?? "client"

  const estimateId =
    signingRequest.document.source_entity_type === "estimate"
      ? signingRequest.document.source_entity_id
      : (signingRequest.document.metadata?.estimate_id as string | undefined)

  let groupRequestsQuery = supabase
    .from("document_signing_requests")
    .select("id, status, sequence, required, signer_role")
    .order("sequence", { ascending: true })

  if (signingRequest.envelope_id) {
    groupRequestsQuery = groupRequestsQuery.eq("envelope_id", signingRequest.envelope_id)
  } else {
    groupRequestsQuery = groupRequestsQuery.eq("group_id", signingRequest.group_id ?? signingRequest.id)
  }

  const { data: groupRequests, error: groupError } = await groupRequestsQuery

  if (groupError) {
    throw new Error(`Failed to load signing group: ${groupError.message}`)
  }

  const requiredPrior = (groupRequests ?? []).filter(
    (req) => (req.sequence ?? 1) < sequence && req.required !== false,
  )
  const priorUnsigned = requiredPrior.filter((req) => req.status !== "signed")
  if (priorUnsigned.length > 0) {
    return (
      <StatusPanel
        title="Waiting for prior signatures"
        description="Required signers before your turn have not completed yet. You will receive a new email when signing is available."
        documentTitle={signingRequest.document.title}
        meta={`Your position in routing: ${sequence} of ${(groupRequests ?? []).length || 1}`}
        icon={<Clock className="h-7 w-7 text-muted-foreground" />}
      />
    )
  }

  if (!signingRequest.viewed_at) {
    const { error: viewedUpdateError } = await supabase
      .from("document_signing_requests")
      .update({
        viewed_at: now.toISOString(),
        status: signingRequest.status === "signed" ? "signed" : "viewed",
      })
      .eq("id", signingRequest.id)
      .in("status", ["draft", "sent", "viewed"])
      .is("viewed_at", null)

    if (viewedUpdateError) {
      throw new Error(`Failed to update signing request view state: ${viewedUpdateError.message}`)
    }

    await recordESignEvent({
      supabase,
      orgId: signingRequest.org_id,
      eventType: ENVELOPE_EVENT_TYPES.viewed,
      envelopeId,
      documentId: signingRequest.document_id,
      payload: {
        signing_request_id: signingRequest.id,
        viewed_at: now.toISOString(),
      },
    })
  }

  // Legacy source bytes are frozen before any signing preview is presented.
  // Already accepted historical links returned their receipt above.
  try {
    await ensureFrozenSigningSource(signingRequest.org_id, signingRequest.document_id)
  } catch (error) {
    return <StatusPanel tone="warning" title="The sender needs to update this request"
      description={error instanceof Error ? error.message : "This document cannot be signed yet. Please contact the sender."}
      documentTitle={signingRequest.document.title} icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />} />
  }

  if (estimateId) {
    const estimate = await loadEstimateByIdForPortal({
      supabase,
      orgId: signingRequest.org_id,
      estimateId,
    })
    if (!estimate) {
      notFound()
    }

    return (
      <EstimateBuilderSigningClient
        token={token}
        estimate={estimate}
        signerEmail={signingRequest.sent_to_email}
        pdfUrl={`/d/${token}/file`}
      />
    )
  }

  const { data: fields, error: fieldsError } = await supabase
    .from("document_fields")
    .select("*")
    .eq("document_id", signingRequest.document_id)
    .eq("revision", signingRequest.revision)
    .order("sort_order", { ascending: true })

  if (fieldsError) {
    throw new Error(`Failed to load document fields: ${fieldsError.message}`)
  }

  if (signingRequest.document.metadata?.waiver_signing_experience === "review" && signingRequest.document.metadata?.invoice_lien_waiver_id) {
    const recipients = signingRequest.document.metadata?.draft_recipients ?? []
    return <WaiverSigningClient token={token} title={signingRequest.document.title} signerRole={signerRole}
      signerEmail={signingRequest.sent_to_email ?? ""}
      signerName={recipients.find((recipient: { email?: string }) => recipient.email === signingRequest.sent_to_email)?.name ?? ""}
      fields={(fields ?? []).filter(field => !field.signer_role || field.signer_role === signerRole)}/>
  }

  const priorSignedRequestIds = (groupRequests ?? [])
    .filter((request) => request.status === "signed")
    .map((request) => request.id)

  let prefilledValues: Record<string, any> = {}
  if (priorSignedRequestIds.length > 0) {
    const { data: priorSignatures, error: signaturesError } = await supabase
      .from("document_signatures")
      .select("values")
      .in("signing_request_id", priorSignedRequestIds)
      .order("created_at", { ascending: true })

    if (signaturesError) {
      throw new Error(`Failed to load prior signatures: ${signaturesError.message}`)
    }

    prefilledValues = (priorSignatures ?? []).reduce<Record<string, any>>((acc, signature: any) => {
      return { ...acc, ...(signature.values ?? {}) }
    }, {})
  }

  return (
    <DocumentSigningClient
      token={token}
      fileUrl={`/d/${token}/file`}
      document={{
        id: signingRequest.document.id,
        title: signingRequest.document.title,
        document_type: signingRequest.document.document_type,
      }}
      fields={fields ?? []}
      prefilledValues={prefilledValues}
      signerRole={signerRole}
      signerEmail={signingRequest.sent_to_email}
    />
  )
}

export default function DocumentSigningPage(props: Parameters<typeof DocumentSigningPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton title="Document signing" />}>
      <DocumentSigningPageContent {...props} />
    </Suspense>
  )
}

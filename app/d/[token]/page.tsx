import { createHmac } from "crypto"
import { type ReactNode } from "react"
import { notFound } from "next/navigation"

import { AlertTriangle, CheckCircle2, Clock } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ENVELOPE_EVENT_TYPES } from "@/lib/esign/unified-contracts"
import { recordESignEvent } from "@/lib/services/esign-events"
import { createExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { DocumentSigningClient } from "./document-signing-client"

export const revalidate = 0

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

export default async function DocumentSigningPage({ params }: Params) {
  const { token } = await params
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }

  const tokenHash = createHmac("sha256", secret).update(token).digest("hex")
  const supabase = createServiceSupabaseClient()

  const { data: signingRequest, error } = await supabase
    .from("document_signing_requests")
    .select(
      `
        *,
        document:documents(
          id,
          org_id,
          project_id,
          title,
          document_type,
          status,
          source_file_id,
          executed_file_id
        )
      `,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load signing request: ${error.message}`)
  }

  if (!signingRequest || !signingRequest.document) {
    notFound()
  }

  const now = new Date()
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) {
    return (
      <StatusPanel
        tone="warning"
        title="Signing link expired"
        description={`This signing request is no longer valid. It expired on ${new Date(signingRequest.expires_at).toLocaleDateString()}.`}
        documentTitle={signingRequest.document.title}
        icon={<AlertTriangle className="h-7 w-7 text-warning-foreground" />}
      />
    )
  }

  if (signingRequest.status === "signed") {
    const executedFileId = signingRequest.document.executed_file_id as string | null | undefined
    const downloadUrl = executedFileId
      ? buildExecutedDocumentUrl(createExecutedFileAccessToken(executedFileId))
      : null

    return (
      <StatusPanel
        tone="success"
        title="You're all set"
        description="This document has been signed successfully. No further action is required."
        documentTitle={signingRequest.document.title}
        icon={<CheckCircle2 className="h-7 w-7 text-emerald-700" />}
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

  const { data: fields, error: fieldsError } = await supabase
    .from("document_fields")
    .select("*")
    .eq("document_id", signingRequest.document_id)
    .eq("revision", signingRequest.revision)
    .order("sort_order", { ascending: true })

  if (fieldsError) {
    throw new Error(`Failed to load document fields: ${fieldsError.message}`)
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
    />
  )
}

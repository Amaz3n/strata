"use client"
import { WaiverAdditionalSigners, WaiverCustomFields } from "@/components/invoices/waiver-custom-fields"
import { chooseCompanyWaiver } from "@/lib/templates/waiver-engine"
import { useContext, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { PayablePreviewContext } from "./workspace/payable-preview-context"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import {
  WAIVER_KINDS,
  WAIVER_KIND_LABELS,
  normalizeWaiverKind,
} from "@/lib/lien-waivers/coverage"
import {
  loadPayableWaiversAction,
  preparePayableWaiverAction,
  reviewPayableWaiverAction,
  setPayableWorkThroughAction,
  suggestPayableWaiverDetailsAction,
} from "@/app/(app)/payables/waiver-actions"
import type {
  loadPayableWaivers,
  PayableWaiverInput,
} from "@/lib/services/payable-waivers"
import {
  editableWaiverValues,
  parseWaiverAmount,
} from "@/lib/lien-waivers/preparation"
const Preview = dynamic(
  () => import("@/components/settings/waiver-template-live-preview"),
  { ssr: false },
)
const EnvelopeWizard = dynamic(
  () =>
    import("@/components/esign/envelope-wizard").then((m) => m.EnvelopeWizard),
  { ssr: false },
)
type Data = Awaited<ReturnType<typeof loadPayableWaivers>>
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  )
export function PayableWaivers({
  billId,
  allocations,
  onBusyChange,
}: {
  billId: string
  onBusyChange?: (busy: boolean) => void
  allocations?: PayableWaiverInput["allocations"]
}) {
  const previewTarget = useContext(PayablePreviewContext)
  const router = useRouter(),
    [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0)
  const [open, setOpen] = useState(false),
    [input, setInput] = useState<PayableWaiverInput | null>(null),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false),
    [documentId, setDocumentId] = useState<string | null>(null)
  const [signingBusy, setSigningBusy] = useState(false)
  const preparationRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    onBusyChange?.(busy || signingBusy)
    return () => onBusyChange?.(false)
  }, [busy, signingBusy, onBusyChange])
  useEffect(() => {
    if (open || documentId) preparationRef.current?.focus()
  }, [open, documentId])
  const [amountDrafts, setAmountDrafts] = useState<string[]>([])
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) {
      setFileUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setFileUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const [reviewId, setReviewId] = useState<string | null>(null),
    [note, setNote] = useState("")
  useEffect(() => {
    let active = true
    setData(null)
    loadPayableWaiversAction(billId)
      .then(unwrapAction)
      .then((d) => {
        if (active) {
          setData(d)
          setError("")
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [billId, revision])
  function start(source: "template" | "upload") {
    if (!data) return
    const kind =
      data.coverage.outstandingCents > 0
        ? "conditional_progress"
        : "unconditional_progress"
    const template = chooseCompanyWaiver(data.templates, kind)
    setAmountDrafts(
      (
        allocations ?? [
          {
            bill_id: billId,
            amount_cents:
              data.coverage.outstandingCents ||
              data.bill.paid_cents ||
              data.bill.total_cents,
          },
        ]
      ).map((a) => (a.amount_cents / 100).toFixed(2)),
    )
    setInput({
      request_id: crypto.randomUUID(),
      allocations: allocations ?? [
        {
          bill_id: billId,
          amount_cents:
            data.coverage.outstandingCents ||
            data.bill.paid_cents ||
            data.bill.total_cents,
        },
      ],
      source,
      template_id: template?.id,
      waiver_type: template?.waiverType ?? kind,
      through_date: data.coverage.through ?? "",
      claimant_name: data.company.name,
      customer_name: data.org.name,
      owner_name: "",
      project_name: data.project.name,
      property_description:
        typeof data.project.location === "string"
          ? data.project.location
          : (data.project.location?.address ?? ""),
      jurisdiction: data.jurisdiction,
      signer_name: template?.defaults?.signerName ?? "",
      signer_email: data.company.email ?? "",
      signer_title: template?.defaults?.signerTitle || "Authorized representative",
      exceptions: "",
      final_confirmed: false,
      received_confirmed: false,
    })
    setFile(undefined)
    setOpen(true)
  }
  async function prepare(event: React.FormEvent) {
    event.preventDefault()
    if (!input) return
    setBusy(true)
    try {
      if (!data?.coverage.through) {
        unwrapAction(await setPayableWorkThroughAction(billId, input.through_date))
      }
      const form = new FormData()
      form.set("input", JSON.stringify(input))
      if (file) form.set("file", file)
      const result = unwrapAction(await preparePayableWaiverAction(form))
      setDocumentId(result.documentId)
      setOpen(false)
      setRevision((v) => v + 1)
      router.refresh()
      toast.success(
        result.documentId
          ? "Document prepared; confirm the vendor and send for signature"
          : "Signed document recorded for review",
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not prepare waiver")
    } finally {
      setBusy(false)
    }
  }
  async function review(status: "accepted" | "rejected") {
    if (!reviewId) return
    setBusy(true)
    try {
      setData(
        unwrapAction(
          await reviewPayableWaiverAction(billId, reviewId, status, note),
        ),
      )
      setReviewId(null)
      setNote("")
      router.refresh()
      toast.success("Review saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save review")
    } finally {
      setBusy(false)
    }
  }
  const template = data?.templates.find((t) => t.id === input?.template_id)
  const waiverPreview = open && input ? (
              <div className="flex min-h-96 flex-1 flex-col bg-muted/20 @[900px]:sticky @[900px]:top-0 @[900px]:border-l">
                {template && input.source === "template" ? (
                  <Preview
                    draft={template}
                    sourceFileId={template.sourceFileId}
                    customValues={input.custom_values}
                    sample={false}
                    values={editableWaiverValues({
                      ...input,
                      amount_cents: input.allocations.reduce(
                        (sum, a) => sum + a.amount_cents,
                        0,
                      ),
                    })}
                    invoiceNumber={data?.bill.bill_number ?? ""}
                  />
                ) : fileUrl ? (
                  <iframe
                    title="Original signed waiver"
                    src={fileUrl}
                    className="h-[70dvh] w-full"
                  />
                ) : (
                  <p className="p-6 text-sm text-muted-foreground">
                    The original signed PDF will be preserved. Recording a
                    document does not accept it or clear a payment hold.
                  </p>
                )}
              </div>
  ) : null
  // Wait for the effective requirement (including project policy) before
  // showing waiver controls. Preserve existing evidence and explicit combined
  // preparation opened from the waiver register.
  if (!data && !error) return <Skeleton className="my-5 h-8 w-full" />
  if (
    data?.coverage.status === "Not required" &&
    data.waivers.length === 0 &&
    !allocations?.length &&
    !open &&
    !documentId &&
    !reviewId
  ) return null

  return (
    <section className="@container space-y-5 py-5">
      {previewTarget && waiverPreview ? createPortal(waiverPreview, previewTarget) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Waivers
        </h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.canWrite || busy || open || Boolean(documentId) || Boolean(reviewId)}
            onClick={() => start("upload")}
          >
            Record signed PDF
          </Button>
          <Button
            size="sm"
            disabled={!data?.canWrite || busy || open || Boolean(documentId) || Boolean(reviewId)}
            onClick={() => start("template")}
          >
            Request waiver
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button variant="link" onClick={() => setRevision((v) => v + 1)}>
            Retry
          </Button>
        </p>
      ) : !data ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <>
          <p
            className={
              data.coverage.reasons.length ||
              data.coverage.postPaymentOutstanding
                ? "text-sm text-warning"
                : "text-sm text-muted-foreground"
            }
          >
            {data.coverage.status}{data.coverage.heldCents > 0 ? ` · ${money(data.coverage.heldCents)} held for waiver coverage` : ""}
          </p>
          <ol className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-xs @[700px]:grid-cols-3">
            <li><p className="font-medium">1 · Before payment</p><p className="mt-1 text-muted-foreground">Prepare a conditional waiver. Review signed coverage for the payment amount and work period.</p></li>
            <li><p className="font-medium">2 · Pay the vendor</p><p className="mt-1 text-muted-foreground">Complete approval and other holds, then pay through Arc or record your payment.</p></li>
            <li><p className="font-medium">3 · After receipt</p><p className="mt-1 text-muted-foreground">Collect unconditional coverage after funds are received. Use final releases only when closing the scope.</p></li>
          </ol>
          {data.coverage.postPaymentOutstanding && <p className="text-sm text-warning">Unconditional coverage is outstanding for paid funds. This is a follow-up after payment.</p>}
          {data.bill.metadata?.waiver_chase && (
            <p className="text-xs text-muted-foreground">
              Latest follow-up:{" "}
              {data.bill.metadata.waiver_chase.delivery === "needs_preparation"
                ? "Prepare a waiver for the current payment stage"
                : "Signature reminder sent"}{" "}
              · {data.bill.metadata.waiver_chase.at}
            </p>
          )}
          {data.coverage.reasons.map((reason) => (
            <p key={reason} className="text-xs text-muted-foreground">
              {reason}
            </p>
          ))}
          <label className="flex items-center gap-3 text-xs text-muted-foreground">
            Payable work through
            <Input
              disabled={!data.canWrite || busy || open || Boolean(documentId) || Boolean(reviewId)}
              aria-label="Payable work through"
              className="w-40"
              type="date"
              defaultValue={data.coverage.through ?? ""}
              onBlur={(e) => {
                const value = e.target.value
                if (value && value !== data.coverage.through) {
                  setBusy(true)
                  void setPayableWorkThroughAction(billId, value)
                    .then(unwrapAction)
                    .then(() => {
                      setRevision((v) => v + 1)
                      router.refresh()
                    })
                    .catch((e) => toast.error(e.message))
                    .finally(() => setBusy(false))
                }
              }}
            />
          </label>
          {!data.waivers.length && (
            <p className="text-sm text-muted-foreground">
              Request a trade signature or record a signed document received
              outside Arc.
            </p>
          )}
          <div className="divide-y">
            {data.waivers.map((w) => {
              const kind = normalizeWaiverKind(w.waiver_type, w.metadata)
              return (
                <div
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm">
                      {kind
                        ? WAIVER_KIND_LABELS[kind]
                        : "Historical final · review type"}{" "}
                      · {money(w.amount_cents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Through {w.through_date} · {w.signingStatus ?? w.status} ·{" "}
                      {w.metadata?.review?.status ?? "Review required"}
                    </p>
                    {w.metadata?.review?.note && (
                      <p className="max-w-prose text-xs text-muted-foreground">
                        {w.metadata.review.note}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {w.documentHref && (
                      <Button asChild size="sm" variant="ghost">
                        <a
                          href={w.documentHref}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View PDF
                        </a>
                      </Button>
                    )}
                    {data.canReview && w.status === "signed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || open || Boolean(documentId)}
                        onClick={() => {
                          setReviewId(w.id)
                          setNote("")
                        }}
                      >
                        Review
                      </Button>
                    )}
                    {w.signingStatus && w.signingStatus !== "draft" && (
                      <Button asChild size="sm" variant="outline">
                        <a
                          href={`/projects/${data.bill.project_id}/signatures`}
                        >
                          Track signing
                        </a>
                      </Button>
                    )}
                    {data.canWrite &&
                      w.metadata?.document_id &&
                      w.status !== "signed" &&
                      w.signingStatus === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || open || Boolean(reviewId) || Boolean(documentId)}
                          onClick={() => setDocumentId(w.metadata.document_id)}
                        >
                          Signing
                        </Button>
                      )}
                  </div>
                </div>
              )
            })}
          </div>
          <a
            className="text-xs underline"
            href={`/projects/${data.bill.project_id}/financials/payables/waivers`}
          >
            Open project waiver register
          </a>
        </>
      )}
      {open && <div ref={preparationRef} tabIndex={-1} className="rounded-lg border bg-background outline-none">
          <div className="flex items-center justify-between gap-4 border-b px-5 py-4">
            <div><h3 className="text-base font-semibold">{input?.source === "upload" ? "Record signed waiver" : "Prepare vendor waiver"}</h3><p className="mt-1 text-xs text-muted-foreground">Review the coverage and document before continuing.</p></div>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Back to waivers</Button>
          </div>
          {input && (
            <div className={previewTarget ? "grid" : "grid items-start @[900px]:grid-cols-2"}>
              <form onSubmit={prepare} className="space-y-4 p-5 sm:p-6">
                <fieldset disabled={busy} className="space-y-4">
                {input.source === "template" ? (
                  <label className="block space-y-1 text-xs">
                    Published template
                    <select
                      required
                      className="h-9 w-full border bg-background px-2"
                      value={input.template_id ?? ""}
                      onChange={(e) => {
                        const t = data?.templates.find(
                          (t) => t.id === e.target.value,
                        )
                        setInput({
                          ...input,
                          template_id: t?.id,
                          waiver_type: t?.waiverType ?? input.waiver_type,
                          final_confirmed: false,
                          received_confirmed: false,
                          custom_values: {},
                          additional_signers: [],
                        })
                      }}
                    >
                      <option value="">Choose template</option>
                      {data?.templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {WAIVER_KIND_LABELS[t.waiverType]}
                        </option>
                      ))}
                    </select>
                    {!data?.templates.length && <p className="text-xs text-muted-foreground">No published incoming template matches this project. Publish a company template or return to upload a signed waiver.</p>}
                    <a
                      href="/settings/templates"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Manage company templates
                    </a>
                  </label>
                ) : (
                  <>
                    <label className="block text-xs">
                      Signed PDF
                      <Input
                        type="file"
                        required
                        accept="application/pdf"
                        onChange={(e) => setFile(e.target.files?.[0])}
                      />
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!file || busy}
                      onClick={async () => {
                        if (!file) return
                        setBusy(true)
                        try {
                          const f = new FormData()
                          f.set("file", file)
                          const suggestions = unwrapAction(
                            await suggestPayableWaiverDetailsAction(billId, f),
                          )
                          const { amount_cents, ...fields } = suggestions
                          if (input.allocations.length === 1 && amount_cents)
                            setAmountDrafts([(amount_cents / 100).toFixed(2)])
                          setInput((current) =>
                            current
                              ? {
                                  ...current,
                                  ...fields,
                                  source: current.source,
                                  request_id: current.request_id,
                                  allocations:
                                    current.allocations.length === 1 &&
                                    amount_cents
                                      ? [{ bill_id: billId, amount_cents }]
                                      : current.allocations,
                                }
                              : current,
                          )
                          toast.success(
                            "Suggested details filled; compare them with the signed document",
                          )
                        } catch (e) {
                          toast.error(
                            e instanceof Error
                              ? e.message
                              : "Could not read document",
                          )
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      Read PDF details
                    </Button>
                    <label className="block text-xs">
                      Actual signature date
                      <Input
                        type="date"
                        required
                        value={input.signed_date ?? ""}
                        onChange={(e) =>
                          setInput({ ...input, signed_date: e.target.value })
                        }
                      />
                    </label>
                    <label className="block text-xs">
                      Waiver type
                      <select
                        className="h-9 w-full border bg-background"
                        value={input.waiver_type}
                        onChange={(e) =>
                          setInput({
                            ...input,
                            waiver_type: e.target
                              .value as PayableWaiverInput["waiver_type"],
                          })
                        }
                      >
                        {WAIVER_KINDS.map((k) => (
                          <option value={k} key={k}>
                            {WAIVER_KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {input.allocations.map((allocation, index) => (
                  <label key={allocation.bill_id} className="block text-xs">
                    Amount covered · payable {allocation.bill_id.slice(0, 8)}
                    <Input
                      required
                      inputMode="decimal"
                      value={amountDrafts[index] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value
                        setAmountDrafts((current) =>
                          current.map((v, i) => (i === index ? value : v)),
                        )
                        setInput({
                          ...input,
                          allocations: input.allocations.map((a, i) =>
                            i === index
                              ? { ...a, amount_cents: parseWaiverAmount(value) }
                              : a,
                          ),
                        })
                      }}
                    />
                  </label>
                ))}
                <label className="block text-xs">
                  {data?.coverage.through ? "Waiver work through" : "Bill and waiver work through"}
                  <Input
                    required
                    type="date"
                    value={input.through_date}
                    onChange={(e) =>
                      setInput({ ...input, through_date: e.target.value })
                    }
                  />
                </label>
                {(
                  [
                    ["claimant_name", "Claimant legal name"],
                    ["customer_name", "Contracting customer"],
                    ["owner_name", "Property owner"],
                    ["project_name", "Project"],
                    ["property_description", "Property / lot"],
                    ["jurisdiction", "Property state"],
                    ["signer_name", "Trade signer name"],
                    ["signer_title", "Signer title"],
                    ["signer_email", "Trade signer email"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="block text-xs">
                    {label}
                    <Input
                      required
                      type={key === "signer_email" ? "email" : "text"}
                      value={input[key]}
                      onChange={(e) =>
                        setInput({ ...input, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <label className="block text-xs">
                  Exceptions and retained amounts
                  <Textarea
                    value={input.exceptions}
                    onChange={(e) =>
                      setInput({ ...input, exceptions: e.target.value })
                    }
                  />
                </label>
<WaiverAdditionalSigners template={template} values={input.additional_signers} onChange={v=>setInput({...input,additional_signers:v})}/><WaiverCustomFields template={template} values={input.custom_values} onChange={v=>setInput({...input,custom_values:v})}/>
                {input.waiver_type.endsWith("final") && (
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      required
                      checked={input.final_confirmed}
                      onChange={(e) =>
                        setInput({
                          ...input,
                          final_confirmed: e.target.checked,
                        })
                      }
                    />
                    I reviewed remaining retainage, changes, claims, and the
                    scope being closed.
                  </label>
                )}
                {input.waiver_type.startsWith("unconditional") && (
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      required
                      checked={input.received_confirmed}
                      onChange={(e) =>
                        setInput({
                          ...input,
                          received_confirmed: e.target.checked,
                        })
                      }
                    />
                    The covered funds were received by the trade.
                  </label>
                )}
                </fieldset>
                <Button disabled={busy || (input.source === "template" && !template)} type="submit">
                  {busy
                    ? "Preparing…"
                    : input.source === "upload"
                      ? "Record for review"
                      : "Review and send for signature"}
                </Button>
              </form>
              {!previewTarget && waiverPreview}

            </div>
          )}
      </div>}
      {reviewId && <div className="rounded-lg border p-5 space-y-4">
          <div className="flex items-center justify-between"><h3 className="font-semibold">Review signed waiver</h3><Button variant="ghost" disabled={busy} onClick={() => setReviewId(null)}>Cancel review</Button></div>
          {data?.waivers.find(w => w.id === reviewId)?.documentHref && <iframe title="Signed waiver for review" src={data.waivers.find(w => w.id === reviewId)!.documentHref!} className="h-[60dvh] w-full border" />}
          <p className="text-sm text-muted-foreground">
            Check the claimant, signature, property, amount, dates, and
            exceptions against the payable.
          </p>
          <Textarea
            aria-label="Review notes"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What you checked, or what needs correction"
          />
          <div className="flex gap-2">
            <Button
              disabled={busy || !note.trim()}
              onClick={() => review("accepted")}
            >
              Accept coverage
            </Button>
            <Button
              disabled={busy || !note.trim()}
              variant="outline"
              onClick={() => review("rejected")}
            >
              Mark needs correction
            </Button>
          </div>
      </div>}
      {documentId && <div ref={preparationRef} tabIndex={-1} className="flex min-h-[70dvh] flex-col overflow-hidden rounded-lg border outline-none">
          <div className="flex items-center justify-between border-b p-4"><h3 className="font-semibold">Vendor signature request</h3><Button variant="ghost" disabled={signingBusy} onClick={() => { setDocumentId(null); setRevision(v => v + 1) }}>Back to waivers</Button></div>
          {documentId && (
            <EnvelopeWizard
              embedded
              onBusyChange={setSigningBusy}
              open
              sourceEntity={null}
              resumeDocumentId={documentId}
              onOpenChange={(v) => {
                if (!v) {
                  setDocumentId(null)
                  setRevision((v) => v + 1)
                }
              }}
              onEnvelopeSent={() => {
                setDocumentId(null)
                setRevision((v) => v + 1)
                toast.success("Signature request queued")
              }}
            />
          )}
      </div>}
    </section>
  )
}

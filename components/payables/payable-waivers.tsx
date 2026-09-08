"use client"
import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
}: {
  billId: string
  allocations?: PayableWaiverInput["allocations"]
}) {
  const router = useRouter(),
    [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0)
  const [open, setOpen] = useState(false),
    [input, setInput] = useState<PayableWaiverInput | null>(null),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false),
    [documentId, setDocumentId] = useState<string | null>(null)
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
    const template = data.templates.find((t) => t.waiverType === kind)
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
      signer_name: "",
      signer_email: data.company.email ?? "",
      signer_title: "Authorized representative",
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
  return (
    <section className="space-y-3 border-t py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Waivers
        </h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.canWrite}
            onClick={() => start("upload")}
          >
            Record signed PDF
          </Button>
          <Button
            size="sm"
            disabled={!data?.canWrite}
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
            {data.coverage.status} · {money(data.coverage.heldCents)} blocked
          </p>
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
              disabled={!data.canWrite}
              aria-label="Payable work through"
              className="w-40"
              type="date"
              defaultValue={data.coverage.through ?? ""}
              onBlur={(e) => {
                const value = e.target.value
                if (value && value !== data.coverage.through)
                  void setPayableWorkThroughAction(billId, value)
                    .then(unwrapAction)
                    .then(() => {
                      setRevision((v) => v + 1)
                      router.refresh()
                    })
                    .catch((e) => toast.error(e.message))
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
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v)
        }}
      >
        <DialogContent className="flex max-h-[90dvh] flex-col overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>
              {input?.source === "upload"
                ? "Record signed waiver"
                : "Prepare trade waiver"}
            </DialogTitle>
          </DialogHeader>
          {input && (
            <div className="grid gap-6 lg:grid-cols-2">
              <form onSubmit={prepare} className="space-y-4">
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
                  Work through
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
                <Button disabled={busy} type="submit">
                  {busy
                    ? "Preparing…"
                    : input.source === "upload"
                      ? "Record for review"
                      : "Review and send for signature"}
                </Button>
              </form>
              <div className="min-h-96 border bg-muted/20">
                {template && input.source === "template" ? (
                  <Preview
                    draft={template}
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
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(reviewId)}
        onOpenChange={(v) => {
          if (!v && !busy) setReviewId(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review signed waiver</DialogTitle>
          </DialogHeader>
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
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(documentId)}
        onOpenChange={(v) => {
          if (!v) {
            setDocumentId(null)
            setRevision((v) => v + 1)
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>Trade signature request</DialogTitle>
          </DialogHeader>
          {documentId && (
            <EnvelopeWizard
              embedded
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
        </DialogContent>
      </Dialog>
    </section>
  )
}

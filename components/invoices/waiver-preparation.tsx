"use client";
import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronsUpDown,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  INVOICE_WAIVER_TYPE_LABELS,
  type Invoice,
  type InvoiceLienWaiver,
} from "@/lib/types";
import {
  prepareWaiverSchema,
  preferredWaiverTemplate,
  readWaiverWorkflow,
  type PrepareWaiverInput,
  type WaiverTemplate,
} from "@/lib/lien-waivers/invoice-waiver";
import {
  editableWaiverValues,
  formatWaiverAmount,
  parseWaiverAmount,
} from "@/lib/lien-waivers/preparation";
import { createMySigningLinkAction } from "@/app/(app)/signatures/actions";
import { unwrapAction } from "@/lib/action-result";
import {
  loadWaiverPreparationAction,
  prepareWaiverAction,
  startWaiverSigningAction,
  refreshWaiverSigningAction,
  setWaiverPacketAction,
  loadWaiverSignersAction,
  requestWaiverSignatureAction,
} from "@/app/(app)/invoices/waiver-actions";
import type { loadInvoiceWaiverPreparation } from "@/lib/services/invoice-waiver-workflow";
import { formatMoneyFromCents } from "./invoice-presentation";
import { WaiverPdfPreview } from "./waiver-pdf-preview";
const LivePreview = dynamic(
  () => import("@/components/settings/waiver-template-live-preview"),
  {
    ssr: false,
    loading: () => (
      <div className="p-10 text-sm text-muted-foreground">Loading preview…</div>
    ),
  },
);
const EnvelopeWizard = dynamic(
  () =>
    import("@/components/esign/envelope-wizard").then((m) => m.EnvelopeWizard),
  { ssr: false },
);
const MotionDialogContent = motion.create(DialogContent);

type Preparation = Awaited<ReturnType<typeof loadInvoiceWaiverPreparation>>;
const EMPTY = {
  source: "template",
  waiver_type: "conditional_progress",
  amount_cents: 0,
  project_name: "",
  through_date: "",
  claimant_name: "",
  customer_name: "",
  owner_name: "",
  property_description: "",
  jurisdiction: "",
  exceptions: "",
  signer_name: "",
  signer_title: "Authorized representative",
  final_confirmed: false,
  received_confirmed: false,
} as const;
export default function WaiverPreparation({
  invoice,
  draft,
  onClose,
  onSaved,
  embedded = false,
}: {
  embedded?: boolean;
  invoice: Invoice;
  draft?: InvoiceLienWaiver;
  onClose: () => void;
  onSaved: (waiver: InvoiceLienWaiver) => void;
}) {
  const [context, setContext] = useState<Preparation | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [input, setInput] = useState<PrepareWaiverInput>(
    () =>
      readWaiverWorkflow(draft ?? {})?.input ?? {
        ...EMPTY,
        invoice_id: invoice.id,
        request_id: crypto.randomUUID(),
        amount_cents: invoice.balance_due_cents || invoice.total_cents || 0,
      },
  );
  const [amount, setAmount] = useState(formatWaiverAmount(input.amount_cents));
  const [prepared, setPrepared] = useState<InvoiceLienWaiver | null>(
    draft ?? null,
  );
  const [review, setReview] = useState(Boolean(draft));
  const [shared, setShared] = useState(
    readWaiverWorkflow(draft ?? {})?.sharing_requested ?? true,
  );
  const [previewReady, setPreviewReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [team, setTeam] = useState<{ id: string; name: string; email: string }[]>([]);
  const [signerId, setSignerId] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  useEffect(() => {
    let active = true;
    loadWaiverSignersAction(invoice.id).then(unwrapAction).then(result => {
      if (!active) return;
      setTeam(result.members); setCurrentUserId(result.currentUserId);
      const priorName = readWaiverWorkflow(draft ?? {})?.input.signer_name;
      const selected = result.members.find(member => priorName ? member.name === priorName : member.id === result.currentUserId);
      setSignerId(selected?.id ?? "");
      if (selected && !draft) setInput(old => ({ ...old, signer_name: selected.name }));
    }).catch(error => { if (active) setFieldError(error.message); });
    return () => { active = false; };
  }, [invoice.id, draft]);
  const [signingBusy, setSigningBusy] = useState(false);
  const reducedMotion = useReducedMotion();
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [openingSignature, setOpeningSignature] = useState(false);
  const dispatched = useRef(false);
  const guard = useRef(false);
  const Title = embedded ? "h2" : DialogTitle;
  const Description = embedded ? "p" : DialogDescription;
  const signingStage = Boolean(signingId || signingUrl || openingSignature || sent || completed);
  useEffect(() => {
    if ((!signingUrl && !sent) || !prepared) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const latest = unwrapAction(
          await refreshWaiverSigningAction(invoice.id, prepared.id),
        );
        if (active && readWaiverWorkflow(latest)?.lifecycle === "signed") {
          setPrepared(latest);
          onSaved(latest);
          setCompleted(true);
          setSigningUrl(null);
          return;
        }
      } catch {
        /* The signing page remains usable; retry after a transient read failure. */
      }
      if (active) timer = setTimeout(check, 2500);
    };
    timer = setTimeout(check, 2500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [signingUrl, sent, prepared, invoice.id, onSaved]);
  async function openMySignature(envelopeId: string | null) {
    dispatched.current = true;
    setSigningBusy(false);
    if (!envelopeId) return;
    setOpeningSignature(true);
    try {
      const result = unwrapAction(
        await createMySigningLinkAction({ envelopeId }),
      );
      const url = new URL(result.url, window.location.origin);
      setSigningUrl(url.pathname + url.search);
    } catch (error) {
      setFieldError(
        error instanceof Error
          ? error.message
          : "Open Signatures to finish this waiver",
      );
      setSigningId(null);
      setSent(true);
    } finally { setOpeningSignature(false); }
  }

  const initialized = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      loadWaiverPreparationAction(invoice.id)
        .then(unwrapAction)
        .then((data) => {
          if (cancelled) return;
          setContext(data);
          setLoadError("");
          if (initialized.current || draft) return;
          initialized.current = true;
          const kind =
            invoice.status === "paid" && data.payments.length
              ? "unconditional_progress"
              : "conditional_progress";
          const available = data.templates.filter((t) => t.status !== "draft");
          const preferred =
            preferredWaiverTemplate(available, kind) ??
            available.find((t) => t.waiver_type === kind) ??
            available[0];
          setInput((old) => ({
            ...old,
            project_name: data.project_name,
            claimant_name: data.claimant_name,
            customer_name: data.customer_name,
            owner_name: data.owner_name,
            property_description: data.property_description,
            jurisdiction: data.jurisdiction,
            signer_name: data.signer_name,
            through_date: data.through_date,
            source: "template",
            waiver_type: preferred?.waiver_type ?? kind,
            template_id: preferred?.id,
          }));
        })
        .catch((error) => {
          if (!cancelled)
            setLoadError(
              error instanceof Error
                ? error.message
                : "Could not load waiver details",
            );
        });
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [invoice.id, invoice.status, draft, retry]);
  function change<K extends keyof PrepareWaiverInput>(
    key: K,
    value: PrepareWaiverInput[K],
  ) {
    setInput((old) => ({
      ...old,
      [key]: value,
      request_id: crypto.randomUUID(),
      replaces_draft_id: prepared?.id ?? old.replaces_draft_id,
    }));
    setPrepared(null);
    setFieldError("");
    setPreviewReady(false);
  }
  function selectTemplate(t: WaiverTemplate) {
    change("template_id", t.id);
    setInput((old) => ({
      ...old,
      source: "template",
      waiver_type: t.waiver_type,
      final_confirmed: false,
      received_confirmed: false,
      payment_id: undefined,
      payment_ids: [],
    }));
    setTemplateOpen(false);
  }
  async function prepare() {
    if (guard.current) return;
    if (prepared) {
      setReview(true);
      return;
    }
    const parsed = prepareWaiverSchema.safeParse({
      ...input,
      amount_cents: parseWaiverAmount(amount),
    });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0].message);
      return;
    }
    guard.current = true;
    setBusy(true);
    setFieldError("");
    try {
      const form = new FormData();
      form.set("input", JSON.stringify(parsed.data));
      const result = unwrapAction(await prepareWaiverAction(form));
      if (embedded) unwrapAction(await setWaiverPacketAction(invoice.id, true, result.id));
      setInput(parsed.data);
      setPrepared(result);
      setReview(true);
      setPreviewReady(false);
      onSaved(result);
    } catch (error) {
      setFieldError(
        error instanceof Error ? error.message : "Could not prepare waiver",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function finish() {
    if (!prepared || !previewReady || guard.current) return;
    guard.current = true;
    setBusy(true);
    setFieldError("");
    try {
      if (signerId && !sent) {
        const requested = unwrapAction(await requestWaiverSignatureAction(invoice.id, prepared.id, signerId, embedded));
        setPrepared(requested.waiver); onSaved(requested.waiver);
        if (requested.isSelf) await openMySignature(requested.envelopeId);
        else setSent(true);
        return;
      }
      const result = unwrapAction(
        await startWaiverSigningAction(
          invoice.id,
          prepared.id,
          embedded || shared,
          embedded,
        ),
      );
      onSaved(result.waiver);
      setPrepared(result.waiver);
      if (embedded && result.status === "signed") {
        const latest = unwrapAction(await refreshWaiverSigningAction(invoice.id, prepared.id));
        setPrepared(latest); onSaved(latest); setCompleted(true);
      } else if (embedded && result.envelopeId) await openMySignature(result.envelopeId);
      else if (result.status !== "draft") setSent(true);
      else setSigningId(result.documentId);
    } catch (error) {
      setFieldError(
        error instanceof Error ? error.message : "Could not open signing",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  const selectedTemplate = context?.templates.find(
    (t) => t.id === input.template_id,
  );
  const snapshot = readWaiverWorkflow(prepared ?? {});
  const values = useMemo(() => editableWaiverValues(input), [input]);
  const selectedDate = input.through_date
    ? new Date(`${input.through_date}T12:00:00`)
    : undefined;
  const textField = (
    key:
      | "project_name"
      | "claimant_name"
      | "customer_name"
      | "owner_name"
      | "property_description"
      | "signer_name"
      | "signer_title",
    label: string,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`waiver-${key}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`waiver-${key}`}
        value={input[key]}
        onChange={(e) => change(key, e.target.value)}
        maxLength={key === "property_description" ? 1000 : 200}
      />
    </div>
  );
  const content = (
    <>
      {" "}
      <header className="flex h-[72px] shrink-0 items-center justify-between border-b px-6 pr-14">
        <div>
          <Title className="text-base">
            {signingStage
              ? sent ? "Awaiting signature" : "Sign waiver"
              : review
                ? "Review waiver"
                : "Prepare waiver"}
          </Title>
          <Description className="mt-1 text-xs">
            {invoice.invoice_number} · {invoice.title}
          </Description>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className={!review ? "text-foreground" : ""}>01 Details</span>
          <span>/</span>
          <span className={review && !signingStage ? "text-foreground" : ""}>
            02 Review
          </span>
          <span>/</span>
          <span className={signingStage ? "text-foreground" : ""}>03 Sign</span>
        </div>
      </header>
      {openingSignature ? <div className="m-auto text-sm text-muted-foreground" role="status">Opening your signature…</div> : completed ? (
        <div className="m-auto max-w-md space-y-4 p-8 text-center">
          <Check className="mx-auto size-8" />
          <h3 className="text-lg font-medium">Waiver signed</h3>
          <p className="text-sm text-muted-foreground">
            {snapshot?.needs_review ? "The invoice changed while signing. Prepare a new waiver before sending this packet." : "The signed PDF is ready to go with your invoice in one email."}
          </p>
          <Button onClick={onClose}>Back to invoice</Button>
        </div>
      ) : signingUrl ? (
        <iframe
          title="Sign your waiver"
          src={signingUrl}
          className="min-h-0 w-full flex-1 border-0"
        />
      ) : signingId ? (
        <EnvelopeWizard
          open
          continueToSign={embedded}
          embedded
          onBusyChange={setSigningBusy}
          onOpenChange={(open) => {
            if (!open && !dispatched.current) onClose();
          }}
          sourceEntity={null}
          resumeDocumentId={signingId}
          sheetTitle="Sign waiver"
          onEnvelopeSent={({ envelopeId }) => {
            if (embedded) void openMySignature(envelopeId);
            else onClose();
          }}
        />
      ) : !context ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-sm text-muted-foreground">
          {loadError ? (
            <>
              <p role="alert">{loadError}</p>
              <Button variant="outline" onClick={() => setRetry((v) => v + 1)}>
                Try again
              </Button>
            </>
          ) : (
            <>
              <Loader2 className="size-5 animate-spin" />
              Getting your waiver ready…
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (review ? finish() : prepare());
            }}
            className="flex w-[400px] shrink-0 flex-col border-r"
          >
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
              {review ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2"
                    disabled={busy || Boolean(snapshot?.signing_document_id)}
                    onClick={() => setReview(false)}
                  >
                    <ArrowLeft className="mr-2 size-3.5" />
                    Edit details
                  </Button>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {snapshot?.template_name ??
                        selectedTemplate?.name ??
                        "Saved waiver"}
                    </p>
                    <h3 className="text-sm font-medium">
                      {INVOICE_WAIVER_TYPE_LABELS[input.waiver_type]}
                    </h3>
                    <p className="pt-3 text-3xl font-medium tabular-nums tracking-tight">
                      {formatMoneyFromCents(input.amount_cents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Work through{" "}
                      {selectedDate
                        ? format(selectedDate, "MMMM d, yyyy")
                        : "—"}
                    </p>
                  </div>
                  <div className="space-y-4 border-y py-5 text-xs">
                    <div>
                      <p className="text-muted-foreground">
                        Project & property
                      </p>
                      <p className="mt-1 font-medium">{input.project_name}</p>
                      <p className="mt-1 leading-relaxed">
                        {input.property_description}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Prepared for</p>
                      <p className="mt-1">{input.claimant_name}</p>
                      <p className="mt-1 text-muted-foreground">
                        {input.signer_name} · {input.signer_title}
                      </p>
                    </div>
                  </div>
                  {!embedded && <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed">
                    <Checkbox
                      checked={shared}
                      disabled={Boolean(snapshot?.signing_document_id)}
                      onCheckedChange={(v) => setShared(v === true)}
                    />
                    <span>
                      Include with invoice after signing
                      <span className="mt-1 block text-muted-foreground">
                        The completed PDF will be available on the invoice’s
                        client link.
                      </span>
                    </span>
                  </label>}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Review the complete document. The selected company member will review and sign it; no field placement is needed.
                  </p>
                  {sent && (
                    <div className="border p-4 text-sm">
                      Waiting for the company signature. The signer receives an email with a secure review link. This window updates when they finish.
                      <Button asChild variant="link" className="px-0">
                        <a href="/signatures">
                          Open Signatures <ArrowRight className="ml-2 size-3" />
                        </a>
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label className="text-xs">Waiver template</Label>
                    <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-expanded={templateOpen}
                          aria-label="Waiver template"
                          className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-3 text-left"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {selectedTemplate?.name ?? "Choose a template"}
                            </span>
                            <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                              {selectedTemplate
                                ? INVOICE_WAIVER_TYPE_LABELS[
                                    selectedTemplate.waiver_type
                                  ]
                                : "From your company’s template library"}
                            </span>
                          </span>
                          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-[var(--radix-popover-trigger-width)] p-0"
                      >
                        <Command>
                          <CommandInput placeholder="Find a waiver template…" />
                          <CommandList className="max-h-72">
                            <CommandEmpty>No matching templates.</CommandEmpty>
                            {context.templates.map((t) => (
                              <CommandItem
                                key={t.id}
                                value={`${t.id} ${t.name} ${INVOICE_WAIVER_TYPE_LABELS[t.waiver_type]}`}
                                disabled={t.status === "draft"}
                                onSelect={() => selectTemplate(t)}
                                className="items-start gap-2 py-3"
                              >
                                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-xs font-medium">
                                    {t.name}
                                  </span>
                                  <span className="mt-1 block text-[11px] text-muted-foreground">
                                    {t.status === "draft"
                                      ? "Draft · Publish in Settings"
                                      : INVOICE_WAIVER_TYPE_LABELS[
                                          t.waiver_type
                                        ]}
                                  </span>
                                </span>
                                {input.template_id === t.id && (
                                  <Check className="size-4 shrink-0" />
                                )}
                              </CommandItem>
                            ))}
                          </CommandList>
                        </Command>
                        <div className="flex items-center justify-between border-t p-1.5">
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                          >
                            <a
                              href="/settings/templates"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Plus className="mr-1.5 size-3.5" />
                              Add template
                            </a>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label="Refresh templates"
                            onClick={() => setRetry((v) => v + 1)}
                          >
                            <RefreshCw className="size-3.5" />
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                  {loadError && (
                    <p role="alert" className="text-xs text-destructive">
                      {loadError}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="waiver-amount" className="text-xs">
                        Amount covered
                      </Label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
                          $
                        </span>
                        <Input
                          id="waiver-amount"
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => {
                            if (/^[\d,]*(\.\d{0,2})?$/.test(e.target.value)) {
                              setAmount(e.target.value);
                              change(
                                "amount_cents",
                                parseWaiverAmount(e.target.value),
                              );
                            }
                          }}
                          onBlur={() => {
                            const cents = parseWaiverAmount(amount);
                            if (Number.isFinite(cents))
                              setAmount(formatWaiverAmount(cents));
                          }}
                          required
                          className="pl-6 tabular-nums"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="waiver-through" className="text-xs">
                        Work through
                      </Label>
                      <Popover
                        open={calendarOpen}
                        onOpenChange={setCalendarOpen}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            id="waiver-through"
                            variant="outline"
                            className="w-full justify-between px-3 font-normal text-xs"
                          >
                            {selectedDate
                              ? format(selectedDate, "MMM d, yyyy")
                              : "Choose date"}
                            <CalendarDays className="size-3.5 text-muted-foreground" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-auto p-0">
                          <Calendar
                            mode="single"
                            selected={selectedDate}
                            defaultMonth={selectedDate}
                            onSelect={(date) => {
                              if (date) {
                                change(
                                  "through_date",
                                  format(date, "yyyy-MM-dd"),
                                );
                                setCalendarOpen(false);
                              }
                            }}
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  {textField("project_name", "Project")}
                  {textField("property_description", "Property / lot")}
                  <details
                    open={
                      !input.claimant_name ||
                      !input.customer_name ||
                      !input.owner_name
                    }
                  >
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      Parties
                    </summary>
                    <div className="space-y-3 pt-3">
                      {textField("claimant_name", "Claimant legal name")}
                      {textField("customer_name", "Customer")}
                      {textField("owner_name", "Property owner")}
                    </div>
                  </details>
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      Exceptions & retained amounts
                    </summary>
                    <div className="pt-3">
                      <Label className="sr-only" htmlFor="waiver-exceptions">
                        Exceptions
                      </Label>
                      <Textarea
                        id="waiver-exceptions"
                        value={input.exceptions}
                        onChange={(e) => change("exceptions", e.target.value)}
                        placeholder="List any amounts, claims, or work excluded from this waiver."
                        className="min-h-24 text-xs"
                      />
                    </div>
                  </details>
                  <div className="space-y-3 border-t pt-4">

                    {textField("signer_title", "Signer title")}
                  </div>
                  {input.waiver_type.startsWith("unconditional") && (
                    <div className="space-y-3 rounded-lg border p-3">
                      <p className="text-xs font-medium">Payment received</p>
                      <Select
                        value={
                          (input.payment_ids?.length ?? 0) > 1
                            ? "all"
                            : (input.payment_ids?.[0] ?? input.payment_id ?? "")
                        }
                        onValueChange={(v) => {
                          change("payment_id", v === "all" ? undefined : v);
                          setInput((old) => ({
                            ...old,
                            payment_ids:
                              v === "all"
                                ? context.payments.map((p) => p.id)
                                : [],
                          }));
                        }}
                      >
                        <SelectTrigger aria-label="Payment covered">
                          <SelectValue placeholder="Choose recorded payment" />
                        </SelectTrigger>
                        <SelectContent>
                          {context.payments.length > 1 && (
                            <SelectItem value="all">
                              All received payments ·{" "}
                              {formatMoneyFromCents(
                                context.payments.reduce(
                                  (sum, p) => sum + p.available_cents,
                                  0,
                                ),
                              )}
                            </SelectItem>
                          )}
                          {context.payments.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {formatMoneyFromCents(p.available_cents)} ·{" "}
                              {p.received_at.slice(0, 10)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!context.payments.length && (
                        <p className="text-xs text-muted-foreground">
                          Record the payment on this invoice first.
                        </p>
                      )}
                      <label className="flex items-start gap-2 text-xs leading-relaxed">
                        <Checkbox
                          checked={input.received_confirmed}
                          onCheckedChange={(v) =>
                            change("received_confirmed", v === true)
                          }
                        />
                        I confirm the covered funds have been received.
                      </label>
                    </div>
                  )}
                  {input.waiver_type.endsWith("final") && (
                    <label className="flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed">
                      <Checkbox
                        checked={input.final_confirmed}
                        onCheckedChange={(v) =>
                          change("final_confirmed", v === true)
                        }
                      />
                      I reviewed remaining retainage, changes, and claims. This
                      is the final payment for the scope described in the
                      waiver.
                    </label>
                  )}
                </>
              )}
              {!review && <div className="space-y-2 border-t pt-4">
                <Label>Who signs this waiver?</Label>
                <Select value={signerId} onValueChange={value => { setSignerId(value); const member = team.find(person => person.id === value); if (member) setInput(old => ({ ...old, signer_name: member.name })); }}>
                  <SelectTrigger aria-label="Waiver signer"><SelectValue placeholder="Choose a team member"/></SelectTrigger>
                  <SelectContent>{team.map(member => <SelectItem key={member.id} value={member.id}>{member.name}{member.id === currentUserId ? " (you)" : ""}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">Choose someone authorized to sign for your company. They’ll review and sign the waiver through a secure link.</p>
              </div>}
              {fieldError && (
                <p
                  role="alert"
                  className="border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive"
                >
                  {fieldError}
                </p>
              )}
            </div>
            <footer className="shrink-0 border-t p-5">
              <Button
                type="submit"
                className="w-full"
                disabled={
                  busy ||
                  sent ||
                  !signerId ||
                  (review
                    ? !previewReady
                    : !selectedTemplate || selectedTemplate.status === "draft")
                }
              >
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {busy
                  ? "Preparing…"
                  : review
                    ? signerId === currentUserId ? "Review & sign" : "Request signature"
                    : "Review document"}
                {!busy && <ArrowRight className="ml-2 size-3.5" />}
              </Button>
              <p className="mt-2 text-center text-[10px] text-muted-foreground">
                {review
                  ? sent ? "Waiting for signature before the packet can be sent" : signerId === currentUserId ? "Sign here without leaving the invoice" : "The invoice stays ready for you to send after signing"
                  : "Nothing is signed or shared yet"}
              </p>
            </footer>
          </form>
          <div className="flex min-w-0 flex-1 flex-col bg-muted/20">
            <div className="flex h-10 shrink-0 items-center justify-between border-b px-5 text-[10px] text-muted-foreground">
              <span>{review ? "PREPARED DOCUMENT" : "LIVE PREVIEW"}</span>
              <span>
                {review
                  ? "Review every page"
                  : "Filled with your project details"}
              </span>
            </div>
            <div className="flex min-h-0 flex-1">
              {review && prepared ? (
                <WaiverPdfPreview
                  key={prepared.id}
                  url={`/api/invoices/${invoice.id}/waivers/${prepared.id}`}
                  onReady={() => setPreviewReady(true)}
                />
              ) : selectedTemplate?.editable ? (
                <LivePreview
                  draft={selectedTemplate.editable}
                  sample={false}
                  values={values}
                  invoiceNumber={invoice.invoice_number}
                />
              ) : selectedTemplate ? (
                <WaiverPdfPreview
                  key={selectedTemplate.id}
                  url={`/api/invoices/${invoice.id}/waiver-templates/${selectedTemplate.id}`}
                />
              ) : (
                <div className="m-auto max-w-64 space-y-3 text-center">
                  <FileText className="mx-auto size-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">
                    Your waiver, ready for this project.
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Choose a template to preview the document with the details
                    on the left.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
  if (embedded)
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {content}
      </section>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !signingBusy) onClose();
      }}
    >
      <MotionDialogContent
        initial={false}
        animate={{
          maxWidth: signingId ? "min(1344px,96vw)" : "min(1160px,96vw)",
        }}
        transition={{
          duration: reducedMotion ? 0 : 0.24,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="flex h-[min(850px,92dvh)] flex-col gap-0 overflow-hidden rounded-none p-0 sm:rounded-none"
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (busy || signingBusy) event.preventDefault();
        }}
        showCloseButton={!busy && !signingBusy}
      >
        {content}
      </MotionDialogContent>
    </Dialog>
  );
}

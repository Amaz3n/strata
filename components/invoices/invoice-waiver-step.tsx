"use client";
import { physicalWaiverTemplate } from "@/lib/templates/waiver-physical";
import { waiverNeedsSigningLinks } from "@/lib/templates/waiver-engine";
import { WaiverCustomFields } from "./waiver-custom-fields";
import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "framer-motion";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  waiverInvoiceRevision,
  withInvoiceWaiverFields,
  type WaiverInvoiceSource,
} from "@/lib/invoices/waiver-composer-state";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
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
  INVOICE_WAIVER_TYPE_LABELS,
  type Invoice,
  type InvoiceLienWaiver,
} from "@/lib/types";
import {
  prepareWaiverSchema,
  chooseBillingWaiverTemplate,
  readWaiverWorkflow,
  type PrepareWaiverInput,
  type WaiverTemplate,
} from "@/lib/lien-waivers/invoice-waiver";
import {
  editableWaiverValues,
  formatWaiverAmount,
  parseWaiverAmount,
} from "@/lib/lien-waivers/preparation";
import { WAIVER_SIGNATURE_CONSENT } from "@/lib/invoices/waiver-self-signing";
import { unwrapAction } from "@/lib/action-result";
import {
  loadWaiverPreparationAction,
  prepareWaiverAction,
  refreshWaiverSigningAction,
  setWaiverPacketAction,
  loadWaiverSignersAction,
} from "@/app/(app)/invoices/waiver-actions";
import { uploadExecutedWaiverAction } from "@/app/(app)/invoices/physical-waiver-actions";
import type { loadInvoiceWaiverPreparation } from "@/lib/services/invoice-waiver-workflow";
import { formatMoneyFromCents } from "./invoice-presentation";
// pdf.js needs the browser (DOMMatrix); it is never rendered on the server.
const WaiverPdfPreview = dynamic(() => import("./waiver-pdf-preview").then((m) => m.WaiverPdfPreview), { ssr: false });
const LivePreview = dynamic(
  () => import("@/components/settings/waiver-template-live-preview"),
  {
    ssr: false,
    loading: () => (
      <div className="p-10 text-sm text-muted-foreground">Loading preview…</div>
    ),
  },
);
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
export interface WaiverDeliveryReview {
  waiver: InvoiceLienWaiver | null;
  signer: { id: string; name: string; email: string } | null;
  isSelf: boolean;
  ready: boolean;
  physical?: boolean;
}
export interface InvoiceWaiverStepHandle {
  saveDraft: () => Promise<void>;
}

export const InvoiceWaiverStep = forwardRef<
  InvoiceWaiverStepHandle,
  {
    invoice: Invoice;
    draft?: InvoiceLienWaiver;
    readinessError?: string | null;
    source: WaiverInvoiceSource;
    initialRevision: string;
    active: boolean;
    persistInvoice: () => Promise<void>;
    mobilePreview: boolean;
    actionTarget: HTMLDivElement | null;
    onReadyChange: (ready: boolean) => void;
    onBusyChange: (busy: boolean) => void;
    onDeliveryChange: (review: WaiverDeliveryReview) => void;
    onReview: () => void;
  }
>(function InvoiceWaiverStep(
  {
    invoice,
    draft,
    readinessError,
    source,
    initialRevision,
    active,
    persistInvoice,
    mobilePreview,
    actionTarget,
    onReadyChange,
    onBusyChange,
    onDeliveryChange,
    onReview,
  },
  ref,
) {
  const [context, setContext] = useState<Preparation | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [draftInput, setInput] = useState<PrepareWaiverInput>(
    () =>
      (readWaiverWorkflow(draft ?? {})?.input
        ? {
            ...readWaiverWorkflow(draft ?? {})!.input,
            request_id: crypto.randomUUID(),
            replaces_draft_id: draft?.id,
          }
        : null) ?? {
        ...EMPTY,
        invoice_id: invoice.id,
        request_id: crypto.randomUUID(),
        amount_cents: invoice.balance_due_cents || invoice.total_cents || 0,
      },
  );
  const [customAmount, setCustomAmount] = useState(() =>
    Boolean(
      draft &&
      readWaiverWorkflow(draft)?.input.amount_cents !==
        source.preview.data.totalCents,
    ),
  );
  const input = useMemo(
    () => withInvoiceWaiverFields(draftInput, source, customAmount),
    [draftInput, source, customAmount],
  );
  const invoiceRevision = waiverInvoiceRevision(source);
  const preparedRevision = useRef(initialRevision);
  const [amount, setAmount] = useState(formatWaiverAmount(input.amount_cents));
  const [prepared, setPrepared] = useState<InvoiceLienWaiver | null>(
    readWaiverWorkflow(draft ?? {})?.input.execution_method === "physical" ||
    readWaiverWorkflow(draft ?? {})?.lifecycle === "signed" ||
      readWaiverWorkflow(draft ?? {})?.signing_document_id
      ? (draft ?? null)
      : null,
  );
  const [scan, setScan] = useState<File | null>(null);
  const [executedConfirmed, setExecutedConfirmed] = useState(false);
  const [deliveryComplete, setDeliveryComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [team, setTeam] = useState<
    { id: string; name: string; email: string }[]
  >([]);
  const [signerId, setSignerId] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  useEffect(() => {
    let active = true;
    loadWaiverSignersAction(invoice.id)
      .then(unwrapAction)
      .then((result) => {
        if (!active) return;
        setTeam(result.members);
        setCurrentUserId(result.currentUserId);
        const priorName = readWaiverWorkflow(draft ?? {})?.input.signer_name;
        const selected = result.members.find((member) =>
          priorName
            ? member.name === priorName
            : member.id === result.currentUserId,
        );
        setSignerId(selected?.id ?? "");
        if (selected && !draft)
          setInput((old) => ({ ...old, signer_name: selected.name }));
      })
      .catch((error) => {
        if (active) setFieldError(error.message);
      });
    return () => {
      active = false;
    };
  }, [invoice.id, draft]);
  const reducedMotion = useReducedMotion();
  const [selfSigning, setSelfSigning] = useState(false);
  const [signatureName, setSignatureName] = useState("");
  const [consent, setConsent] = useState(false);
  const [reviewedWaiverId, setReviewedWaiverId] = useState<string | null>(null);
  // Consent belongs to the exact prepared document, never an edited invoice.
  useEffect(() => {
    setConsent(false);
  }, [prepared?.id, invoiceRevision]);
  const guard = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (active) headingRef.current?.focus();
  }, [active, selfSigning]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const workflow = readWaiverWorkflow(prepared ?? {});
  const signed = workflow?.lifecycle === "signed";
  const preparedStale = Boolean(
    prepared && preparedRevision.current !== invoiceRevision,
  );
  const ready =
    signed &&
    !preparedStale &&
    !workflow?.needs_review &&
    Boolean(workflow?.shared) &&
    !(
      prepared?.id === draft?.id &&
      readWaiverWorkflow(draft ?? {})?.lifecycle === "signed" &&
      readinessError
    );
  const locked =
    Boolean(workflow?.signing_document_id) || signed || sent || selfSigning;
  useEffect(() => {
    onReadyChange(ready);
  }, [ready, onReadyChange]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (
      !active ||
      (!sent && !workflow?.signing_document_id) ||
      !prepared ||
      signed
    )
      return;
    let listening = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const latest = unwrapAction(
          await refreshWaiverSigningAction(invoice.id, prepared.id),
        );
        if (listening && readWaiverWorkflow(latest)?.lifecycle === "signed") {
          setPrepared(latest);
          setSelfSigning(false);
          return;
        }
      } catch {
        /* The signing page remains usable; retry after a transient read failure. */
      }
      if (listening) timer = setTimeout(check, 2500);
    };
    timer = setTimeout(check, 2500);
    return () => {
      listening = false;
      clearTimeout(timer);
    };
  }, [
    sent,
    prepared,
    invoice.id,
    signed,
    workflow?.signing_document_id,
    active,
  ]);
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
            chooseBillingWaiverTemplate(available, kind);
          setInput((old) => ({
            ...old,
            project_name: data.project_name,
            claimant_name: data.claimant_name,
            customer_name: data.customer_name,
            owner_name: data.owner_name,
            property_description: data.property_description,
            jurisdiction: data.jurisdiction,
            signer_name: old.signer_name || data.signer_name,
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
    return () => {
      cancelled = true;
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
  }
  function selectTemplate(t: WaiverTemplate) {
    const preferredSigner = team.find(member => member.name === t.editable?.defaults?.signerName);
    if (preferredSigner) setSignerId(preferredSigner.id);
    change("template_id", t.id);
    setInput((old) => ({
      ...old,
      source: "template",
      waiver_type: t.waiver_type,
      custom_values: {},
      additional_signers: [],
      signer_title: t.editable?.defaults?.signerTitle || old.signer_title,
      signer_name: preferredSigner?.name || old.signer_name,
      final_confirmed: false,
      received_confirmed: false,
      payment_id: undefined,
      payment_ids: [],
    }));
    setTemplateOpen(false);
  }
  const preparationRequest = useRef<{ content: string; id: string } | null>(
    null,
  );
  async function savePrepared(): Promise<InvoiceLienWaiver> {
    if (prepared && !preparedStale) {
      await persistInvoice();
      return prepared;
    }
    const parsed = prepareWaiverSchema.safeParse({
      ...input,
      execution_method: "physical",
      amount_cents: customAmount
        ? parseWaiverAmount(amount)
        : source.preview.data.totalCents,
      ...(preparedStale
        ? {
            request_id: crypto.randomUUID(),
            replaces_draft_id:
              workflow?.lifecycle === "draft" && !workflow.signing_document_id
                ? prepared?.id
                : undefined,
          }
        : {}),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const sharedFieldMessages: Record<string, string> = {
        claimant_name: "Add your company name in the invoice details.",
        customer_name: "Add the customer name in the invoice details.",
        owner_name:
          "Add the customer or property owner in the invoice details.",
      };
      throw new Error(
        sharedFieldMessages[String(issue.path[0])] ?? issue.message,
      );
    }
    const content = JSON.stringify({ ...parsed.data, request_id: undefined });
    if (preparationRequest.current?.content !== content)
      preparationRequest.current = { content, id: crypto.randomUUID() };
    parsed.data.request_id = preparationRequest.current.id;
    await persistInvoice();
    const form = new FormData();
    form.set("input", JSON.stringify(parsed.data));
    const result = unwrapAction(await prepareWaiverAction(form));
    await unwrapAction(
      await setWaiverPacketAction(invoice.id, true, result.id),
    );
    setInput(parsed.data);
    preparedRevision.current = invoiceRevision;
    setPrepared(result);
    return result;
  }
  useImperativeHandle(ref, () => ({
    saveDraft: async () => {
      if (guard.current)
        throw new Error("Wait for waiver preparation to finish");
      guard.current = true;
      setBusy(true);
      try {
        await savePrepared();
      } finally {
        guard.current = false;
        setBusy(false);
      }
    },
  }));
  async function finish() {
    if (guard.current || !signerId) return;
    guard.current = true;
    setBusy(true);
    setFieldError("");
    try {
      const waiver = await savePrepared();
      // Preparation is local to this draft. The final Send action requests the signature.
      onReview();
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
  const paperTemplate = useMemo(() => selectedTemplate?.editable ? physicalWaiverTemplate(selectedTemplate.editable) : undefined, [selectedTemplate?.editable]);
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
  const defaultSignerTemplate=useRef<string | undefined>(undefined);
  useEffect(()=>{
    if(draft || !selectedTemplate || !team.length || defaultSignerTemplate.current===selectedTemplate.id)return;
    defaultSignerTemplate.current=selectedTemplate.id;
    const name=selectedTemplate.editable?.defaults?.signerName;
    const member=team.find(m=>m.name===name);
    if(member){setSignerId(member.id);setInput(old=>({...old,signer_name:member.name,signer_title:selectedTemplate.editable?.defaults?.signerTitle||old.signer_title}));}
  },[selectedTemplate,team,draft]);
  const deliverySigner = team.find((member) => member.id === signerId) ?? null;
  useEffect(() => {
    onDeliveryChange({
      waiver: prepared,
      signer: deliverySigner,
      physical: true,
      isSelf: Boolean(signed),
      ready:
        !preparedStale &&
        !workflow?.needs_review &&
        Boolean(prepared) &&
        (signed ? ready : Boolean(deliverySigner)),
    });
  }, [
    prepared,
    deliverySigner,
    signerId,
    currentUserId,
    preparedStale,
    ready,
    workflow?.needs_review,
    onDeliveryChange,
    selectedTemplate?.editable,
  ]);
  const awaiting =
    sent ||
    (Boolean(workflow?.signing_document_id) &&
      (signerId !== currentUserId || waiverNeedsSigningLinks(selectedTemplate?.editable)) &&
      !signed);
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col lg:flex-row")}
      inert={!active}
      aria-hidden={!active}
    >
      {active &&
        actionTarget &&
        !ready &&
        createPortal(
          <Button
            size="sm"
            className="h-8 motion-safe:active:scale-[0.98] transition-transform"
            onClick={() => void finish()}
            disabled={
              !context ||
              busy ||
              (selfSigning &&
                !preparedStale &&
                (!consent ||
                  !signatureName.trim() ||
                  reviewedWaiverId !== prepared?.id)) ||
              signed ||
              !signerId ||
              (!prepared &&
                (!selectedTemplate || selectedTemplate.status === "draft"))
            }
          >
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {busy
              ? selfSigning && !preparedStale
                ? "Signing…"
                : "Preparing…"
              : awaiting
                ? "Review"
                : selfSigning && !preparedStale
                  ? "Sign waiver"
                  : "Prepare & review"}
          </Button>,
          actionTarget,
        )}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          mobilePreview && "hidden lg:block",
        )}
      >
        <motion.div
          initial={{ opacity: 0, x: reducedMotion ? 0 : 12 }}
          animate={{
            opacity: 1,
            x: 0,
          }}
          transition={{ duration: reducedMotion ? 0 : 0.18 }}
          className="mx-auto w-full max-w-2xl space-y-8 px-6 py-8 sm:px-8"
        >
          <div className="space-y-2">
            <h2
              tabIndex={-1}
              ref={headingRef}
              className="text-base font-semibold tracking-tight outline-none"
            >
              {preparedStale
                ? "Update waiver"
                : signed
                  ? "Waiver details"
                  : selfSigning
                    ? "Sign waiver"
                    : "Waiver details"}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {ready
                ? "Ready to send with your invoice."
                : selfSigning && !preparedStale
                  ? "Review the document, then add your signature."
                  : "Choose the waiver and signer. Invoice details stay in sync."}
            </p>
          </div>
          {workflow?.signing_document_id && !signed && <Button variant="outline" disabled={busy} onClick={() => {
            setPrepared(null);setSent(false);setSelfSigning(false);
            setInput(old => ({...old,execution_method:"physical",request_id:crypto.randomUUID(),replaces_draft_id:undefined}));
          }}>Prepare a new copy for physical signing</Button>}
          {prepared && !preparedStale && !workflow?.signing_document_id && (
            <section className="space-y-4 border p-4">
              <h3 className="text-sm font-medium">{signed ? "Executed waiver uploaded" : "Sign and notarize on paper"}</h3>
              <p className="text-xs text-muted-foreground">Download the waiver, have all required people sign it and complete notarization, then upload the fully executed PDF.</p>
              <Button asChild variant="outline"><a href={`/api/invoices/${invoice.id}/waivers/${prepared.id}`} target="_blank" rel="noreferrer">{signed ? "View executed waiver" : "Download waiver for signing"}</a></Button>
              {!signed && <>
                <Label htmlFor="executed-waiver-scan">Fully executed PDF</Label>
                <Input id="executed-waiver-scan" type="file" accept="application/pdf" disabled={busy} onChange={event => {setScan(event.target.files?.[0] ?? null);setExecutedConfirmed(false)}}/>
                <label className="flex items-start gap-2 text-xs"><Checkbox checked={executedConfirmed} disabled={busy} onCheckedChange={value => setExecutedConfirmed(value === true)}/>I confirm this scan contains all required signatures and completed notarization, including the notary’s seal where required.</label>
              </>}
              {deliveryComplete ? <p role="status" className="text-sm">Invoice and executed waiver submitted for delivery.</p> : invoice.metadata?.waiver_packet?.delivery_mode === "after_physical_execution" ? <Button disabled={busy || (!signed && (!scan || !executedConfirmed))} onClick={async () => {
                if (guard.current) return; guard.current=true;setBusy(true);setFieldError("");
                try {
                  const form=new FormData();form.set("invoiceId",invoice.id);form.set("waiverId",prepared.id);form.set("confirmed","true");form.set("file",scan ?? new File([],"retry.pdf"));
                  const result=unwrapAction(await uploadExecutedWaiverAction(form));setPrepared(result);setScan(null);setDeliveryComplete(true);
                } catch(error) {setFieldError(error instanceof Error ? error.message : "Could not upload the executed waiver")}
                finally {guard.current=false;setBusy(false)}
              }}>{busy ? "Submitting…" : signed ? "Retry invoice delivery" : "Mark executed and send invoice"}</Button> : <p className="text-xs text-muted-foreground">Continue to Review to confirm the customer recipients and save the invoice as awaiting this signed waiver. Then reopen the invoice to upload and send.</p>}
            </section>
          )}
          {!context ? (
            <div
              role={loadError ? "alert" : "status"}
              className="space-y-3 text-sm text-muted-foreground"
            >
              {loadError || "Getting your waiver ready…"}
              {loadError && (
                <Button
                  variant="outline"
                  onClick={() => setRetry((v) => v + 1)}
                >
                  Try again
                </Button>
              )}
            </div>
          ) : (
            <>
              {!ready &&
                (preparedStale ||
                  signed ||
                  (Boolean(readinessError) &&
                    Boolean(workflow?.signing_document_id))) && (
                  <div
                    className="space-y-3 rounded-lg border p-4"
                    role="status"
                  >
                    <p className="text-sm font-medium">
                      {preparedStale || signed
                        ? "The invoice has changed"
                        : awaiting
                          ? "Waiting for your company’s signature"
                          : "Review and sign the document"}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {preparedStale || signed
                        ? "Prepare a new waiver with the current invoice details before sending."
                        : awaiting
                          ? "You can save this draft and return after the signer finishes. The packet can be sent once the waiver is signed."
                          : "Review the waiver before signing."}
                    </p>
                    {!ready && (readinessError || preparedStale) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setInput((old) => ({
                            ...old,
                            request_id: crypto.randomUUID(),
                            replaces_draft_id: undefined,
                          }));
                          setPrepared(null);
                          setSent(false);
                          setSelfSigning(false);
                        }}
                      >
                        Prepare updated waiver
                      </Button>
                    )}
                  </div>
                )}
              {selfSigning && !preparedStale && !signed && (
                <motion.section
                  initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.16 }}
                  className="space-y-6"
                  aria-label="Your signature"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <p className="font-medium">{input.signer_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {input.signer_title} · {input.claimant_name}
                      </p>
                    </div>
                    {!workflow?.signing_document_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setSelfSigning(false);
                          setConsent(false);
                        }}
                      >
                        Edit details
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="waiver-signature">
                      Type your signature
                    </Label>
                    <Input
                      id="waiver-signature"
                      autoComplete="off"
                      maxLength={120}
                      value={signatureName}
                      disabled={busy}
                      onChange={(event) => {
                        setSignatureName(event.target.value);
                        setConsent(false);
                      }}
                      placeholder={input.signer_name}
                    />
                    <div
                      className="flex min-h-32 items-center justify-center overflow-hidden rounded-lg border bg-white p-6"
                      aria-label="Signature preview"
                    >
                      <span
                        className="break-all text-center text-3xl italic text-foreground"
                        style={{ fontFamily: "Georgia, serif" }}
                      >
                        {signatureName || "Your signature"}
                      </span>
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-muted-foreground">
                    <Checkbox
                      className="mt-0.5"
                      checked={consent}
                      disabled={busy}
                      onCheckedChange={(value) => setConsent(value === true)}
                    />
                    <span>{WAIVER_SIGNATURE_CONSENT}</span>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Your signed waiver will be included with the invoice.
                  </p>
                </motion.section>
              )}
              <fieldset
                disabled={locked || busy}
                className={cn(
                  "min-w-0 space-y-6 disabled:opacity-70",
                  (selfSigning || awaiting) && !preparedStale && "hidden",
                )}
              >
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
                                    : INVOICE_WAIVER_TYPE_LABELS[t.waiver_type]}
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
                    <p className="text-xs text-muted-foreground">
                      Amount covered
                    </p>
                    <p className="text-lg font-medium tabular-nums">
                      {formatMoneyFromCents(input.amount_cents)}
                    </p>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                      onClick={() => {
                        setCustomAmount((value) => !value);
                        setAmount(formatWaiverAmount(input.amount_cents));
                        change("amount_cents", input.amount_cents);
                      }}
                    >
                      {customAmount ? "Use invoice amount" : "Adjust coverage"}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="waiver-through" className="text-xs">
                      Work through
                    </Label>
                    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
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
                {customAmount && (
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
                )}
                {!context.property_description &&
                  textField("property_description", "Property / lot")}
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
<WaiverCustomFields template={paperTemplate} values={input.custom_values} onChange={v => change("custom_values", v)} />
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
                    I reviewed remaining retainage, changes, and claims. This is
                    the final payment for the scope described in the waiver.
                  </label>
                )}
                <div className="space-y-3 border-t pt-6">
                  <Label>Who signs this waiver?</Label>
                  <Select
                    value={signerId}
                    onValueChange={(value) => {
                      setSignerId(value);
                      const member = team.find((person) => person.id === value);
                      if (member) change("signer_name", member.name);
                    }}
                  >
                    <SelectTrigger aria-label="Waiver signer">
                      <SelectValue placeholder="Choose a team member" />
                    </SelectTrigger>
                    <SelectContent>
                      {team.map((member) => (
                        <SelectItem key={member.id} value={member.id}>
                          {member.name}
                          {member.id === currentUserId ? " (you)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Print the prepared waiver for the authorized signer and notary. No electronic signature requests will be sent.
                  </p>
                  {textField("signer_title", "Signer title")}
                </div>
              </fieldset>
            </>
          )}
          {fieldError && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
            >
              {fieldError}
            </p>
          )}
        </motion.div>
      </div>
      <aside
        className={cn(
          "min-h-0 flex-1 flex-col bg-muted/40 lg:flex lg:w-[46%] lg:max-w-[880px] lg:flex-none lg:shrink-0 lg:border-l",
          mobilePreview ? "flex" : "hidden",
        )}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.2 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {prepared && !preparedStale ? (
            <WaiverPdfPreview
              key={prepared.id}
              onReady={() => setReviewedWaiverId(prepared.id)}
              url={`/api/invoices/${invoice.id}/waivers/${prepared.id}?version=${workflow?.file_id ?? "prepared"}`}
            />
          ) : selectedTemplate?.editable ? (
            <LivePreview
              draft={paperTemplate!}
              sourceFileId={selectedTemplate.sourceFileId}
              customValues={input.custom_values}
              sample={false}
              values={values}
              invoiceNumber={source.preview.data.invoiceNumber}
            />
          ) : selectedTemplate ? (
            <WaiverPdfPreview
              key={selectedTemplate.id}
              url={`/api/invoices/${invoice.id}/waiver-templates/${selectedTemplate.id}`}
            />
          ) : (
            <div className="m-auto max-w-64 space-y-3 p-6 text-center text-sm text-muted-foreground">
              <FileText className="mx-auto size-8 opacity-50" />
              Choose a template to preview your waiver.
            </div>
          )}
        </motion.div>
      </aside>
    </div>
  );
});

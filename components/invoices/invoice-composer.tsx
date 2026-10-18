"use client";

import dynamic from "next/dynamic";
import {
  DocumentEditorLayout,
  DocumentEditorFields,
  DocumentPreviewPane,
  ScaledDocument,
} from "@/components/document-editor/document-editor-layout";
import { motion, useReducedMotion } from "framer-motion";
import {
  loadWaiverPacketAction,
  setWaiverPacketAction,
  sendInvoiceWithWaiverRequestAction,
} from "@/app/(app)/invoices/waiver-actions";
import { holdInvoiceForPhysicalWaiverAction } from "@/app/(app)/invoices/physical-waiver-actions";
import { Checkbox } from "@/components/ui/checkbox";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Eye,
  Loader2,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";

import type { Invoice, Project } from "@/lib/types";
import type { InvoiceInput } from "@/lib/validation/invoices";
import {
  getReceivablesPosturePolicy,
  getGeneralReceivablesPolicy,
} from "@/lib/receivables/policy";
import type { BillingProfile } from "@/lib/financials/billing-profile";
import type { NewInvoiceKind } from "@/lib/financials/invoice-destinations";
import {
  createInvoiceAction,
  generateInvoicePdfAction,
  deleteInvoiceAction,
  issueInvoiceAction,
  loadInvoiceComposerBootstrapAction,
  reserveInvoiceNumberAction,
  scheduleInvoiceSendAction,
  updateInvoiceAction,
} from "@/app/(app)/invoices/actions";
import { unwrapAction } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  isInvoiceRecipientValid,
  parseInvoiceRecipients,
} from "@/lib/invoices/composer-recipients";
import { Skeleton } from "@/components/ui/skeleton";

import { ArcInvoiceDocument } from "./arc-invoice-document";
import {
  InvoiceDocumentEditor,
  type AutosaveState,
  type InvoiceEditorHandle,
  type InvoiceEditorSnapshot,
} from "./invoice-document-editor";
import {
  formatDateOnly,
  formatMoneyFromCents,
  formatScheduledSend,
  isEditableInvoice,
} from "./invoice-presentation";
import { invalidateInvoiceDetail } from "./use-invoice-detail-cache";

/**
 * The composer: a form on the left, the customer's invoice on the right,
 * building as you type. The preview is the same renderer that produces the
 * portal page and the PDF, so what you see is what they get.
 *
 * It opens over the billing book, not on a route of its own, which is what
 * makes it immediate: no navigation, no server render, the form is on screen
 * in the same frame as the click. The URL still names it (`?compose=`) so it
 * can be linked and closed with Back. Everything it needs beyond the invoice
 * arrives in one round trip that the book warms while the pointer is still on
 * the button.
 */

export interface InvoiceComposerTarget {
  /** A draft to resume, or "new". */
  compose: string;
  duplicateOf?: string | null;
  sourceChangeOrderId?: string | null;
  customerId?: string | null;
  kind?: NewInvoiceKind | null;
}

import { waiverInvoiceRevision } from "@/lib/invoices/waiver-composer-state";
import { readWaiverWorkflow } from "@/lib/lien-waivers/invoice-waiver";
const PdfDocumentPreview = dynamic(
  () =>
    import("./waiver-pdf-preview").then((module) => module.PdfDocumentPreview),
  { ssr: false },
);
import type {
  WaiverDeliveryReview,
  InvoiceWaiverStepHandle,
} from "./invoice-waiver-step";

const WaiverStep = dynamic(
  () => import("./invoice-waiver-step").then((m) => m.InvoiceWaiverStep),
  {
    ssr: false,
    loading: () => (
      <p className="m-auto text-sm text-muted-foreground">Opening waiver…</p>
    ),
  },
);

type Bootstrap = Extract<
  Awaited<ReturnType<typeof loadInvoiceComposerBootstrapAction>>,
  { success: true }
>["data"];

type BootstrapKey = string;

const bootstrapCache = new Map<BootstrapKey, Promise<Bootstrap>>();

function bootstrapKey(
  projectId: string | undefined,
  target: Pick<InvoiceComposerTarget, "compose" | "duplicateOf">,
) {
  return `${projectId}:${target.compose}:${target.duplicateOf ?? ""}`;
}

function loadBootstrap(
  projectId: string | undefined,
  target: Pick<InvoiceComposerTarget, "compose" | "duplicateOf">,
) {
  const key = bootstrapKey(projectId, target);
  const cached = bootstrapCache.get(key);
  if (cached) return cached;
  const request = loadInvoiceComposerBootstrapAction({
    projectId,
    draftId: target.compose === "new" ? null : target.compose,
    duplicateId: target.duplicateOf ?? null,
  })
    .then((result) => unwrapAction(result))
    .catch((error) => {
      bootstrapCache.delete(key);
      throw error;
    });
  bootstrapCache.set(key, request);
  // A warmed bootstrap goes stale: contacts get added, accounts change. Keep it
  // for a minute, which covers hover-to-click and nothing more.
  window.setTimeout(() => {
    if (bootstrapCache.get(key) === request) bootstrapCache.delete(key);
  }, 60_000);
  return request;
}

/** Warm the composer's data while the pointer rests on the button that opens it. */
export function prefetchInvoiceComposer(projectId?: string) {
  void loadBootstrap(projectId, { compose: "new" }).catch(() => null);
}

interface InvoiceComposerProps {
  project: Project | null;
  profile: BillingProfile;
  target: InvoiceComposerTarget;
  onClose: (invoiceId?: string | null) => void;
  onIssued: (invoice: Invoice) => void;
}

export function InvoiceComposer({
  project,
  profile,
  target,
  onClose,
  onIssued,
}: InvoiceComposerProps) {
  const policy = project
    ? getReceivablesPosturePolicy(profile.posture)
    : getGeneralReceivablesPolicy();
  const reducedMotion = useReducedMotion();
  const [sendFeedback, setSendFeedback] = useState<{
    invoice?: Invoice;
    awaitingSignature: boolean;
  } | null>(null);
  const finishSendFeedback = () => {
    if (!sendFeedback?.invoice) return;
    if (sendFeedback.awaitingSignature) onClose(sendFeedback.invoice.id);
    else onIssued(sendFeedback.invoice);
  };

  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  const editorRef = useRef<InvoiceEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const isNew = target.compose === "new";

  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [reservation, setReservation] = useState<{
    number: string;
    reservationId: string | null;
  } | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState>("idle");
  const [snapshot, setSnapshot] = useState<InvoiceEditorSnapshot | null>(null);
  const invoicePreview = snapshot?.preview;
  const waiverSource = useMemo(
    () =>
      invoicePreview && project
        ? { projectName: project.name, preview: invoicePreview }
        : null,
    [project, invoicePreview],
  );
  const [draftId, setDraftId] = useState<string | null>(
    isNew ? null : target.compose,
  );
  const [packetView, setPacketView] = useState<"invoice" | "waiver" | "review">(
    "invoice",
  );
  const [includeWaiver, setIncludeWaiver] = useState(false);
  const [packetBusy, setPacketBusy] = useState(false);
  useEffect(() => {
    if (bootstrap?.draft)
      setIncludeWaiver(
        Boolean(bootstrap.draft.metadata?.waiver_packet?.enabled),
      );
  }, [bootstrap?.draft]);
  const waiverRef = useRef<InvoiceWaiverStepHandle>(null);
  const [waiverData, setWaiverData] = useState<
    | Extract<
        Awaited<ReturnType<typeof loadWaiverPacketAction>>,
        { success: true }
      >["data"]
    | null
  >(null);
  const [waiverBaseRevision, setWaiverBaseRevision] = useState("");
  const [waiverLoadError, setWaiverLoadError] = useState<string | null>(null);
  const [waiverReady, setWaiverReady] = useState(false);
  const [deliveryReview, setDeliveryReview] =
    useState<WaiverDeliveryReview | null>(null);
  const separateSignature =
    includeWaiver && Boolean(deliveryReview && !deliveryReview.isSelf);
  const canReview = !includeWaiver || Boolean(deliveryReview?.ready);
  const openReview = useCallback(() => {
    setPacketView("review");
    setMobilePreview(false);
  }, []);
  const [reviewDocument, setReviewDocument] = useState<"invoice" | "waiver">(
    "invoice",
  );
  const [reviewPdf, setReviewPdf] = useState<{
    revision: string;
    url: string;
  } | null>(null);
  const [reviewPdfError, setReviewPdfError] = useState("");
  const [reviewPdfRetry, setReviewPdfRetry] = useState(0);
  const reviewRevision = JSON.stringify(snapshot?.preview ?? null);
  const reviewPdfCache = useRef<{ revision: string; url: string } | null>(null);
  const reviewPdfRequest = useRef<{
    revision: string;
    promise: Promise<{ revision: string; url: string }>;
  } | null>(null);
  useEffect(() => {
    if (separateSignature) setSendMode("now");
  }, [separateSignature]);
  useEffect(() => {
    if (packetView === "review")
      document.getElementById("invoice-review-heading")?.focus();
  }, [packetView]);
  useEffect(() => {
    if (packetView !== "review" || !snapshot?.complete) return;
    if (reviewPdfCache.current?.revision === reviewRevision) {
      setReviewPdf(reviewPdfCache.current);
      return;
    }
    let cancelled = false;
    setReviewPdfError("");
    if (reviewPdfRequest.current?.revision !== reviewRevision) {
      const promise = (async () => {
        const id = await editorRef.current?.saveDraft();
        if (!id) throw new Error("Complete the invoice to preview its PDF");
        const pdf = unwrapAction(
          await generateInvoicePdfAction(id, { persistToArc: false }),
        );
        if (!pdf.pdfBase64)
          throw new Error("Could not generate the invoice preview");
        const result = {
          revision: reviewRevision,
          url: `data:application/pdf;base64,${pdf.pdfBase64}`,
        };
        reviewPdfCache.current = result;
        return result;
      })();
      reviewPdfRequest.current = { revision: reviewRevision, promise };
    }
    void reviewPdfRequest.current.promise
      .then((result) => {
        if (!cancelled) setReviewPdf(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setReviewPdfError(error.message);
          reviewPdfRequest.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [packetView, snapshot?.complete, reviewRevision, reviewPdfRetry]);

  const [waiverWorking, setWaiverWorking] = useState(false);
  const [waiverActionTarget, setWaiverActionTarget] =
    useState<HTMLDivElement | null>(null);
  const packetGuard = useRef(false);
  async function toggleWaiver(enabled: boolean) {
    if (packetGuard.current) return;
    // Selection is local until a draft exists; it never changes steps.
    if (!draftIdRef.current) {
      setIncludeWaiver(enabled);
      return;
    }
    const previous = includeWaiver;
    setIncludeWaiver(enabled);
    packetGuard.current = true;
    setPacketBusy(true);
    try {
      unwrapAction(await setWaiverPacketAction(draftIdRef.current, enabled));
      setIncludeWaiver(enabled);
    } catch (error) {
      setIncludeWaiver(previous);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update waiver selection",
      );
    } finally {
      packetGuard.current = false;
      setPacketBusy(false);
    }
  }
  const loadWaiverStep = useCallback(async () => {
    if (packetGuard.current || waiverData) return;
    packetGuard.current = true;
    setPacketBusy(true);
    setWaiverLoadError(null);
    const revision = waiverSource ? waiverInvoiceRevision(waiverSource) : "";
    void import("./invoice-waiver-step");
    try {
      const id = await editorRef.current?.saveDraft();
      if (!id) throw new Error("Complete the invoice details first");
      unwrapAction(await setWaiverPacketAction(id, true));
      setWaiverBaseRevision(revision);
      setWaiverData(unwrapAction(await loadWaiverPacketAction(id)));
    } catch (error) {
      setWaiverLoadError(
        error instanceof Error
          ? error.message
          : "Could not load waiver details",
      );
    } finally {
      packetGuard.current = false;
      setPacketBusy(false);
    }
  }, [waiverData, waiverSource]);
  // Warm the step once while the preparer is still editing the invoice.
  // Re-entry never saves, fetches, validates, or remounts either editor.
  useEffect(() => {
    if (
      includeWaiver &&
      snapshot?.complete &&
      !waiverData &&
      !waiverLoadError &&
      !packetBusy
    )
      void loadWaiverStep();
  }, [
    includeWaiver,
    snapshot?.complete,
    waiverData,
    waiverLoadError,
    packetBusy,
    loadWaiverStep,
  ]);
  function openWaiver() {
    setMobilePreview(false);
    setPacketView("waiver");
  }
  function backToInvoice() {
    setPacketView("invoice");
    setMobilePreview(false);
  }
  const persistInvoiceForWaiver = useCallback(async () => {
    const id = await editorRef.current?.saveDraft();
    if (!id)
      throw new Error(
        "Complete the invoice details before preparing the waiver",
      );
  }, []);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [numberError, setNumberError] = useState<string | null>(null);
  const [numberWarning, setNumberWarning] = useState<string | null>(null);
  const [numberLoading, setNumberLoading] = useState(false);
  const [recipients, setRecipients] = useState("");
  const [recipientsTouched, setRecipientsTouched] = useState(false);
  const [recipientDraft, setRecipientDraft] = useState("");
  const [busy, setBusy] = useState<
    | "send"
    | "schedule"
    | "approval"
    | "approve"
    | "pdf"
    | "close"
    | "save"
    | "discard"
    | null
  >(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [sendMode, setSendMode] = useState<"now" | "later">("now");
  const [sendAt, setSendAt] = useState("");
  useEffect(() => {
    if (sendMode === "later" && !sendAt) setSendAt(defaultSendAt());
  }, [sendMode, sendAt]);
  const busyRef = useRef(false);
  const recoveryKey = bootstrap
    ? `arc:invoice:v1:${bootstrap.recoveryScope}:${project?.id}:${target.compose}:${target.duplicateOf ?? ""}:${target.sourceChangeOrderId ?? ""}:${target.kind ?? ""}:${target.customerId ?? ""}`
    : undefined;
  const clearRecovery = () => {
    if (recoveryKey) {
      try {
        sessionStorage.removeItem(recoveryKey);
      } catch {
        /* Storage may be disabled. */
      }
    }
  };
  const reservationIdRef = useRef<string | null>(null);
  const draftIdRef = useRef<string | null>(isNew ? null : target.compose);
  useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);

  useEffect(() => {
    let cancelled = false;
    loadBootstrap(project?.id, target)
      .then(async (data) => {
        let loaded = data;
        if (isNew) {
          const key = `arc:invoice:v1:${data.recoveryScope}:${project?.id}:${target.compose}:${target.duplicateOf ?? ""}:${target.sourceChangeOrderId ?? ""}:${target.kind ?? ""}:${target.customerId ?? ""}`;
          let recoveredId: string | undefined;
          try {
            recoveredId = JSON.parse(
              sessionStorage.getItem(key) ?? "null",
            )?.invoiceId;
          } catch {
            /* An unavailable recovery copy does not block a new invoice. */
          }
          if (recoveredId) {
            // Fetch the current server revision before replaying local edits.
            loaded = unwrapAction(
              await loadInvoiceComposerBootstrapAction({
                projectId: project?.id,
                draftId: recoveredId,
              }),
            );
            if (loaded.draft && !isEditableInvoice(loaded.draft)) {
              sessionStorage.removeItem(key);
              loaded = data;
              toast.info(
                "The recovered invoice is no longer editable. Starting a new invoice.",
              );
            } else if (!cancelled) {
              setDraftId(recoveredId);
              draftIdRef.current = recoveredId;
            }
          }
        }
        if (!cancelled) setBootstrap(loaded);
      })
      .catch((error) => {
        if (!cancelled)
          setBootstrapError(
            error instanceof Error
              ? error.message
              : "Could not open the composer.",
          );
      });
    if (isNew) {
      setNumberLoading(true);
      reserveInvoiceNumberAction(project?.id)
        .then((result) => {
          const reserved = unwrapAction(result);
          if (cancelled || draftIdRef.current) {
            if (reserved.reservationId)
              navigator.sendBeacon(
                "/api/invoices/release-reservation",
                new Blob(
                  [JSON.stringify({ reservation_id: reserved.reservationId })],
                  { type: "application/json" },
                ),
              );
            return;
          }
          reservationIdRef.current = reserved.reservationId;
          setReservation(reserved);
          setNumberWarning(reserved.warning ?? null);
        })
        .catch((error) => {
          if (!cancelled)
            setNumberError(
              error instanceof Error
                ? error.message
                : "Could not reserve an invoice number",
            );
        })
        .finally(() => {
          if (!cancelled) setNumberLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, target.compose, target.duplicateOf]);

  // The recipients field follows the customer until the person edits it.
  useEffect(() => {
    if (recipientsTouched || !snapshot) return;
    setRecipients(snapshot.recipients.join(", "));
  }, [recipientsTouched, snapshot]);

  // Release the reserved invoice number only when the session ends WITHOUT
  // producing a draft. The old cleanup raced an unmount autosave that was still
  // claiming the same reservation, so a number could be handed back and consumed
  // at the same time.
  useEffect(() => {
    return () => {
      const reservationId = reservationIdRef.current;
      if (!reservationId || draftIdRef.current) return;
      const body = JSON.stringify({ reservation_id: reservationId });
      const beaconSent = navigator.sendBeacon?.(
        "/api/invoices/release-reservation",
        new Blob([body], { type: "application/json" }),
      );
      if (beaconSent) return;
      void fetch("/api/invoices/release-reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => null);
    };
  }, []);

  // Escape closes (the draft is already saved); ⌘S saves and closes; ⌘Enter opens Send.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        Boolean(sendFeedback) ||
        event.defaultPrevented ||
        event.repeat ||
        busy !== null ||
        packetBusy ||
        waiverWorking
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void (packetView === "invoice"
          ? handleSaveAndClose()
          : handleSaveDraft());
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === "Enter"
      ) {
        event.preventDefault();
        if (includeWaiver && packetView === "invoice") {
          void openWaiver();
          return;
        }
        if (snapshot && canReview) {
          setSendMode("now");
          openReview();
        }
        return;
      }
      if (event.key !== "Escape") return;
      // Escape inside a nested dialog, popover or listbox belongs to it; only a
      // bare Escape on the composer itself closes the composer.
      const origin = event.target as HTMLElement | null;
      const nearest = origin?.closest(
        "[role='dialog'], [role='listbox'], [data-radix-popper-content-wrapper]",
      );
      if (nearest && nearest !== rootRef.current) return;
      requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handleCreateDraft = useCallback(
    async (input: InvoiceInput): Promise<Invoice> => {
      const created = unwrapAction(
        await createInvoiceAction({
          ...input,
          metadata: {
            ...input.metadata,
            ...(includeWaiver ? { waiver_packet: { enabled: true } } : {}),
          },
        }),
      );
      setDraftId(created.id);
      draftIdRef.current = created.id;
      reservationIdRef.current = null;
      return created;
    },
    [includeWaiver],
  );

  const handleAutosave = useCallback(
    async (invoiceId: string, input: InvoiceInput): Promise<Invoice> => {
      return unwrapAction(await updateInvoiceAction(invoiceId, input));
    },
    [],
  );

  const savedRecipients = parseInvoiceRecipients(recipients);
  // Include the uncommitted input in validation and sending, so a click cannot
  // race the input's blur handler and omit the last address.
  const parsedRecipients = parseInvoiceRecipients(
    [recipients, recipientDraft].join(","),
  );
  const commitRecipients = (value: string) => {
    setRecipientsTouched(true);
    setRecipients(
      parseInvoiceRecipients([recipients, value].join(",")).join(", "),
    );
    setRecipientDraft("");
  };
  const retryNumber = async () => {
    if (numberLoading) return;
    setNumberLoading(true);
    setNumberError(null);
    try {
      const reserved = unwrapAction(
        await reserveInvoiceNumberAction(project?.id),
      );
      reservationIdRef.current = reserved.reservationId;
      setReservation(reserved);
      setNumberWarning(reserved.warning ?? null);
    } catch (error) {
      setNumberError(
        error instanceof Error ? error.message : "Could not reserve a number",
      );
    } finally {
      setNumberLoading(false);
    }
  };

  const approvalRequired = policy.approvalMode === "required_review";
  const approvalStatus =
    snapshot?.approvalStatus ?? (approvalRequired ? "draft" : "not_required");
  const approved = !approvalRequired || approvalStatus === "approved";

  const problems: Array<{ field: string; message: string }> = [
    ...(snapshot?.problems ?? []),
  ];
  if (snapshot && snapshot.totalCents <= 0)
    problems.push({
      field: "invoice-items",
      message: "The invoice total must be greater than zero.",
    });
  if (parsedRecipients.length === 0)
    problems.push({
      field: "composer-recipients",
      message: "Add at least one billing email address.",
    });
  else if (parsedRecipients.some((value) => !isInvoiceRecipientValid(value)))
    problems.push({
      field: "composer-recipients",
      message: "Check the highlighted email addresses.",
    });
  if (!approved)
    problems.push({
      field: "approval",
      message: "This invoice needs approval before sending.",
    });
  if (
    sendMode === "later" &&
    (!sendAt ||
      !Number.isFinite(new Date(sendAt).getTime()) ||
      new Date(sendAt).getTime() <= Date.now())
  )
    problems.push({
      field: "composer-send-at",
      message: "Choose a future date and time.",
    });

  const fixProblem = (field: string) => {
    if (field.startsWith("composer-")) {
      document.getElementById(field)?.focus();
      return;
    }
    requestAnimationFrame(() => editorRef.current?.focusField(field));
    setPacketView("invoice");
    setMobilePreview(false);
  };

  async function withBusy(
    key: NonNullable<typeof busy>,
    fn: () => Promise<void>,
  ) {
    if (busyRef.current || packetGuard.current || waiverWorking) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  const handleSaveDraft = () =>
    withBusy("save", async () => {
      try {
        if (includeWaiver) await waiverRef.current?.saveDraft();
        const id = await editorRef.current?.saveDraft();
        if (id) {
          invalidateInvoiceDetail(id);
          toast.success("Draft saved");
        }
      } catch (error) {
        toast.error("Could not save the draft", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    });

  const handleSaveAndClose = () =>
    withBusy("close", async () => {
      try {
        if (snapshot?.complete) {
          if (includeWaiver) await waiverRef.current?.saveDraft();
          const id = await editorRef.current?.saveDraft();
          if (id && includeWaiver)
            unwrapAction(await setWaiverPacketAction(id, true));
          await editorRef.current?.discard();
          clearRecovery();
          if (id) invalidateInvoiceDetail(id);
          onClose(id ?? draftIdRef.current);
        } else if (snapshot?.dirty) {
          setLeavePrompt(true);
        } else {
          onClose(draftIdRef.current);
        }
      } catch (error) {
        toast.error("Could not save the draft", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    });

  /**
   * Leaving a NEW invoice is a decision: keep what was typed as a draft, or
   * throw it away. Resuming an existing draft never asks — it was a draft
   * before you opened it. An untouched new invoice just closes.
   */
  const requestClose = () => {
    if (sendFeedback) {
      finishSendFeedback();
      return;
    }
    if (busyRef.current || packetBusy || waiverWorking) return;
    const touched = Boolean(draftIdRef.current) || Boolean(snapshot?.dirty);
    if (isNew && touched) {
      setLeavePrompt(true);
      return;
    }
    void handleSaveAndClose();
  };

  const handleDiscard = () =>
    withBusy("discard", async () => {
      try {
        await editorRef.current?.discard();
        const id = draftIdRef.current;
        if (id) {
          unwrapAction(await deleteInvoiceAction(id));
          invalidateInvoiceDetail(id);
        }
        // Nothing to keep: the unmount cleanup hands the reserved number back.
        draftIdRef.current = null;
        clearRecovery();
        setLeavePrompt(false);
        onClose(null);
      } catch (error) {
        editorRef.current?.resumeSaving();
        toast.error("Could not discard the draft", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    });

  const handleSend = () =>
    withBusy("send", async () => {
      try {
        setSendFeedback({ awaitingSignature: separateSignature });
        const id = await editorRef.current?.persist();
        if (!id) throw new Error("Complete the invoice before sending it");
        const issued = unwrapAction(
          separateSignature && deliveryReview?.waiver && deliveryReview.signer
            ? deliveryReview.physical
              ? await holdInvoiceForPhysicalWaiverAction(
                  id,
                  deliveryReview.waiver.id,
                  parsedRecipients,
                )
              : await sendInvoiceWithWaiverRequestAction(
                  id,
                  deliveryReview.waiver.id,
                  deliveryReview.signer.id,
                  parsedRecipients,
                )
            : await issueInvoiceAction(id, parsedRecipients),
        );
        if (
          separateSignature &&
          deliveryReview?.physical &&
          deliveryReview.waiver
        ) {
          const link = document.createElement("a");
          link.href = `/api/invoices/${id}/waivers/${deliveryReview.waiver.id}?download=1`;
          link.download = "lien-waiver.pdf";
          document.body.appendChild(link);
          link.click();
          link.remove();
        }
        await editorRef.current?.discard();
        clearRecovery();
        invalidateInvoiceDetail(issued.id);
        setSendFeedback({
          invoice: issued,
          awaitingSignature: separateSignature,
        });
      } catch (error) {
        setSendFeedback(null);
        toast.error("Could not send the invoice", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    });

  const handleSchedule = () =>
    withBusy("schedule", async () => {
      try {
        const id = await editorRef.current?.persist();
        if (!id) throw new Error("Complete the invoice before scheduling it");
        const result = unwrapAction(
          await scheduleInvoiceSendAction(
            id,
            parsedRecipients,
            new Date(sendAt).toISOString(),
          ),
        );
        toast.success("Send scheduled", {
          description: `Goes out ${formatScheduledSend(result.scheduledSendAt)} to ${parsedRecipients.join(", ")}`,
        });
        await editorRef.current?.discard();
        clearRecovery();
        invalidateInvoiceDetail(id);
        onClose(id);
      } catch (error) {
        toast.error("Could not schedule the send", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    });

  const editorReady = Boolean(bootstrap);
  const initialInvoice = bootstrap?.draft ?? null;
  const title = initialInvoice
    ? `Invoice ${initialInvoice.invoice_number}`
    : "New invoice";

  const reviewDocumentTabs = (
    <div className="flex items-center gap-1" aria-label="Review documents">
      <Button
        variant={reviewDocument === "invoice" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setReviewDocument("invoice")}
      >
        Invoice
      </Button>
      {includeWaiver && deliveryReview?.waiver && (
        <Button
          variant={reviewDocument === "waiver" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setReviewDocument("waiver")}
        >
          Waiver
        </Button>
      )}
    </div>
  );

  if (!portalReady) return null;
  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in duration-150 motion-reduce:animate-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header
        inert={Boolean(sendFeedback)}
        className="grid min-h-14 shrink-0 grid-cols-[auto_1fr] items-center lg:grid-cols-[1fr_auto_1fr] gap-x-3 gap-y-2 border-b px-3 py-2 sm:px-4"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={requestClose}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
          <h1 className="sr-only">{title}</h1>
        </div>
        <nav
          aria-label="Invoice preparation"
          className="col-span-2 row-start-2 flex items-center justify-center gap-2 text-xs lg:col-span-1 lg:col-start-2 lg:row-start-1"
        >
          {(
            ["invoice", ...(includeWaiver ? ["waiver"] : []), "review"] as const
          ).map((step, index) => (
            <button
              key={step}
              type="button"
              aria-current={packetView === step ? "step" : undefined}
              disabled={busy !== null || (step === "review" && !canReview)}
              onClick={() =>
                step === "invoice"
                  ? backToInvoice()
                  : step === "waiver"
                    ? openWaiver()
                    : openReview()
              }
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 transition-colors disabled:opacity-40",
                packetView === step
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center border text-[10px] transition-colors",
                  packetView === step &&
                    "border-foreground bg-foreground text-background",
                )}
              >
                {index + 1}
              </span>
              {step === "invoice"
                ? "Invoice"
                : step === "waiver"
                  ? "Waiver"
                  : "Review"}
            </button>
          ))}
        </nav>
        <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-1 sm:gap-2 lg:col-start-3">
          <Button
            size="sm"
            variant="outline"
            className="h-8 lg:hidden"
            aria-label={mobilePreview ? "Edit details" : "Preview document"}
            onClick={() => setMobilePreview((value) => !value)}
          >
            <Eye className="size-4 sm:mr-1.5" />
            <span className="hidden sm:inline">
              {mobilePreview ? "Edit" : "Preview"}
            </span>
          </Button>
          {packetView === "invoice" ? (
            <div className="flex items-center">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-r-none border-r-0"
                disabled={
                  busy !== null ||
                  waiverWorking ||
                  packetBusy ||
                  autosave === "saving"
                }
                onClick={() => void handleSaveAndClose()}
              >
                Save and close
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 rounded-l-none"
                    aria-label="More save options"
                    disabled={busy !== null || waiverWorking}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!snapshot?.complete || packetBusy}
                    onSelect={() =>
                      void withBusy("pdf", async () => {
                        if (includeWaiver) await waiverRef.current?.saveDraft();
                        await editorRef.current?.saveDraft();
                        await editorRef.current?.downloadPdf();
                      })
                    }
                  >
                    <Download className="mr-2 size-4" />
                    Save and download
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              disabled={busy !== null || waiverWorking}
              onClick={() => void handleSaveDraft()}
            >
              Save draft
            </Button>
          )}
          {packetView === "review" ? (
            <Button
              size="sm"
              className="h-8"
              disabled={
                busy !== null ||
                waiverWorking ||
                !snapshot?.complete ||
                problems.length > 0 ||
                !canReview ||
                reviewPdf?.revision !== reviewRevision
              }
              onClick={() =>
                void (sendMode === "later" && !separateSignature
                  ? handleSchedule()
                  : handleSend())
              }
            >
              {busy === "send" || busy === "schedule" ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Send className="mr-1.5 size-3.5" />
              )}
              {busy === "send" || busy === "schedule"
                ? "Sending…"
                : sendMode === "later" && !separateSignature
                  ? "Schedule"
                  : separateSignature
                    ? "Save · awaiting signed waiver"
                    : "Send"}
            </Button>
          ) : includeWaiver && packetView === "invoice" ? (
            <Button
              size="sm"
              className="h-8 transition-transform motion-safe:active:scale-[0.98]"
              disabled={busy !== null}
              onClick={() => void openWaiver()}
            >
              Next
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          ) : includeWaiver && packetView === "waiver" && !waiverReady ? (
            <div ref={setWaiverActionTarget} className="flex items-center" />
          ) : approvalRequired && !approved ? (
            approvalStatus === "pending" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy !== null}
                onClick={() =>
                  void withBusy(
                    "approve",
                    () => editorRef.current?.approve() ?? Promise.resolve(),
                  )
                }
              >
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                {busy === "approve" ? "Approving…" : "Approve as reviewer"}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8"
                disabled={busy !== null || !snapshot?.complete}
                onClick={() =>
                  void withBusy(
                    "approval",
                    () =>
                      editorRef.current?.requestApproval() ?? Promise.resolve(),
                  )
                }
              >
                {busy === "approval" ? "Submitting…" : "Request approval"}
              </Button>
            )
          ) : (
            <Button
              size="sm"
              className="h-8"
              disabled={busy !== null || !snapshot || !canReview}
              onClick={openReview}
            >
              Review
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          )}
        </div>
      </header>

      <div
        inert={Boolean(sendFeedback)}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {snapshot && (
          <div
            className={cn(
              "absolute inset-0 flex min-h-0 flex-col lg:flex-row transition-opacity duration-200 motion-reduce:transition-none",
              packetView === "review"
                ? "z-10 opacity-100"
                : "pointer-events-none z-0 opacity-0",
            )}
            aria-hidden={packetView !== "review"}
            inert={packetView !== "review" || busy !== null}
          >
            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto",
                mobilePreview && "hidden lg:block",
              )}
            >
              <div className="mx-auto max-w-xl space-y-8 px-6 py-10 sm:px-8 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
                <div className="space-y-6">
                  <div className="space-y-1.5">
                    <h2
                      tabIndex={-1}
                      className="text-xl font-semibold tracking-tight outline-none"
                      id="invoice-review-heading"
                    >
                      Ready to send
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {project?.name ?? "General billing"} · Invoice{" "}
                      {snapshot?.preview.data.invoiceNumber}
                    </p>
                  </div>
                  <div className="flex items-end justify-between gap-6 border-b pb-6">
                    <p className="text-4xl font-medium tracking-tight tabular-nums">
                      {formatMoneyFromCents(snapshot?.totalCents ?? 0)}
                    </p>
                    <div className="text-right text-xs leading-relaxed text-muted-foreground">
                      Due
                      <p className="mt-1 text-sm text-foreground">
                        {snapshot?.dueDate
                          ? formatDateOnly(snapshot.dueDate, { withYear: true })
                          : "—"}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="space-y-6">
                  {sendMode === "later" && !separateSignature ? (
                    <div className="space-y-1.5 animate-in fade-in duration-150 motion-reduce:animate-none">
                      <label
                        htmlFor="composer-send-at"
                        className="text-xs font-medium text-muted-foreground"
                      >
                        Send on
                      </label>
                      <Input
                        id="composer-send-at"
                        type="datetime-local"
                        value={sendAt}
                        min={defaultSendAt()}
                        onChange={(event) => setSendAt(event.target.value)}
                        className="h-9"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        The draft stays editable until then. Cancel from the
                        invoice if plans change.
                      </p>
                    </div>
                  ) : null}
                  <div className="space-y-3">
                    <label
                      htmlFor="composer-recipients"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      To customer
                    </label>
                    <p className="text-sm font-medium">
                      {snapshot?.preview.data.billToLines[0]}
                    </p>
                    {savedRecipients.length > 0 ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {savedRecipients.map((recipient) => (
                          <li
                            key={recipient}
                            className={cn(
                              "flex items-center gap-1 rounded-md border px-2 py-1 text-sm animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none",
                              isInvoiceRecipientValid(recipient)
                                ? "bg-muted/40"
                                : "border-destructive/40 text-destructive",
                            )}
                          >
                            <span className="max-w-[14rem] truncate">
                              {recipient}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setRecipientsTouched(true);
                                setRecipients(
                                  savedRecipients
                                    .filter((entry) => entry !== recipient)
                                    .join(", "),
                                );
                              }}
                              className="text-muted-foreground transition-colors hover:text-foreground"
                              aria-label={`Remove ${recipient}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <Input
                      id="composer-recipients"
                      value={recipientDraft}
                      onChange={(event) =>
                        setRecipientDraft(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" ||
                          event.key === "," ||
                          event.key === ";"
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          commitRecipients(recipientDraft);
                        }
                      }}
                      onPaste={(event) => {
                        const text = event.clipboardData.getData("text");
                        if (/[,;\n<>]/.test(text)) {
                          event.preventDefault();
                          commitRecipients(
                            [recipientDraft, text].filter(Boolean).join(","),
                          );
                        }
                      }}
                      onBlur={() => {
                        if (recipientDraft.trim())
                          commitRecipients(recipientDraft);
                      }}
                      aria-invalid={
                        recipientDraft.trim() &&
                        parseInvoiceRecipients(recipientDraft).some(
                          (value) => !isInvoiceRecipientValid(value),
                        )
                          ? true
                          : undefined
                      }
                      placeholder={
                        parsedRecipients.length
                          ? "Add another address"
                          : `${policy.customerLabel.toLowerCase()}@email.com`
                      }
                      className="h-8 text-sm"
                    />
                  </div>

                  {problems.length > 0 && (
                    <ul className="space-y-1">
                      {problems.map((problem) => (
                        <li
                          key={`${problem.field}-${problem.message}`}
                          className="flex items-start gap-2 text-xs"
                        >
                          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                          <button
                            type="button"
                            onClick={() => fixProblem(problem.field)}
                            className="text-left underline-offset-4 hover:underline"
                          >
                            {problem.message}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Check className="size-3.5" />
                    {includeWaiver && !separateSignature
                      ? "Invoice and signed waiver"
                      : "Invoice"}
                  </p>
                  {separateSignature && deliveryReview?.signer && (
                    <section className="space-y-3 border-t pt-6">
                      <h3 className="text-xs font-medium text-muted-foreground">
                        Physical signing
                      </h3>
                      <div>
                        <p className="text-sm font-medium">
                          {deliveryReview.signer.name}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {deliveryReview.signer.email}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Download and print the waiver. After signing and
                        notarization, reopen this invoice, upload the executed
                        PDF, and confirm to send the complete packet.
                      </p>
                    </section>
                  )}
                  {!separateSignature && (
                    <div className="flex items-center justify-between border-t pt-5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <CalendarClock className="size-3.5" />
                        Delivery
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-2"
                          >
                            {sendMode === "later" ? "Scheduled" : "Send now"}
                            <ChevronDown className="size-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setSendMode("now")}>
                            Send now
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setSendMode("later")}
                          >
                            Schedule for later
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                  {!canReview && (
                    <p role="alert" className="text-sm text-warning">
                      The waiver changed. Return to the waiver step before
                      sending.
                    </p>
                  )}
                </div>
              </div>
            </div>
            <aside
              className={cn(
                "min-h-0 flex-1 flex-col bg-muted/40 lg:flex lg:w-[46%] lg:max-w-[880px] lg:flex-none lg:border-l",
                mobilePreview ? "flex" : "hidden",
              )}
            >
              <div
                className={cn(
                  "min-h-0 flex-1 flex-col",
                  reviewDocument === "invoice" || !includeWaiver
                    ? "flex"
                    : "hidden",
                )}
              >
                {reviewPdf?.revision === reviewRevision ? (
                  <PdfDocumentPreview
                    url={reviewPdf.url}
                    toolbar={reviewDocumentTabs}
                  />
                ) : (
                  <>
                    <div className="flex h-14 shrink-0 items-center border-b px-4">
                      {reviewDocumentTabs}
                    </div>
                    <div
                      className="m-auto space-y-3 p-6 text-center text-sm text-muted-foreground"
                      role={reviewPdfError ? "alert" : "status"}
                    >
                      {reviewPdfError || "Preparing invoice PDF…"}
                      {reviewPdfError && (
                        <Button
                          variant="outline"
                          onClick={() =>
                            setReviewPdfRetry((value) => value + 1)
                          }
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
              {includeWaiver && deliveryReview?.waiver && (
                <div
                  className={cn(
                    "min-h-0 flex-1 flex-col",
                    reviewDocument === "waiver" ? "flex" : "hidden",
                  )}
                >
                  <PdfDocumentPreview
                    toolbar={reviewDocumentTabs}
                    url={`/api/invoices/${draftId}/waivers/${deliveryReview.waiver.id}?version=${readWaiverWorkflow(deliveryReview.waiver)?.file_id ?? "prepared"}`}
                  />
                </div>
              )}
            </aside>
          </div>
        )}

        <AlertDialog
          open={leavePrompt}
          onOpenChange={(open) => !busy && setLeavePrompt(open)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {snapshot?.complete
                  ? "Keep this invoice as a draft?"
                  : "Keep your unfinished invoice?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {snapshot?.complete
                  ? "Save it to Arc and finish it later. Discard removes the draft."
                  : snapshot?.recoverySaved
                    ? "Your incomplete edits are kept in this browser tab. Return here to finish them; they are not yet saved to Arc."
                    : "These edits have not been saved. Keep editing to avoid losing your work."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>
                Keep editing
              </AlertDialogCancel>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void handleDiscard()}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {busy === "discard" ? "Discarding…" : "Discard"}
              </Button>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  setLeavePrompt(false);
                  if (snapshot?.complete) void handleSaveAndClose();
                  else if (snapshot?.recoverySaved) onClose(draftIdRef.current);
                }}
                disabled={
                  busy !== null ||
                  (!snapshot?.complete && !snapshot?.recoverySaved)
                }
              >
                {snapshot?.complete
                  ? "Save as draft"
                  : "Keep in this tab & close"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {waiverData && waiverSource && (
          <div
            className={cn(
              "absolute inset-0 flex min-h-0 transition-opacity duration-200 motion-reduce:transition-none",
              includeWaiver && packetView === "waiver"
                ? "z-10 opacity-100"
                : "pointer-events-none z-0 opacity-0",
            )}
          >
            <WaiverStep
              ref={waiverRef}
              invoice={waiverData.invoice}
              draft={waiverData.waivers.find(
                (w) =>
                  w.id ===
                  waiverData.invoice.metadata?.waiver_packet?.waiver_id,
              )}
              readinessError={waiverData.readinessError}
              initialRevision={waiverBaseRevision}
              source={waiverSource}
              active={includeWaiver && packetView === "waiver"}
              persistInvoice={persistInvoiceForWaiver}
              mobilePreview={mobilePreview}
              actionTarget={packetView === "waiver" ? waiverActionTarget : null}
              onReadyChange={setWaiverReady}
              onBusyChange={setWaiverWorking}
              onDeliveryChange={setDeliveryReview}
              onReview={openReview}
            />
          </div>
        )}
        {packetView === "waiver" && !waiverData && (
          <div
            className="absolute inset-0 z-10 flex min-h-0 flex-col items-center justify-center gap-3 bg-background"
            role={waiverLoadError ? "alert" : "status"}
          >
            <p className="text-sm text-muted-foreground">
              {waiverLoadError ||
                (snapshot?.complete
                  ? "Loading waiver details…"
                  : "Add your invoice details to start the waiver.")}
            </p>
            {waiverLoadError && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadWaiverStep()}
              >
                Try again
              </Button>
            )}
            {!snapshot?.complete && (
              <Button variant="outline" size="sm" onClick={backToInvoice}>
                Edit invoice
              </Button>
            )}
          </div>
        )}

        <DocumentEditorLayout
          inert={packetView !== "invoice" || busy !== null}
          aria-hidden={packetView !== "invoice"}
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col lg:flex-row transition-opacity duration-200 motion-reduce:transition-none",
            packetView !== "invoice"
              ? "pointer-events-none z-0 opacity-0"
              : "z-10 opacity-100",
          )}
        >
          {/* Form */}
          <DocumentEditorFields
            inert={busy !== null}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              mobilePreview && "hidden lg:block",
            )}
          >
            {(numberError || numberWarning) && (
              <div
                className="mx-4 mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
                role="status"
              >
                {numberError || numberWarning}
                {numberError && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="ml-3"
                    disabled={numberLoading}
                    onClick={() => void retryNumber()}
                  >
                    {numberLoading ? "Retrying…" : "Retry number"}
                  </Button>
                )}
              </div>
            )}
            {bootstrapError ? (
              <div className="mx-auto max-w-md px-6 py-16 text-center">
                <p className="text-sm font-medium">
                  The composer could not open.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {bootstrapError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => onClose(null)}
                >
                  Back to billing
                </Button>
              </div>
            ) : editorReady ? (
              <InvoiceDocumentEditor
                ref={editorRef}
                recoveryKey={recoveryKey}
                onRecoveredDraft={(id) => {
                  setDraftId(id);
                  draftIdRef.current = id;
                }}
                initialInvoice={initialInvoice}
                projectId={project?.id}
                projects={project ? [project] : []}
                builderInfo={bootstrap?.branding ?? undefined}
                contacts={bootstrap?.contacts ?? []}
                costCodes={bootstrap?.costCodes ?? []}
                context={bootstrap ? bootstrap.context : undefined}
                initialCustomerId={
                  target.customerId ??
                  bootstrap?.defaultCustomerId ??
                  project?.client_id ??
                  undefined
                }
                initialKind={target.kind ?? undefined}
                enableApprovedCostsSource={profile.costDriven}
                duplicateFrom={bootstrap?.duplicate ?? null}
                initialSourceChangeOrderId={
                  target.sourceChangeOrderId ?? undefined
                }
                reservation={reservation}
                autosaveState={autosave}
                onCreateDraft={handleCreateDraft}
                onAutosave={handleAutosave}
                onAutosaveStateChange={setAutosave}
                onSnapshotChange={setSnapshot}
                waiverControl={
                  project ? (
                    <section className="space-y-3" aria-label="Lien waiver">
                      <h2 className="text-base font-semibold tracking-tight">
                        Lien waiver
                      </h2>
                      <div className="space-y-3 rounded-lg border p-4">
                        <label className="flex items-start gap-3">
                          <Checkbox
                            className="mt-0.5"
                            checked={includeWaiver}
                            disabled={packetBusy || busy !== null}
                            onCheckedChange={(value) =>
                              void toggleWaiver(value === true)
                            }
                          />
                          <span className="space-y-1">
                            <span className="block text-sm font-medium">
                              Include waiver
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              Add a waiver step before sending this invoice.
                            </span>
                          </span>
                        </label>
                      </div>
                    </section>
                  ) : undefined
                }
              />
            ) : (
              <FormSkeleton />
            )}
          </DocumentEditorFields>

          {/* Live document */}
          <DocumentPreviewPane
            className={cn(
              "min-h-0 flex-1 flex-col bg-muted/40 lg:flex lg:w-[46%] lg:max-w-[880px] lg:flex-none lg:shrink-0 lg:border-l",
              mobilePreview ? "flex" : "hidden",
            )}
          >
            {snapshot ? (
              <div className="animate-in fade-in duration-300 motion-reduce:animate-none">
                <DocumentPreview preview={snapshot.preview} />
              </div>
            ) : (
              <Skeleton className="mx-auto aspect-[1/1.294] w-full max-w-[720px]" />
            )}
          </DocumentPreviewPane>
        </DocumentEditorLayout>
      </div>
      {sendFeedback && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invoice-send-result"
        >
          <motion.div
            initial={{
              opacity: 0,
              y: reducedMotion ? 0 : 10,
              scale: reducedMotion ? 1 : 0.97,
            }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: reducedMotion ? 0 : 0.2 }}
            className="w-full max-w-sm border bg-background p-8 text-center shadow-lg"
          >
            {sendFeedback.invoice ? (
              <motion.svg
                className="mx-auto mb-5 size-14 text-success"
                viewBox="0 0 48 48"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="24"
                  cy="24"
                  r="22"
                  fill="currentColor"
                  opacity="0.1"
                />
                <motion.path
                  d="m14 24 7 7 14-15"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: reducedMotion ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: reducedMotion ? 0 : 0.35 }}
                />
              </motion.svg>
            ) : (
              <Loader2 className="mx-auto mb-5 size-10 animate-spin text-muted-foreground" />
            )}
            <h2
              id="invoice-send-result"
              className="text-xl font-semibold tracking-tight"
            >
              {sendFeedback.invoice
                ? sendFeedback.awaitingSignature
                  ? "Awaiting signed waiver"
                  : ["sent", "delivered"].includes(
                        sendFeedback.invoice.delivery_status ?? "",
                      )
                    ? "Invoice sent"
                    : "Invoice on its way"
                : sendFeedback.awaitingSignature
                  ? "Saving pending delivery"
                  : "Sending invoice"}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {sendFeedback.invoice
                ? sendFeedback.awaitingSignature
                  ? "Your printable waiver download has started. After physical signing and notarization, reopen this invoice and upload the executed PDF to send the packet."
                  : `${["sent", "delivered"].includes(sendFeedback.invoice.delivery_status ?? "") ? "Sent" : "Queued for delivery"} to ${parsedRecipients.join(", ")}.`
                : "You can stay here while Arc confirms your request."}
            </p>
            {sendFeedback.invoice &&
              sendFeedback.awaitingSignature &&
              deliveryReview?.physical &&
              deliveryReview.waiver && (
                <Button asChild variant="outline" className="mt-5 w-full">
                  <a
                    href={`/api/invoices/${sendFeedback.invoice.id}/waivers/${deliveryReview.waiver.id}?download=1`}
                    download="lien-waiver.pdf"
                  >
                    Download printable waiver
                  </a>
                </Button>
              )}
            {sendFeedback.invoice && (
              <Button
                autoFocus
                className="mt-6 w-full"
                onClick={finishSendFeedback}
              >
                Done
              </Button>
            )}
          </motion.div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The letter-size page, scaled to the pane rather than reflowed into it. A
 * reflowed preview is a different document; a scaled one is the same document
 * seen from further away.
 */
function DocumentPreview({
  preview,
}: {
  preview: InvoiceEditorSnapshot["preview"];
}) {
  return (
    <ScaledDocument>
      <ArcInvoiceDocument
        data={preview.data}
        lines={preview.lines}
        width={816}
        height={1056}
      />
    </ScaledDocument>
  );
}

/** Tomorrow at 9am, in the input's local format. */
function defaultSendAt() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function FormSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-6 py-8 sm:px-8">
      <div className="space-y-3">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-11 w-full" />
        <div className="grid grid-cols-4 gap-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  );
}

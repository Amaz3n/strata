"use client";

import dynamic from "next/dynamic";
import { setWaiverPacketAction } from "@/app/(app)/invoices/waiver-actions";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { createPortal } from "react-dom";
import {
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
import { getReceivablesPosturePolicy } from "@/lib/receivables/policy";
import type { BillingProfile } from "@/lib/financials/billing-profile";
import type { NewInvoiceKind } from "@/lib/financials/invoice-destinations";
import {
  createInvoiceAction,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

const PacketWaiver = dynamic(
  () => import("./invoice-packet-waiver").then((m) => m.InvoicePacketWaiver),
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
  projectId: string,
  target: Pick<InvoiceComposerTarget, "compose" | "duplicateOf">,
) {
  return `${projectId}:${target.compose}:${target.duplicateOf ?? ""}`;
}

function loadBootstrap(
  projectId: string,
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
export function prefetchInvoiceComposer(projectId: string) {
  void loadBootstrap(projectId, { compose: "new" }).catch(() => null);
}

interface InvoiceComposerProps {
  project: Project;
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
  const policy = getReceivablesPosturePolicy(profile.posture);
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
  const [draftId, setDraftId] = useState<string | null>(
    isNew ? null : target.compose,
  );
  const [packetView, setPacketView] = useState<"invoice" | "waiver">("invoice");
  const [includeWaiver, setIncludeWaiver] = useState(false);
  const [packetBusy, setPacketBusy] = useState(false);
  useEffect(() => {
    if (bootstrap?.draft)
      setIncludeWaiver(
        Boolean(bootstrap.draft.metadata?.waiver_packet?.enabled),
      );
  }, [bootstrap?.draft]);
  async function openWaiver() {
    if (packetBusy) return;
    setPacketBusy(true);
    try {
      const id = await editorRef.current?.saveDraft();
      if (!id) throw new Error("Complete the invoice details first");
      if (!includeWaiver) unwrapAction(await setWaiverPacketAction(id, true));
      setIncludeWaiver(true);
      setPacketView("waiver");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open waiver",
      );
    } finally {
      setPacketBusy(false);
    }
  }
  async function removeWaiver() {
    if (packetBusy || !draftIdRef.current) return;
    setPacketBusy(true);
    try {
      unwrapAction(await setWaiverPacketAction(draftIdRef.current, false));
      setIncludeWaiver(false);
      setPacketView("invoice");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update packet",
      );
    } finally {
      setPacketBusy(false);
    }
  }
  const [mobilePreview, setMobilePreview] = useState(false);
  const [numberError, setNumberError] = useState<string | null>(null);
  const [numberWarning, setNumberWarning] = useState<string | null>(null);
  const [numberLoading, setNumberLoading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
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
    | "discard"
    | null
  >(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [sendMode, setSendMode] = useState<"now" | "later">("now");
  const [sendAt, setSendAt] = useState("");
  useEffect(() => {
    if (sendMode === "later" && !sendAt) setSendAt(defaultSendAt());
  }, [sendMode, sendAt]);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (autosave === "saved") setLastSavedAt(new Date());
  }, [autosave]);

  const busyRef = useRef(false);
  const fieldToFocusRef = useRef<string | null>(null);
  const recoveryKey = bootstrap
    ? `arc:invoice:v1:${bootstrap.recoveryScope}:${project.id}:${target.compose}:${target.duplicateOf ?? ""}:${target.sourceChangeOrderId ?? ""}:${target.kind ?? ""}`
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
    loadBootstrap(project.id, target)
      .then(async (data) => {
        let loaded = data;
        if (isNew) {
          const key = `arc:invoice:v1:${data.recoveryScope}:${project.id}:${target.compose}:${target.duplicateOf ?? ""}:${target.sourceChangeOrderId ?? ""}:${target.kind ?? ""}`;
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
                projectId: project.id,
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
      reserveInvoiceNumberAction(project.id)
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
  }, [project.id, target.compose, target.duplicateOf]);

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
      if (event.defaultPrevented || event.repeat || busy !== null) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveAndClose();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === "Enter"
      ) {
        event.preventDefault();
        if (snapshot) {
          setSendMode("now");
          setSendOpen(true);
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
      const created = unwrapAction(await createInvoiceAction(input));
      setDraftId(created.id);
      draftIdRef.current = created.id;
      reservationIdRef.current = null;
      return created;
    },
    [],
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
        await reserveInvoiceNumberAction(project.id),
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
    fieldToFocusRef.current = field;
    setSendOpen(false);
    setMobilePreview(false);
  };

  async function withBusy(
    key: NonNullable<typeof busy>,
    fn: () => Promise<void>,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  const handleSaveAndClose = () =>
    withBusy("close", async () => {
      try {
        if (snapshot?.complete) {
          const id = await editorRef.current?.saveDraft();
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
    if (busyRef.current) return;
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
        const id = await editorRef.current?.persist();
        if (!id) throw new Error("Complete the invoice before sending it");
        const issued = unwrapAction(
          await issueInvoiceAction(id, parsedRecipients),
        );
        toast.success(
          includeWaiver ? "Invoice and waiver sent" : "Invoice sent",
          { description: `Sent to ${parsedRecipients.join(", ")}` },
        );
        await editorRef.current?.discard();
        clearRecovery();
        setSendOpen(false);
        invalidateInvoiceDetail(issued.id);
        onIssued(issued);
      } catch (error) {
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
        setSendOpen(false);
        invalidateInvoiceDetail(id);
        onClose(id);
      } catch (error) {
        toast.error("Could not schedule the send", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    });

  const autosaveLabel =
    snapshot?.dirty && !snapshot.complete
      ? snapshot.recoverySaved
        ? "Unfinished edits kept in this tab"
        : "Unsaved edits — keep this tab open"
      : snapshot?.dirty && autosave !== "saving" && autosave !== "error"
        ? "Changes waiting to save…"
        : autosave === "saving"
          ? "Saving…"
          : autosave === "saved"
            ? "Saved"
            : autosave === "error"
              ? "Could not save — your changes are still here"
              : draftId
                ? "Every change saves itself"
                : "Saves itself once there's an item";

  const editorReady = Boolean(bootstrap);
  const initialInvoice = bootstrap?.draft ?? null;
  const title = initialInvoice
    ? `Invoice ${initialInvoice.invoice_number}`
    : "New invoice";

  if (!portalReady) return null;
  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in duration-150 motion-reduce:animate-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-3 py-2 sm:px-4">
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
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight">
              {title}
            </h1>
            <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate">{project.name}</span>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              <SaveIndicator
                state={autosave}
                lastSavedAt={lastSavedAt}
                hasDraft={Boolean(draftId)}
                label={autosaveLabel}
              />
            </p>
          </div>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            size="sm"
            variant="outline"
            className="h-8 lg:hidden"
            onClick={() => setMobilePreview((value) => !value)}
          >
            <Eye className="mr-1.5 size-4" />
            {mobilePreview ? "Edit" : "Preview"}
          </Button>
          <div className="flex items-stretch">
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-r-none"
              disabled={busy !== null || autosave === "saving"}
              onClick={() => void handleSaveAndClose()}
              title="⌘S"
            >
              {busy === "close" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              <span className="sm:hidden">Save</span>
              <span className="hidden sm:inline">Save and close</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-l-none border-l-0 px-2"
                  disabled={busy !== null}
                  aria-label="More ways to save"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  disabled={!snapshot?.complete}
                  onSelect={() =>
                    void withBusy(
                      "pdf",
                      () =>
                        editorRef.current?.downloadPdf() ?? Promise.resolve(),
                    )
                  }
                >
                  <Download className="mr-2 h-4 w-4" />
                  Save and download PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {approvalRequired && !approved ? (
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
            <Dialog
              open={sendOpen}
              onOpenChange={(open) => {
                if (!busyRef.current) setSendOpen(open);
              }}
            >
              <div className="flex items-stretch">
                <DialogTrigger asChild>
                  <Button
                    size="sm"
                    className="h-8 rounded-r-none"
                    disabled={busy !== null || !snapshot}
                    onClick={() => setSendMode("now")}
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                    <span className="sm:hidden">Send</span>
                    <span className="hidden sm:inline">
                      {policy.sendActionLabel}
                    </span>
                  </Button>
                </DialogTrigger>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      className="h-8 rounded-l-none border-l border-primary-foreground/20 px-2"
                      disabled={busy !== null || !snapshot}
                      aria-label="More ways to send"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                      onSelect={() => {
                        setSendMode("later");
                        setSendOpen(true);
                      }}
                    >
                      <CalendarClock className="mr-2 h-4 w-4" />
                      Schedule send…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <DialogContent
                onCloseAutoFocus={(event) => {
                  const field = fieldToFocusRef.current;
                  if (field) {
                    event.preventDefault();
                    fieldToFocusRef.current = null;
                    editorRef.current?.focusField(field);
                  }
                }}
                className="max-h-[90dvh] overflow-y-auto rounded-none p-0 sm:max-w-[560px]"
                showCloseButton={busy === null}
                onEscapeKeyDown={(event) => {
                  if (busy !== null) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                  if (busy !== null) event.preventDefault();
                }}
              >
                <DialogHeader className="border-b bg-muted/30 px-6 pb-5 pt-6 text-left">
                  <DialogTitle className="text-xl">Review & send</DialogTitle>
                  <DialogDescription>
                    {snapshot?.preview.data.invoiceNumber
                      ? `Invoice ${snapshot.preview.data.invoiceNumber} · `
                      : ""}
                    {project.name}
                  </DialogDescription>
                  <p className="pt-3 text-3xl font-semibold tracking-tight tabular-nums text-foreground">
                    {formatMoneyFromCents(snapshot?.totalCents ?? 0)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Due{" "}
                    {snapshot?.dueDate
                      ? formatDateOnly(snapshot.dueDate, { withYear: true })
                      : "—"}
                  </p>
                </DialogHeader>
                <div className="space-y-5 px-6 pb-6">
                  <div className="flex gap-1 border bg-muted p-1 text-sm">
                    {(["now", "later"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSendMode(mode)}
                        className={cn(
                          "h-9 flex-1 rounded-md font-medium transition-all motion-reduce:transition-none",
                          sendMode === mode
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {mode === "now" ? "Send now" : "Schedule"}
                      </button>
                    ))}
                  </div>
                  {sendMode === "later" ? (
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
                  <div className="space-y-1.5">
                    <label
                      htmlFor="composer-recipients"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Send to
                    </label>
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

                  <dl className="space-y-1 border-t pt-3 text-xs">
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Invoice for</dt>
                      <dd className="max-w-[70%] text-right">
                        {snapshot?.preview.data.billToLines[0] ||
                          "Billing details not added"}
                      </dd>
                    </div>
                  </dl>
                  {problems.length === 0 ? (
                    <p className="flex items-start gap-2 text-xs text-success">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {formatMoneyFromCents(snapshot?.totalCents ?? 0)} is ready
                      to send.
                    </p>
                  ) : (
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
                  {includeWaiver && <p className="text-xs text-muted-foreground">One email with the invoice and your signed waiver. The client can review both and pay from the same link.</p>}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10 flex-1 rounded-lg"
                      onClick={() => setSendOpen(false)}
                      disabled={busy !== null}
                    >
                      Back to editing
                    </Button>
                    {sendMode === "later" ? (
                      <Button
                        size="sm"
                        className="h-10 flex-1 rounded-lg"
                        onClick={() => void handleSchedule()}
                        disabled={
                          busy !== null ||
                          !snapshot?.complete ||
                          problems.length > 0 ||
                          !sendAt
                        }
                      >
                        {busy === "schedule" ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Schedule
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-10 flex-1 rounded-lg"
                        onClick={() => void handleSend()}
                        disabled={
                          busy !== null ||
                          !snapshot?.complete ||
                          problems.length > 0
                        }
                      >
                        {busy === "send" ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {busy === "send"
                          ? "Sending…"
                          : `Send ${includeWaiver ? "invoice & waiver" : "invoice"}${parsedRecipients.length > 1 ? ` to ${parsedRecipients.length} recipients` : ""}`}
                      </Button>
                    )}
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </header>

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

      <div className="flex shrink-0 items-center justify-between border-b px-5 py-2">
        <div className="flex gap-1" aria-label="Packet documents">
          <Button
            size="sm"
            variant={packetView === "invoice" ? "secondary" : "ghost"}
            onClick={() => setPacketView("invoice")}
          >
            Invoice
          </Button>
          {includeWaiver && (
            <Button
              size="sm"
              variant={packetView === "waiver" ? "secondary" : "ghost"}
              disabled={packetBusy}
              onClick={() => void openWaiver()}
            >
              Waiver
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={includeWaiver}
            disabled={packetBusy || !snapshot?.complete || busy !== null}
            onCheckedChange={(value) =>
              void (value ? openWaiver() : removeWaiver())
            }
          />
          {packetBusy ? "Preparing packet…" : "Include waiver"}
        </label>
      </div>
      {includeWaiver && draftId && (
        <div
          className={cn(
            "flex min-h-0 flex-1",
            packetView !== "waiver" && "hidden",
          )}
        >
          <PacketWaiver
            invoiceId={draftId}
            onClose={() => setPacketView("invoice")}
          />
        </div>
      )}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col lg:flex-row",
          packetView === "waiver" && "hidden",
        )}
      >
        {/* Form */}
        <div
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
              projectId={project.id}
              projects={[project]}
              builderInfo={bootstrap?.branding ?? undefined}
              contacts={bootstrap?.contacts ?? []}
              costCodes={bootstrap?.costCodes ?? []}
              context={bootstrap ? bootstrap.context : undefined}
              initialCustomerId={target.customerId ?? undefined}
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
            />
          ) : (
            <FormSkeleton />
          )}
        </div>

        {/* Live document */}
        <aside
          className={cn(
            "min-h-0 flex-1 flex-col bg-muted/40 lg:flex lg:w-[46%] lg:max-w-[880px] lg:flex-none lg:shrink-0 lg:border-l",
            mobilePreview ? "flex" : "hidden",
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {snapshot ? (
              <div className="animate-in fade-in duration-300 motion-reduce:animate-none">
                <DocumentPreview preview={snapshot.preview} />
              </div>
            ) : (
              <Skeleton className="mx-auto aspect-[1/1.294] w-full max-w-[720px]" />
            )}
          </div>
        </aside>
      </div>
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
  const PAGE_WIDTH = 816;
  const PAGE_HEIGHT = 1056;
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.8);

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const update = () =>
      setScale(Math.min(1, Math.max(0.3, element.clientWidth / PAGE_WIDTH)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frameRef} className="mx-auto w-full max-w-[816px]">
      <div
        className="relative shadow-md"
        style={{ width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `scale(${scale})` }}
        >
          <ArcInvoiceDocument
            data={preview.data}
            lines={preview.lines}
            width={PAGE_WIDTH}
            height={PAGE_HEIGHT}
          />
        </div>
      </div>
    </div>
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

const SAVED_TIME = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Where the draft stands: spinning while it saves, a check and the time once it
 * has, red words if it could not. The label never blinks between states; it
 * crossfades so the eye is not pulled to the header on every keystroke.
 */
function SaveIndicator({
  state,
  lastSavedAt,
  hasDraft,
  label,
}: {
  state: AutosaveState;
  lastSavedAt: Date | null;
  hasDraft: boolean;
  label: string;
}) {
  const text =
    state === "saving"
      ? "Saving…"
      : state === "error"
        ? label
        : lastSavedAt
          ? `Saved ${SAVED_TIME.format(lastSavedAt)}`
          : hasDraft
            ? "Saved"
            : label;
  return (
    <span
      aria-live="polite"
      key={text}
      className={cn(
        "hidden items-center gap-1.5 text-[11px] transition-colors sm:flex animate-in fade-in duration-200 motion-reduce:animate-none",
        state === "error"
          ? "font-medium text-destructive"
          : "text-muted-foreground",
      )}
    >
      {state === "saving" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === "error" ? (
        <CircleAlert className="h-3 w-3" />
      ) : lastSavedAt || hasDraft ? (
        <Check className="h-3 w-3 text-success" />
      ) : null}
      {text}
    </span>
  );
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

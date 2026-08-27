"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  requestComplianceDocumentsAction,
  revokeComplianceDecisionAction,
  revokeCompanyRequirementWaiverAction,
  reviewComplianceDocumentAction,
  setCompanyRequirementsAction,
  setCompanyComplianceMonitoringAction,
  uploadComplianceDocumentAction,
  waiveAllCompanyRequirementsAction,
  waiveCompanyRequirementAction,
} from "@/app/(app)/directory/[id]/compliance/actions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "@/components/icons";
import { FileViewer } from "@/components/files/file-viewer";
import type { FileWithDetails } from "@/components/files/types";
import {
  COMPLIANCE_KIND_ORDER,
  complianceHeadline,
  complianceKindLabel,
  complianceRowSignal,
} from "@/components/companies/account/compliance-status";
import {
  ComplianceRequestDialog,
  ComplianceRevokeDialog,
  ComplianceReviewDialog,
  ComplianceUploadDialog,
  ComplianceWaiveAllDialog,
  ComplianceWaiveDialog,
  factsToInput,
  type DocumentFactValues,
  type ReviewValues,
} from "@/components/companies/account/compliance-dialogs";
import {
  ComplianceRequirementsEditor,
  type RequirementDraft,
} from "@/components/companies/account/compliance-requirements-editor";
import { StatusChip, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { useToast } from "@/hooks/use-toast";
import { unwrapAction } from "@/lib/action-result";
import { cn } from "@/lib/utils";
import type {
  ComplianceDocument,
  ComplianceDocumentKind,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceRequirementStatus,
  ComplianceStatusSummary,
} from "@/lib/types";

interface ComplianceWorkspaceProps {
  companyId: string;
  companyName: string;
  status: ComplianceStatusSummary;
  documentTypes: ComplianceDocumentType[];
  /**
   * Payables the compliance hold is actually stopping — not this vendor's AP
   * balance. The banner below states it as a consequence, so it has to be the
   * number the release gate would produce.
   */
  heldCents: number;
  heldBillCount: number;
  canManage: boolean;
  canReview: boolean;
  /** Whether org policy actually stops payment on missing documents. */
  blocksPayment: boolean;
}

/**
 * The vendor's compliance record.
 *
 * The screen reports by exception: a requirement that is satisfied says its name
 * and nothing else, and every word on the page is there because something needs
 * doing. Carrier names, policy numbers and limits are on the certificate — they
 * are not what a builder scanning this list is deciding about, and printing them
 * on every row buried the two rows that actually needed attention.
 */
export function ComplianceWorkspace({
  companyId,
  companyName,
  status,
  documentTypes,
  heldCents,
  heldBillCount,
  canManage,
  canReview,
  blocksPayment,
}: ComplianceWorkspaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadPresetTypeId, setUploadPresetTypeId] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [waiveAllOpen, setWaiveAllOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<ComplianceRequirementStatus | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<ComplianceRequirement | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ComplianceDocument | null>(null);
  const [viewerFileId, setViewerFileId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const by = (state: ComplianceRequirementStatus["state"]) =>
      status.statuses.filter((item) => item.state === state).length;
    return {
      missing: by("missing"),
      expired: by("expired"),
      deficient: by("deficient"),
      pending: by("pending"),
      expiring: by("expiring"),
      rejected: by("rejected"),
      met: by("met"),
      waived: by("waived"),
    };
  }, [status.statuses]);

  const headline = status.monitoring_enabled
    ? complianceHeadline({ isCompliant: status.is_compliant, ...counts })
    : { label: "Monitoring off", className: "border-border bg-muted text-muted-foreground" };

  /** What the vendor still owes — the set a request email would chase. */
  const outstanding = useMemo(
    () =>
      status.statuses.filter(
        (item) => item.state === "missing" || item.state === "expired" || item.state === "rejected",
      ),
    [status.statuses],
  );

  const waivableStandingRequirements = useMemo(
    () =>
      status.requirements.filter(
        (requirement) => requirement.source === "company_override" && !requirement.waiver,
      ),
    [status.requirements],
  );

  const grouped = useMemo(() => {
    const byKind = new Map<ComplianceDocumentKind, ComplianceRequirementStatus[]>();
    for (const item of status.statuses) {
      const kind = item.requirement.document_type?.kind ?? "other";
      const list = byKind.get(kind) ?? [];
      list.push(item);
      byKind.set(kind, list);
    }
    return COMPLIANCE_KIND_ORDER.filter((kind) => (byKind.get(kind) ?? []).length > 0).map(
      (kind) => ({ kind, items: byKind.get(kind) ?? [] }),
    );
  }, [status.statuses]);

  /**
   * Every document with a file, so the viewer can page through them. Mapped to
   * the shape `/documents` uses, which is the same viewer — a compliance PDF
   * should not open differently from any other PDF in Arc.
   */
  const viewerFiles: FileWithDetails[] = useMemo(
    () =>
      status.documents
        .filter((document) => document.file_id && document.file)
        .map((document) => ({
          id: document.file_id as string,
          org_id: document.org_id,
          file_name: document.file?.file_name ?? document.document_type?.name ?? "Document",
          storage_path: document.file?.storage_path ?? "",
          mime_type: document.file?.mime_type,
          size_bytes: document.file?.size_bytes,
          visibility: document.file?.visibility ?? "private",
          created_at: document.file?.created_at ?? document.created_at,
          // The viewer renders PDFs only when it has a URL to load; this is the
          // same org-scoped endpoint it falls back to elsewhere.
          download_url: `/api/files/${document.file_id}/raw`,
        })),
    [status.documents],
  );

  const viewerFile = viewerFiles.find((file) => file.id === viewerFileId) ?? null;

  const run = (work: () => Promise<void>) => {
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch (error) {
        toast({ title: "Something went wrong", description: (error as Error).message });
      }
    });
  };

  const saveRequirements = (requirements: RequirementDraft[]) =>
    run(async () => {
      unwrapAction(await setCompanyRequirementsAction(companyId, requirements));
      toast({ title: "Requirements updated" });
      setRequirementsOpen(false);
    });

  const handleUploaded = async (
    fileId: string,
    facts: DocumentFactValues,
    documentTypeId: string,
  ) => {
    const document = unwrapAction(
      await uploadComplianceDocumentAction({
        companyId,
        fileId,
        input: { document_type_id: documentTypeId, ...factsToInput(facts) },
      }),
    );
    // A builder filing a document they received themselves is the reviewer; the
    // approval is recorded against their name rather than appearing from nowhere.
    if (canReview) {
      unwrapAction(
        await reviewComplianceDocumentAction(document.id, {
          decision: "approved",
          notes: "Filed and approved by the builder.",
        }),
      );
    }
    toast({ title: canReview ? "Document filed and approved" : "Document filed for review" });
    router.refresh();
  };

  const submitReview = (values: ReviewValues) =>
    run(async () => {
      const document = reviewTarget?.document;
      if (!document) return;
      unwrapAction(
        await reviewComplianceDocumentAction(document.id, {
          decision: values.decision,
          notes: values.notes || undefined,
          rejection_reason: values.rejection_reason || undefined,
          corrections: factsToInput(values.facts),
        }),
      );
      toast({
        title: values.decision === "approved" ? "Document approved" : "Sent back to the vendor",
        description:
          values.decision === "approved" ? undefined : `${companyName} has been emailed the reason.`,
      });
      setReviewTarget(null);
    });

  const submitWaiver = (values: { reason: string; expires_at: string }) =>
    run(async () => {
      if (!waiveTarget) return;
      unwrapAction(
        await waiveCompanyRequirementAction(companyId, {
          document_type_id: waiveTarget.document_type_id,
          reason: values.reason || undefined,
          expires_at: values.expires_at || undefined,
        }),
      );
      toast({ title: "Requirement waived" });
      setWaiveTarget(null);
    });

  const submitBulkWaiver = (reason: string) =>
    run(async () => {
      unwrapAction(await waiveAllCompanyRequirementsAction(companyId, { reason }));
      toast({
        title: "Compliance requirements waived",
        description: `Autopilot will no longer request these documents from ${companyName}.`,
      });
      setWaiveAllOpen(false);
    });

  const toggleMonitoring = (enabled: boolean) =>
    run(async () => {
      unwrapAction(await setCompanyComplianceMonitoringAction(companyId, { enabled }));
      toast({
        title: enabled ? "Compliance monitoring resumed" : "Compliance monitoring paused",
        description: enabled
          ? `Saved requirements for ${companyName} are active again.`
          : `Autopilot will not email ${companyName}. Requirements and documents were kept.`,
      });
    });

  const submitRevoke = (reason: string) =>
    run(async () => {
      if (!revokeTarget) return;
      unwrapAction(await revokeComplianceDecisionAction(revokeTarget.id, { reason }));
      toast({
        title: "Decision withdrawn",
        description: `${companyName} needs to send a replacement.`,
      });
      setRevokeTarget(null);
    });

  const submitRequest = (documentTypeIds: string[]) =>
    run(async () => {
      const result = unwrapAction(
        await requestComplianceDocumentsAction(companyId, { document_type_ids: documentTypeIds }),
      );
      toast({
        title: result.sent ? "Request sent" : "No email on file",
        description: result.sent
          ? `Emailed ${result.recipientEmail}.`
          : `Add an email for ${companyName} or one of their contacts first.`,
      });
      setRequestOpen(false);
    });

  const removeWaiver = (requirement: ComplianceRequirement) =>
    run(async () => {
      const waiverId = requirement.waiver?.id;
      if (!waiverId) return;
      unwrapAction(await revokeCompanyRequirementWaiverAction(waiverId));
      toast({ title: "Waiver removed" });
    });

  const openUploadFor = (documentTypeId: string | null) => {
    setUploadPresetTypeId(documentTypeId);
    setUploadOpen(true);
  };

  // The meta line carries what the figures used to, in a sentence rather than a
  // grid — four tiles reporting three zeroes is noise, not information.
  const onFile = counts.met + counts.expiring;
  const meta = [
    `${onFile} of ${status.statuses.length} on file`,
    counts.pending > 0 ? `${counts.pending} to review` : null,
    counts.waived > 0 ? `${counts.waived} waived` : null,
  ].filter(Boolean) as string[];

  // A single group needs no caption — the tab already says what this is.
  const showGroupCaptions = grouped.length > 1;

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="desk-rise border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-muted/40 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusChip label={headline.label} className={headline.className} />
            <span className="text-xs tabular-nums text-muted-foreground">{meta.join(" · ")}</span>
          </div>

          {canManage ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <label className="mr-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>Monitoring</span>
                <Switch
                  checked={status.monitoring_enabled}
                  disabled={pending}
                  aria-label={`Compliance monitoring for ${companyName}`}
                  onCheckedChange={toggleMonitoring}
                />
              </label>
              {status.monitoring_enabled && outstanding.length > 0 ? (
                <Button size="sm" className="h-7" disabled={pending} onClick={() => setRequestOpen(true)}>
                  Request {outstanding.length}
                </Button>
              ) : null}
              {status.monitoring_enabled && waivableStandingRequirements.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={pending}
                  onClick={() => setWaiveAllOpen(true)}
                >
                  Waive all
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="More compliance actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => openUploadFor(null)}>
                    Add a document
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRequirementsOpen(true)}>
                    Set requirements
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>

        {!status.monitoring_enabled ? (
          <div className="border-b bg-muted/20 px-4 py-2.5 text-sm text-muted-foreground">
            Autopilot is paused. Saved requirements, documents, and history remain here and will
            become active again when monitoring is turned on.
          </div>
        ) : null}

        {/* The consequence, stated in money. The only banner on the page. */}
        {!status.is_compliant && blocksPayment && heldCents > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-destructive/30 bg-destructive/[0.06] px-4 py-2.5">
            <p className="text-sm text-destructive">
              <span className="font-medium tabular-nums">{formatMoneyFromCents(heldCents)}</span>{" "}
              across {heldBillCount} {heldBillCount === 1 ? "payable" : "payables"} cannot be
              released until this clears.
            </p>
            <Button asChild size="sm" variant="outline" className="h-7">
              <a href={`/payables?company=${companyId}`}>Payables</a>
            </Button>
          </div>
        ) : null}

        {status.statuses.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing is required of {companyName} yet.
            </p>
            {canManage ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => setRequirementsOpen(true)}
              >
                Set requirements
              </Button>
            ) : null}
          </div>
        ) : (
          grouped.map(({ kind, items }) => (
            <div key={kind}>
              {showGroupCaptions ? (
                <div className="microlabel border-b bg-muted/20 px-4 py-1.5">
                  {complianceKindLabel(kind)}
                </div>
              ) : null}
              <div className="divide-y">
                {items.map((item) => (
                  <RequirementRow
                    key={item.requirement.id}
                    item={item}
                    canManage={canManage}
                    canReview={canReview}
                    pending={pending}
                    onView={(fileId) => setViewerFileId(fileId)}
                    onReview={() => setReviewTarget(item)}
                    onWaive={() => setWaiveTarget(item.requirement)}
                    onRemoveWaiver={() => removeWaiver(item.requirement)}
                    onRevoke={(document) => setRevokeTarget(document)}
                    onUploadFor={() => openUploadFor(item.requirement.document_type_id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <FileViewer
        file={viewerFile}
        files={viewerFiles}
        open={viewerFileId !== null}
        onOpenChange={(open) => !open && setViewerFileId(null)}
        onFileChange={(file) => setViewerFileId(file.id)}
      />

      <ComplianceRequirementsEditor
        open={requirementsOpen}
        onOpenChange={setRequirementsOpen}
        companyName={companyName}
        documentTypes={documentTypes}
        currentRequirements={status.requirements}
        onSave={saveRequirements}
        busy={pending}
      />
      <ComplianceUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        companyId={companyId}
        documentTypes={documentTypes}
        requirements={status.requirements}
        onUploaded={handleUploaded}
        presetDocumentTypeId={uploadPresetTypeId}
      />
      <ComplianceReviewDialog
        open={reviewTarget !== null}
        onOpenChange={(open) => !open && setReviewTarget(null)}
        status={reviewTarget}
        onSubmit={submitReview}
        busy={pending}
      />
      <ComplianceWaiveDialog
        open={waiveTarget !== null}
        onOpenChange={(open) => !open && setWaiveTarget(null)}
        requirement={waiveTarget}
        onSubmit={submitWaiver}
        busy={pending}
      />
      <ComplianceWaiveAllDialog
        open={waiveAllOpen}
        onOpenChange={setWaiveAllOpen}
        companyName={companyName}
        requirementCount={waivableStandingRequirements.length}
        onSubmit={submitBulkWaiver}
        busy={pending}
      />
      <ComplianceRevokeDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        document={revokeTarget}
        onSubmit={submitRevoke}
        busy={pending}
      />
      <ComplianceRequestDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        outstanding={outstanding}
        companyName={companyName}
        onSubmit={submitRequest}
        busy={pending}
      />
    </div>
  );
}

/**
 * One requirement, reported by exception.
 *
 * A satisfied requirement is a name and a dot. Everything else on the row exists
 * because something is wrong with it, so the eye can run down the left edge and
 * stop only where it needs to.
 */
function RequirementRow({
  item,
  canManage,
  canReview,
  pending,
  onView,
  onReview,
  onWaive,
  onRemoveWaiver,
  onRevoke,
  onUploadFor,
}: {
  item: ComplianceRequirementStatus;
  canManage: boolean;
  canReview: boolean;
  pending: boolean;
  onView: (fileId: string) => void;
  onReview: () => void;
  onWaive: () => void;
  onRemoveWaiver: () => void;
  onRevoke: (document: ComplianceDocument) => void;
  onUploadFor: () => void;
}) {
  const { requirement, state, document } = item;
  const signal = complianceRowSignal(item);
  const documentType = requirement.document_type;
  const viewableFileId = document?.file_id ?? null;
  const needsAttention = state !== "met" && state !== "waived";

  const actions = [
    viewableFileId
      ? { key: "view", label: "View document", onSelect: () => onView(viewableFileId) }
      : null,
    canManage && state !== "waived"
      ? {
          key: "upload",
          label: document ? "Replace document" : "Add document",
          onSelect: onUploadFor,
        }
      : null,
    canManage && requirement.waiver
      ? { key: "unwaive", label: "Remove waiver", onSelect: onRemoveWaiver }
      : canManage
        ? { key: "waive", label: "Waive requirement", onSelect: onWaive }
        : null,
    canReview && document && document.status !== "pending_review"
      ? { key: "revoke", label: "Withdraw decision", onSelect: () => onRevoke(document) }
      : null,
  ].filter((entry): entry is { key: string; label: string; onSelect: () => void } => entry !== null);

  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30">
      {/* The state, as one mark. Colour carries it; the label is the fallback. */}
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", signal.dotClassName)}
      />

      {/* Two columns rather than inline text: names vary from "W-9" to "Umbrella
          / excess liability", so flowing the note straight after the name left
          every row starting its exception at a different x. Aligned, the eye can
          scan the two columns independently.
          The name track is a fixed width, not `minmax(0,15rem)` — each row is
          its own grid, so a content-sized track would resolve per row and put
          the alignment straight back where it started. */}
      <div className="grid min-w-0 flex-1 gap-x-4 gap-y-0.5 sm:grid-cols-[15rem_minmax(0,1fr)] sm:items-baseline">
        {viewableFileId ? (
          <button
            type="button"
            onClick={() => onView(viewableFileId)}
            className={cn(
              "truncate text-left text-sm underline-offset-4 outline-none hover:underline focus-visible:underline",
              state === "waived" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {documentType?.name ?? "Document"}
            <span className="sr-only"> — {signal.srLabel}. Open document</span>
          </button>
        ) : (
          <span
            className={cn(
              "truncate text-sm",
              state === "waived" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {documentType?.name ?? "Document"}
            <span className="sr-only"> — {signal.srLabel}</span>
          </span>
        )}

        {/* Only ever present when something is wrong, expiring, or waived. */}
        {signal.note ? (
          <span className={cn("truncate text-xs tabular-nums", signal.noteClassName)}>
            {signal.note}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {canReview && state === "pending" ? (
          // The one persistent action: a document waiting on a decision is the
          // whole reason anybody opens this tab.
          <Button size="sm" className="h-6 px-2 text-xs" onClick={onReview}>
            Review
          </Button>
        ) : needsAttention && canManage && !requirement.waiver ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            onClick={onUploadFor}
          >
            {document ? "Replace" : "Add"}
          </Button>
        ) : null}

        {actions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={pending}
                className="size-6 text-muted-foreground transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                aria-label={`Actions for ${documentType?.name ?? "requirement"}`}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.map((action, index) => (
                <Fragment key={action.key}>
                  {action.key === "revoke" && index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem onSelect={action.onSelect}>{action.label}</DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // Holds the row height steady whether or not a menu is present.
          <span className="size-6" />
        )}
      </div>
    </div>
  );
}

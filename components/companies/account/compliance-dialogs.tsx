"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CalendarDays, Sparkles } from "@/components/icons";
import { cn } from "@/lib/utils";
import type {
  ComplianceDocument,
  ComplianceDocumentType,
  ComplianceRequirement,
  ComplianceRequirementStatus,
} from "@/lib/types";

/* ================================================================
 * Shared field helpers
 * ============================================================== */

export function parseMoneyToCents(value?: string | null) {
  const normalized = value?.replace(/[$,\s]/g, "") ?? "";
  if (!normalized) return undefined;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 100);
}

export function formatMoneyInput(cents?: number | null) {
  if (cents == null) return "";
  return (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function parseDateValue(value?: string | null) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateValue(date?: Date) {
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function DatePickerField({
  label,
  value,
  onChange,
  placeholder = "Pick a date",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateValue(value);

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="microlabel">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !selectedDate && "text-muted-foreground",
            )}
          >
            <CalendarDays className="mr-2 size-4" />
            {selectedDate ? format(selectedDate, "LLL dd, y") : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => {
              onChange(formatDateValue(date));
              setOpen(false);
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The document facts a form collects, shared by the upload dialog and the review
 * dialog so a reviewer can correct exactly what an uploader could state.
 */
export interface DocumentFactValues {
  effective_date: string;
  expiry_date: string;
  policy_number: string;
  carrier_name: string;
  coverage_amount: string;
  additional_insured: boolean;
  primary_noncontributory: boolean;
  waiver_of_subrogation: boolean;
  license_number: string;
  license_jurisdiction: string;
  license_classification: string;
}

export const EMPTY_FACTS: DocumentFactValues = {
  effective_date: "",
  expiry_date: "",
  policy_number: "",
  carrier_name: "",
  coverage_amount: "",
  additional_insured: false,
  primary_noncontributory: false,
  waiver_of_subrogation: false,
  license_number: "",
  license_jurisdiction: "",
  license_classification: "",
};

export function factsToInput(facts: DocumentFactValues) {
  return {
    effective_date: facts.effective_date || undefined,
    expiry_date: facts.expiry_date || undefined,
    policy_number: facts.policy_number || undefined,
    carrier_name: facts.carrier_name || undefined,
    coverage_amount_cents: parseMoneyToCents(facts.coverage_amount),
    additional_insured: facts.additional_insured,
    primary_noncontributory: facts.primary_noncontributory,
    waiver_of_subrogation: facts.waiver_of_subrogation,
    license_number: facts.license_number || undefined,
    license_jurisdiction: facts.license_jurisdiction || undefined,
    license_classification: facts.license_classification || undefined,
  };
}

function documentToFacts(document: ComplianceDocument): DocumentFactValues {
  return {
    effective_date: document.effective_date ?? "",
    expiry_date: document.expiry_date ?? "",
    policy_number: document.policy_number ?? "",
    carrier_name: document.carrier_name ?? "",
    coverage_amount: formatMoneyInput(document.coverage_amount_cents),
    additional_insured: document.additional_insured,
    primary_noncontributory: document.primary_noncontributory,
    waiver_of_subrogation: document.waiver_of_subrogation,
    license_number: document.license_number ?? "",
    license_jurisdiction: document.license_jurisdiction ?? "",
    license_classification: document.license_classification ?? "",
  };
}

/**
 * The fields a document of this kind actually has. An insurance certificate has
 * a carrier and limits; a license has a number and a jurisdiction. Deciding this
 * from the type's `kind` is what stopped a type named "Professional license"
 * being asked for its policy limits.
 */
function FactFields({
  kind,
  hasExpiry,
  values,
  onChange,
}: {
  kind: ComplianceDocumentType["kind"];
  hasExpiry: boolean;
  values: DocumentFactValues;
  onChange: (next: Partial<DocumentFactValues>) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <DatePickerField
          label="Effective date"
          value={values.effective_date}
          onChange={(value) => onChange({ effective_date: value })}
          placeholder="Optional"
        />
        {hasExpiry ? (
          <DatePickerField
            label="Expiration date"
            value={values.expiry_date}
            onChange={(value) => onChange({ expiry_date: value })}
          />
        ) : null}
      </div>

      {kind === "insurance" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="microlabel">Policy #</Label>
              <Input
                value={values.policy_number}
                onChange={(event) => onChange({ policy_number: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="microlabel">Carrier</Label>
              <Input
                value={values.carrier_name}
                onChange={(event) => onChange({ carrier_name: event.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Coverage amount</Label>
            <InputGroup>
              <InputGroupAddon>$</InputGroupAddon>
              <InputGroupInput
                inputMode="decimal"
                placeholder="1,000,000"
                value={values.coverage_amount}
                onChange={(event) => onChange({ coverage_amount: event.target.value })}
                onBlur={() =>
                  onChange({ coverage_amount: formatMoneyInput(parseMoneyToCents(values.coverage_amount)) })
                }
              />
            </InputGroup>
          </div>
          <div className="flex flex-col gap-2 border p-3">
            <Label className="microlabel">Policy endorsements</Label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.additional_insured}
                onCheckedChange={(checked) => onChange({ additional_insured: checked === true })}
              />
              <span>Additional insured</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.primary_noncontributory}
                onCheckedChange={(checked) =>
                  onChange({ primary_noncontributory: checked === true })
                }
              />
              <span>Primary &amp; non-contributory</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.waiver_of_subrogation}
                onCheckedChange={(checked) => onChange({ waiver_of_subrogation: checked === true })}
              />
              <span>Waiver of subrogation</span>
            </label>
          </div>
        </>
      ) : null}

      {kind === "license" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">License #</Label>
            <Input
              value={values.license_number}
              onChange={(event) => onChange({ license_number: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Jurisdiction</Label>
            <Input
              placeholder="State or county"
              value={values.license_jurisdiction}
              onChange={(event) => onChange({ license_jurisdiction: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="microlabel">Classification</Label>
            <Input
              placeholder="e.g. CGC — certified general contractor"
              value={values.license_classification}
              onChange={(event) => onChange({ license_classification: event.target.value })}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ================================================================
 * Upload
 * ============================================================== */

export function ComplianceUploadDialog({
  open,
  onOpenChange,
  companyId,
  documentTypes,
  requirements,
  onUploaded,
  presetDocumentTypeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  documentTypes: ComplianceDocumentType[];
  requirements: ComplianceRequirement[];
  onUploaded: (documentId: string, facts: DocumentFactValues, typeId: string) => Promise<void>;
  presetDocumentTypeId?: string | null;
}) {
  const [selectedTypeId, setSelectedTypeId] = useState("");
  const [facts, setFacts] = useState<DocumentFactValues>(EMPTY_FACTS);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedType = documentTypes.find((type) => type.id === selectedTypeId);

  useEffect(() => {
    if (open) {
      setSelectedTypeId(presetDocumentTypeId ?? "");
      setFacts(EMPTY_FACTS);
      setFile(null);
      setError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [open, presetDocumentTypeId]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    if (selectedFile.size > 25 * 1024 * 1024) {
      setError("File size exceeds the 25MB limit");
      return;
    }
    const allowed = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic"];
    if (!allowed.includes(selectedFile.type)) {
      setError("Upload a PDF or an image");
      return;
    }
    setFile(selectedFile);
    setError(null);
  };

  const submit = async () => {
    if (!file || !selectedTypeId) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch(`/api/companies/${companyId}/compliance/upload`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const payload = await uploadRes.json().catch(() => ({}));
        throw new Error(payload.error || "Upload failed");
      }
      const { fileId } = await uploadRes.json();
      await onUploaded(fileId, facts, selectedTypeId);
      onOpenChange(false);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a document</DialogTitle>
          <DialogDescription>
            For a document the vendor sent outside the portal.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Document type</Label>
            <Select value={selectedTypeId} onValueChange={setSelectedTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select document type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {documentTypes.map((type) => {
                    const required = requirements.some((r) => r.document_type_id === type.id);
                    return (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                        {required ? " (Required)" : ""}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {selectedType ? (
            <FactFields
              kind={selectedType.kind}
              hasExpiry={selectedType.has_expiry}
              values={facts}
              onChange={(next) => setFacts((prev) => ({ ...prev, ...next }))}
            />
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">File</Label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "w-full border border-dashed px-4 py-5 text-center text-sm transition-colors hover:border-primary",
                file ? "border-success bg-success/10 text-success" : "text-muted-foreground",
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                onChange={handleFileChange}
                className="hidden"
              />
              {file ? file.name : "Choose a PDF or image up to 25MB"}
            </button>
          </div>

          {error ? (
            <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || !selectedTypeId || busy}>
            {busy ? "Uploading…" : "Add document"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================
 * Review
 * ============================================================== */

export interface ReviewValues {
  decision: "approved" | "rejected";
  notes: string;
  rejection_reason: string;
  facts: DocumentFactValues;
}

/**
 * Deciding a document, with the certificate reading beside the form.
 *
 * The reading is a proposal, never a verdict: it pre-fills what the reviewer is
 * about to confirm and says plainly where it disagrees with what the vendor
 * typed. The reviewer's word is what gets written, which is what makes the
 * deficiency check downstream trustworthy.
 */
export function ComplianceReviewDialog({
  open,
  onOpenChange,
  status,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ComplianceRequirementStatus | null;
  onSubmit: (values: ReviewValues) => void;
  busy: boolean;
}) {
  const document = status?.document ?? null;
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [notes, setNotes] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [facts, setFacts] = useState<DocumentFactValues>(EMPTY_FACTS);

  useEffect(() => {
    if (open && document) {
      setDecision("approved");
      setNotes("");
      setRejectionReason("");
      setFacts(documentToFacts(document));
    }
  }, [open, document]);

  const extraction = document?.extraction ?? null;

  /** Where the reading and the record disagree — the reviewer's actual job. */
  const disagreements = useMemo(() => {
    if (!extraction || !document) return [] as Array<{ label: string; read: string; onApply: () => void }>;
    const items: Array<{ label: string; read: string; onApply: () => void }> = [];
    if (extraction.expiry_date && extraction.expiry_date !== facts.expiry_date) {
      items.push({
        label: "Expiration",
        read: extraction.expiry_date,
        onApply: () => setFacts((prev) => ({ ...prev, expiry_date: extraction.expiry_date ?? "" })),
      });
    }
    if (extraction.carrier_name && extraction.carrier_name !== facts.carrier_name) {
      items.push({
        label: "Carrier",
        read: extraction.carrier_name,
        onApply: () => setFacts((prev) => ({ ...prev, carrier_name: extraction.carrier_name ?? "" })),
      });
    }
    if (extraction.policy_number && extraction.policy_number !== facts.policy_number) {
      items.push({
        label: "Policy #",
        read: extraction.policy_number,
        onApply: () => setFacts((prev) => ({ ...prev, policy_number: extraction.policy_number ?? "" })),
      });
    }
    const readCoverage = extraction.each_occurrence_cents;
    if (readCoverage != null && formatMoneyInput(readCoverage) !== facts.coverage_amount) {
      items.push({
        label: "Each occurrence",
        read: formatMoneyInput(readCoverage),
        onApply: () => setFacts((prev) => ({ ...prev, coverage_amount: formatMoneyInput(readCoverage) })),
      });
    }
    if (extraction.additional_insured != null && extraction.additional_insured !== facts.additional_insured) {
      items.push({
        label: "Additional insured",
        read: extraction.additional_insured ? "Yes" : "Not stated",
        onApply: () =>
          setFacts((prev) => ({ ...prev, additional_insured: extraction.additional_insured === true })),
      });
    }
    if (
      extraction.primary_noncontributory != null &&
      extraction.primary_noncontributory !== facts.primary_noncontributory
    ) {
      items.push({
        label: "Primary & non-contributory",
        read: extraction.primary_noncontributory ? "Yes" : "Not stated",
        onApply: () =>
          setFacts((prev) => ({
            ...prev,
            primary_noncontributory: extraction.primary_noncontributory === true,
          })),
      });
    }
    if (
      extraction.waiver_of_subrogation != null &&
      extraction.waiver_of_subrogation !== facts.waiver_of_subrogation
    ) {
      items.push({
        label: "Waiver of subrogation",
        read: extraction.waiver_of_subrogation ? "Yes" : "Not stated",
        onApply: () =>
          setFacts((prev) => ({
            ...prev,
            waiver_of_subrogation: extraction.waiver_of_subrogation === true,
          })),
      });
    }
    return items;
  }, [extraction, facts, document]);

  const applyAll = () => disagreements.forEach((item) => item.onApply());

  if (!status || !document) return null;
  const documentType = status.requirement.document_type;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review {documentType?.name ?? "document"}</DialogTitle>
          <DialogDescription>
            Approving this is what lets payments to this vendor move, so the facts you confirm here
            are the ones the hold reads.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {extraction ? (
            <div className="border bg-muted/20 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <Sparkles className="size-3.5 text-primary" />
                  Arc read this certificate
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {extraction.confidence} confidence
                </span>
              </div>
              {disagreements.length === 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Everything it found matches what is on the record.
                </p>
              ) : (
                <>
                  <ul className="mt-2 space-y-1">
                    {disagreements.map((item) => (
                      <li
                        key={item.label}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="text-muted-foreground">
                          {item.label}: <span className="text-foreground">{item.read}</span>
                        </span>
                        <button
                          type="button"
                          onClick={item.onApply}
                          className="shrink-0 text-primary underline-offset-2 hover:underline"
                        >
                          Use
                        </button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7 text-xs"
                    onClick={applyAll}
                  >
                    Use all {disagreements.length}
                  </Button>
                </>
              )}
              {extraction.notes.length > 0 ? (
                <p className="mt-2 border-l-2 border-border pl-2 text-[11px] text-muted-foreground">
                  {extraction.notes.join(" · ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {documentType ? (
            <FactFields
              kind={documentType.kind}
              hasExpiry={documentType.has_expiry}
              values={facts}
              onChange={(next) => setFacts((prev) => ({ ...prev, ...next }))}
            />
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Decision</Label>
            <Select
              value={decision}
              onValueChange={(value) => setDecision(value as "approved" | "rejected")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approve</SelectItem>
                <SelectItem value="rejected">Send back</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {decision === "rejected" ? (
            <div className="flex flex-col gap-1.5">
              <Label className="microlabel">What needs fixing</Label>
              <Textarea
                rows={3}
                placeholder="The vendor sees this, so say what a corrected copy needs."
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Internal note</Label>
            <Input
              placeholder="Only your team sees this"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={decision === "rejected" ? "destructive" : "default"}
            disabled={busy}
            onClick={() => onSubmit({ decision, notes, rejection_reason: rejectionReason, facts })}
          >
            {busy ? "Recording…" : decision === "approved" ? "Approve" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================
 * Waive / revoke / request
 * ============================================================== */

export function ComplianceWaiveDialog({
  open,
  onOpenChange,
  requirement,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirement: ComplianceRequirement | null;
  onSubmit: (values: { reason: string; expires_at: string }) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  useEffect(() => {
    if (open) {
      setReason(requirement?.waiver?.reason ?? "");
      setExpiresAt(requirement?.waiver?.expires_at ?? "");
    }
  }, [open, requirement]);

  if (!requirement) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Waive {requirement.document_type?.name ?? "requirement"}</DialogTitle>
          <DialogDescription>
            A waiver releases the payment hold this requirement was raising, so it is recorded
            against your name the same way an override is.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="microlabel">Reason</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Covered under the project OCIP"
            />
          </div>
          <DatePickerField
            label="Waiver expires"
            value={expiresAt}
            onChange={setExpiresAt}
            placeholder="Never"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => onSubmit({ reason, expires_at: expiresAt })}>
            {busy ? "Saving…" : "Save waiver"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComplianceWaiveAllDialog({
  open,
  onOpenChange,
  companyName,
  requirementCount,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  requirementCount: number;
  onSubmit: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Waive all requirements</DialogTitle>
          <DialogDescription>
            {companyName} will be exempt from {requirementCount}{" "}
            {requirementCount === 1 ? "requirement" : "requirements"}. Compliance autopilot will
            stop emailing them about these documents, and related standing payment holds will be
            released.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label className="microlabel">Reason</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. This vendor only supplies materials"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || reason.trim().length < 3} onClick={() => onSubmit(reason)}>
            {busy ? "Waiving…" : "Waive all requirements"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComplianceRevokeDialog({
  open,
  onOpenChange,
  document,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: ComplianceDocument | null;
  onSubmit: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!document) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw this decision</DialogTitle>
          <DialogDescription>
            The document stops satisfying its requirement immediately and the vendor is back on the
            hook for a replacement. Any payable this approval released has already gone out.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label className="microlabel">Reason</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this decision being withdrawn?"
          />
          {reason.trim().length > 0 && reason.trim().length < 8 ? (
            <p className="text-xs text-muted-foreground">
              A meaningful reason is required (at least 8 characters).
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || reason.trim().length < 8}
            onClick={() => onSubmit(reason.trim())}
          >
            {busy ? "Withdrawing…" : "Withdraw decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComplianceRequestDialog({
  open,
  onOpenChange,
  outstanding,
  companyName,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outstanding: ComplianceRequirementStatus[];
  companyName: string;
  onSubmit: (documentTypeIds: string[]) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      setSelected(
        Object.fromEntries(outstanding.map((item) => [item.requirement.document_type_id, true])),
      );
    }
  }, [open, outstanding]);

  const selectedIds = Object.entries(selected)
    .filter(([, checked]) => checked)
    .map(([id]) => id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ask {companyName} for documents</DialogTitle>
          <DialogDescription>
            Sends one email listing what is outstanding, with a link to their portal if they already
            have one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {outstanding.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing is outstanding for this vendor.
            </p>
          ) : (
            outstanding.map((item) => (
              <label
                key={item.requirement.document_type_id}
                className="flex items-center gap-2 border px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={selected[item.requirement.document_type_id] ?? false}
                  onCheckedChange={(checked) =>
                    setSelected((prev) => ({
                      ...prev,
                      [item.requirement.document_type_id]: checked === true,
                    }))
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {item.requirement.document_type?.name ?? "Document"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.state === "expired" ? "Expired" : item.state === "rejected" ? "Sent back" : "Missing"}
                </span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || selectedIds.length === 0} onClick={() => onSubmit(selectedIds)}>
            {busy ? "Sending…" : `Send request`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

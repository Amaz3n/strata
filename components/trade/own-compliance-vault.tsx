"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  shareOwnComplianceDocumentAction,
  uploadOwnComplianceDocumentAction,
} from "@/app/(app)/trade/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { daysUntil } from "@/lib/compliance/dates";
import type {
  OwnComplianceDocument,
  OwnComplianceShareOutcome,
  OwnComplianceVault,
} from "@/lib/services/own-compliance";
import { formatMoneyCents } from "@/lib/utils";
import {
  OWN_COMPLIANCE_TYPE_CODES,
  OWN_COMPLIANCE_TYPE_LABELS,
  ownComplianceTypeFamily,
  ownComplianceUploadSchema,
  type OwnComplianceTypeCode,
} from "@/lib/validation/own-compliance";

const CORE_TYPES: OwnComplianceTypeCode[] = ["coi", "w9", "license", "bond"];
const EXPIRY_WARNING_DAYS = 30;

const OUTCOME_LABEL: Record<OwnComplianceShareOutcome["status"], string> = {
  shared: "Shared",
  already_shared: "Already had it",
  not_requested: "Doesn't ask for this",
  failed: "Failed",
};

function formatDay(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Expiry({ document }: { document: OwnComplianceDocument }) {
  if (document.typeCode === "w9") return <span className="text-muted-foreground">No expiry</span>;
  if (!document.expiryDate) return <span className="text-muted-foreground">—</span>;
  const days = daysUntil(document.expiryDate);
  if (days !== null && days < 0) {
    return <span className="font-medium text-destructive">Expired {formatDay(document.expiryDate)}</span>;
  }
  if (days !== null && days <= EXPIRY_WARNING_DAYS) {
    return (
      <span className="font-medium text-warning">
        {days === 0 ? "Expires today" : `Expires in ${days} ${days === 1 ? "day" : "days"}`}
        <span className="ml-2 font-normal text-muted-foreground">{formatDay(document.expiryDate)}</span>
      </span>
    );
  }
  return <span>{formatDay(document.expiryDate)}</span>;
}

function identity(document: OwnComplianceDocument) {
  const family = ownComplianceTypeFamily(document.typeCode);
  const parts =
    family === "license"
      ? [document.licenseNumber, document.licenseJurisdiction]
      : family === "tax"
        ? []
        : [document.carrierName, document.policyNumber];
  const text = parts.filter(Boolean).join(" · ");
  const coverage =
    document.coverageAmountCents !== null && family !== "license" && family !== "tax"
      ? formatMoneyCents(document.coverageAmountCents)
      : null;
  return { text, coverage };
}

function OutcomeList({ outcomes }: { outcomes: OwnComplianceShareOutcome[] }) {
  return (
    <ul className="divide-y border-y text-xs">
      {outcomes.map((outcome) => (
        <li key={outcome.builderOrgId} className="flex items-baseline justify-between gap-4 py-1.5">
          <span className="font-medium">{outcome.builderName}</span>
          <span
            className={
              outcome.status === "failed"
                ? "text-destructive"
                : outcome.status === "shared"
                  ? "text-success"
                  : "text-muted-foreground"
            }
          >
            {outcome.status === "failed" && outcome.error ? outcome.error : OUTCOME_LABEL[outcome.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Flag({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <span>{label}</span>
    </label>
  );
}

function UploadSheet({
  type,
  builderCount,
  onClose,
  onUploaded,
}: {
  type: OwnComplianceTypeCode | "other";
  builderCount: number;
  onClose: () => void;
  onUploaded: (documentId: string, outcomes: OwnComplianceShareOutcome[] | null) => void;
}) {
  const [code, setCode] = useState<OwnComplianceTypeCode>(type === "other" ? "workers_comp" : type);
  const [file, setFile] = useState<File | null>(null);
  const [effective, setEffective] = useState("");
  const [expiry, setExpiry] = useState("");
  const [carrier, setCarrier] = useState("");
  const [policy, setPolicy] = useState("");
  const [coverage, setCoverage] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [classification, setClassification] = useState("");
  const [additionalInsured, setAdditionalInsured] = useState(false);
  const [primaryNoncontributory, setPrimaryNoncontributory] = useState(false);
  const [waiver, setWaiver] = useState(false);
  const [share, setShare] = useState(builderCount > 0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const family = ownComplianceTypeFamily(code);

  function submit() {
    setError(null);
    const coverageCents = coverage.trim() === "" ? undefined : Math.round(Number(coverage) * 100);
    const parsed = ownComplianceUploadSchema.safeParse({
      document_type_code: code,
      effective_date: effective,
      expiry_date: code === "w9" ? "" : expiry,
      carrier_name: carrier,
      policy_number: policy,
      coverage_amount_cents: coverageCents,
      license_number: licenseNumber,
      license_jurisdiction: jurisdiction,
      license_classification: classification,
      additional_insured: additionalInsured,
      primary_noncontributory: primaryNoncontributory,
      waiver_of_subrogation: waiver,
      share_after_upload: share,
    });
    const next: Record<string, string> = {};
    if (!file) next.file = "Choose a file";
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!next[key]) next[key] = issue.message;
      }
    }
    setFieldErrors(next);
    if (!file || !parsed.success) return;

    const data = new FormData();
    data.set("file", file);
    data.set("document_type_code", code);
    data.set("effective_date", effective);
    data.set("expiry_date", code === "w9" ? "" : expiry);
    data.set("carrier_name", carrier);
    data.set("policy_number", policy);
    data.set("coverage_dollars", coverage);
    data.set("license_number", licenseNumber);
    data.set("license_jurisdiction", jurisdiction);
    data.set("license_classification", classification);
    data.set("additional_insured", String(additionalInsured));
    data.set("primary_noncontributory", String(primaryNoncontributory));
    data.set("waiver_of_subrogation", String(waiver));
    data.set("share_after_upload", String(share));
    startTransition(async () => {
      const result = await uploadOwnComplianceDocumentAction(data);
      if (!result.success) {
        setError(result.error);
        return;
      }
      onUploaded(result.data.document.id, result.data.outcomes);
    });
  }

  const fieldError = (key: string) =>
    fieldErrors[key] ? (
      <p role="alert" className="text-xs text-destructive">
        {fieldErrors[key]}
      </p>
    ) : null;

  return (
    <Sheet open onOpenChange={(open) => !open && !pending && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{OWN_COMPLIANCE_TYPE_LABELS[code]}</SheetTitle>
          <SheetDescription>
            The new document becomes current. The one it replaces stays in history.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex-1 space-y-4 overflow-y-auto px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {type === "other" && (
            <div className="space-y-2">
              <Label htmlFor="own-doc-type">Document</Label>
              <select
                id="own-doc-type"
                value={code}
                onChange={(e) =>
                  setCode(OWN_COMPLIANCE_TYPE_CODES.find((c) => c === e.target.value) ?? code)
                }
                className="h-10 w-full border border-input bg-background px-3 text-sm"
              >
                {OWN_COMPLIANCE_TYPE_CODES.filter((c) => !CORE_TYPES.includes(c)).map((c) => (
                  <option key={c} value={c}>
                    {OWN_COMPLIANCE_TYPE_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="own-doc-file">File</Label>
            <Input
              id="own-doc-file"
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              aria-invalid={fieldErrors.file ? true : undefined}
            />
            {fieldError("file")}
          </div>
          {family !== "tax" && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="own-doc-effective">Effective</Label>
                <Input
                  id="own-doc-effective"
                  type="date"
                  value={effective}
                  onChange={(e) => setEffective(e.target.value)}
                  className="tabular-nums"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="own-doc-expiry">Expires</Label>
                <Input
                  id="own-doc-expiry"
                  type="date"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className="tabular-nums"
                  aria-invalid={fieldErrors.expiry_date ? true : undefined}
                />
                {fieldError("expiry_date")}
              </div>
            </div>
          )}
          {(family === "insurance" || family === "bond") && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="own-doc-carrier">{family === "bond" ? "Surety" : "Carrier"}</Label>
                  <Input id="own-doc-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="own-doc-policy">{family === "bond" ? "Bond number" : "Policy number"}</Label>
                  <Input id="own-doc-policy" value={policy} onChange={(e) => setPolicy(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="own-doc-coverage">{family === "bond" ? "Bond amount ($)" : "Coverage ($)"}</Label>
                <Input
                  id="own-doc-coverage"
                  inputMode="decimal"
                  value={coverage}
                  onChange={(e) => setCoverage(e.target.value.replace(/[^\d.]/g, ""))}
                  className="tabular-nums"
                  aria-invalid={fieldErrors.coverage_amount_cents ? true : undefined}
                />
                {fieldError("coverage_amount_cents")}
              </div>
            </>
          )}
          {family === "insurance" && (
            <div className="space-y-2">
              <Flag label="Additional insured" checked={additionalInsured} onChange={setAdditionalInsured} />
              <Flag
                label="Primary and non-contributory"
                checked={primaryNoncontributory}
                onChange={setPrimaryNoncontributory}
              />
              <Flag label="Waiver of subrogation" checked={waiver} onChange={setWaiver} />
            </div>
          )}
          {family === "license" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="own-doc-license">License number</Label>
                  <Input id="own-doc-license" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="own-doc-jurisdiction">Jurisdiction</Label>
                  <Input id="own-doc-jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="own-doc-class">Classification</Label>
                <Input id="own-doc-class" value={classification} onChange={(e) => setClassification(e.target.value)} />
              </div>
            </>
          )}
          {builderCount > 0 && (
            <label className="flex items-center gap-3 text-sm">
              <Checkbox checked={share} onCheckedChange={(value) => setShare(value === true)} />
              <span>Share with my builders after upload</span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <SheetFooter className="flex-row justify-end gap-2 border-t">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Uploading…" : "Upload"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function OwnComplianceVaultSection({
  vault,
  loadError,
  canManage,
}: {
  vault: OwnComplianceVault | null;
  loadError: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [uploading, setUploading] = useState<OwnComplianceTypeCode | "other" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<{ documentId: string; list: OwnComplianceShareOutcome[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (loadError || !vault) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Compliance documents</h2>
        <p role="alert" className="text-sm text-destructive">
          {loadError ?? "Compliance documents are unavailable."}
        </p>
      </section>
    );
  }

  const byType = new Map(vault.current.map((document) => [document.typeCode, document]));
  const rows: Array<{ code: OwnComplianceTypeCode; document: OwnComplianceDocument | null }> = [
    ...CORE_TYPES.map((code) => ({ code, document: byType.get(code) ?? null })),
    ...vault.current
      .filter((document) => !CORE_TYPES.includes(document.typeCode))
      .map((document) => ({ code: document.typeCode, document })),
  ];

  function share(documentId: string) {
    setError(null);
    setSharingId(documentId);
    startTransition(async () => {
      const result = await shareOwnComplianceDocumentAction({ document_id: documentId });
      setSharingId(null);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setOutcomes({ documentId, list: result.data.outcomes });
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Compliance documents</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Keep your certificate, W-9, license, and bond here once. Share them with every builder you work
            for; each builder reviews its own copy. We email the office before anything lapses.
          </p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setUploading("other")}>
            Add other document
          </Button>
        )}
      </div>
      {vault.builderCount === 0 && (
        <p className="text-xs text-muted-foreground">
          No builder connections yet. Once a builder shares a project with you, you can send them these documents.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="border-y">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Carrier / number</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Builders</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ code, document }) => {
              const asked = document?.builders.filter((b) => b.state !== "not_requested") ?? [];
              const sharedCount = asked.filter((b) => b.state === "shared").length;
              const open = document && expanded === document.id;
              const panel = document && outcomes?.documentId === document.id ? outcomes.list : null;
              const info = document ? identity(document) : null;
              return (
                <Fragment key={code}>
                  <TableRow>
                    <TableCell className="font-medium">
                      {OWN_COMPLIANCE_TYPE_LABELS[code]}
                    </TableCell>
                    <TableCell className="text-sm">
                      {document ? (
                        <>
                          {info?.text || <span className="text-muted-foreground">—</span>}
                          {info?.coverage && (
                            <span className="ml-2 tabular-nums text-muted-foreground">{info.coverage}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">Not on file</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {document ? <Expiry document={document} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {!document ? (
                        <span className="text-muted-foreground">—</span>
                      ) : asked.length === 0 ? (
                        <span className="text-muted-foreground">
                          {vault.builderCount === 0 ? "No builders" : "No builder asks for this"}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : document.id)}
                          className="text-left hover:underline focus-visible:outline focus-visible:outline-ring"
                          aria-expanded={Boolean(open)}
                        >
                          Shared with {sharedCount} of {asked.length}{" "}
                          {asked.length === 1 ? "builder" : "builders"}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <div className="flex justify-end gap-2">
                          {document && sharedCount < asked.length && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => share(document.id)}
                            >
                              {sharingId === document.id ? "Sharing…" : "Share with builders"}
                            </Button>
                          )}
                          <Button size="sm" variant={document ? "ghost" : "default"} onClick={() => setUploading(code)}>
                            {document ? "Replace" : "Upload"}
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  {document && (open || panel) && (
                    <TableRow>
                      <TableCell colSpan={5} className="bg-muted/30">
                        {panel ? (
                          <OutcomeList outcomes={panel} />
                        ) : (
                          <ul className="divide-y border-y text-xs">
                            {document.builders.map((builder) => (
                              <li key={builder.builderOrgId} className="flex items-baseline justify-between gap-4 py-1.5">
                                <span className="font-medium">{builder.builderName}</span>
                                <span className={builder.state === "shared" ? "text-success" : "text-muted-foreground"}>
                                  {builder.state === "shared"
                                    ? "Shared"
                                    : builder.state === "not_shared"
                                      ? "Not shared yet"
                                      : "Doesn't ask for this"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {vault.history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Previous versions ({vault.history.length}
            {vault.historyTruncated ? "+" : ""})
          </summary>
          <ul className="mt-2 divide-y border-y">
            {vault.history.map((document) => (
              <li key={document.id} className="flex items-baseline justify-between gap-4 py-1.5">
                <span>
                  <span className="font-medium">{document.typeLabel}</span>
                  <span className="ml-2 text-muted-foreground">{document.fileName}</span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {document.expiryDate ? `Expired ${formatDay(document.expiryDate)}` : "No expiry"}
                </span>
              </li>
            ))}
          </ul>
          {vault.historyTruncated && (
            <p className="mt-1 text-muted-foreground">Showing the latest {vault.history.length}.</p>
          )}
        </details>
      )}
      {uploading && (
        <UploadSheet
          key={uploading}
          type={uploading}
          builderCount={vault.builderCount}
          onClose={() => setUploading(null)}
          onUploaded={(documentId, list) => {
            setUploading(null);
            setOutcomes(list ? { documentId, list } : null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

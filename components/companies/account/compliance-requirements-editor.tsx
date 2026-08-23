"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  COMPLIANCE_KIND_ORDER,
  complianceKindLabel,
} from "@/components/companies/account/compliance-status";
import {
  formatMoneyInput,
  parseMoneyToCents,
} from "@/components/companies/account/compliance-dialogs";
import { StatusChip } from "@/components/companies/company-detail-ui";
import { cn } from "@/lib/utils";
import type {
  ComplianceDocumentKind,
  ComplianceDocumentType,
  ComplianceRequirement,
} from "@/lib/types";

export interface RequirementDraft {
  document_type_id: string;
  is_required: true;
  min_coverage_cents?: number;
  requires_additional_insured: boolean;
  requires_primary_noncontributory: boolean;
  requires_waiver_of_subrogation: boolean;
  notes?: string;
}

/**
 * What this vendor owes, on top of the org policy.
 *
 * Inherited rules are shown but not editable here — turning one off is a waiver,
 * which is an audited act with a reason, not a checkbox. Ticking an inherited
 * type creates a vendor-specific rule that replaces it.
 */
export function ComplianceRequirementsEditor({
  open,
  onOpenChange,
  companyName,
  documentTypes,
  currentRequirements,
  onSave,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  documentTypes: ComplianceDocumentType[];
  currentRequirements: ComplianceRequirement[];
  onSave: (requirements: RequirementDraft[]) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [minCoverage, setMinCoverage] = useState<Record<string, string>>({});
  const [additionalInsured, setAdditionalInsured] = useState<Record<string, boolean>>({});
  const [primaryNoncontributory, setPrimaryNoncontributory] = useState<Record<string, boolean>>({});
  const [waiverOfSubrogation, setWaiverOfSubrogation] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const nextSelected: Record<string, boolean> = {};
    const nextNotes: Record<string, string> = {};
    const nextCoverage: Record<string, string> = {};
    const nextAi: Record<string, boolean> = {};
    const nextPnc: Record<string, boolean> = {};
    const nextWos: Record<string, boolean> = {};
    for (const requirement of currentRequirements) {
      if (requirement.source !== "company_override") continue;
      nextSelected[requirement.document_type_id] = true;
      if (requirement.notes) nextNotes[requirement.document_type_id] = requirement.notes;
      if (requirement.min_coverage_cents) {
        nextCoverage[requirement.document_type_id] = formatMoneyInput(requirement.min_coverage_cents);
      }
      nextAi[requirement.document_type_id] = Boolean(requirement.requires_additional_insured);
      nextPnc[requirement.document_type_id] = Boolean(requirement.requires_primary_noncontributory);
      nextWos[requirement.document_type_id] = Boolean(requirement.requires_waiver_of_subrogation);
    }
    setSelected(nextSelected);
    setNotes(nextNotes);
    setMinCoverage(nextCoverage);
    setAdditionalInsured(nextAi);
    setPrimaryNoncontributory(nextPnc);
    setWaiverOfSubrogation(nextWos);
    // Deliberately keyed on `open` alone: `currentRequirements` is a new array
    // on every server render, so including it meant a background refresh wiped
    // whatever the user was in the middle of typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const inheritedByTypeId = useMemo(() => {
    const map = new Map<string, ComplianceRequirement>();
    for (const requirement of currentRequirements) {
      if (requirement.source === "org_default") map.set(requirement.document_type_id, requirement);
    }
    return map;
  }, [currentRequirements]);

  const projectOverlayTypeIds = useMemo(
    () =>
      new Set(
        currentRequirements
          .filter((requirement) => requirement.source === "project_overlay")
          .map((requirement) => requirement.document_type_id),
      ),
    [currentRequirements],
  );

  /**
   * Vendor rules on a document type this sheet cannot render — the type was
   * deactivated after the rule was written. They are invisible here, so the
   * diff must carry them through rather than delete what nobody could see.
   */
  const unrenderableRules = useMemo(() => {
    const renderable = new Set(documentTypes.map((type) => type.id));
    return currentRequirements.filter(
      (requirement) =>
        requirement.source === "company_override" && !renderable.has(requirement.document_type_id),
    );
  }, [currentRequirements, documentTypes]);

  const grouped = useMemo(() => {
    const byKind = new Map<ComplianceDocumentKind, ComplianceDocumentType[]>();
    for (const type of documentTypes) {
      const list = byKind.get(type.kind) ?? [];
      list.push(type);
      byKind.set(type.kind, list);
    }
    return COMPLIANCE_KIND_ORDER.filter((kind) => (byKind.get(kind) ?? []).length > 0).map(
      (kind) => ({ kind, types: byKind.get(kind) ?? [] }),
    );
  }, [documentTypes]);

  const selectedCount = documentTypes.filter((type) => selected[type.id]).length;

  const save = () => {
    const edited: RequirementDraft[] = documentTypes
      .filter((type) => selected[type.id])
      .map((type) => ({
        document_type_id: type.id,
        is_required: true as const,
        min_coverage_cents: parseMoneyToCents(minCoverage[type.id]),
        requires_additional_insured: additionalInsured[type.id] ?? false,
        requires_primary_noncontributory: primaryNoncontributory[type.id] ?? false,
        requires_waiver_of_subrogation: waiverOfSubrogation[type.id] ?? false,
        notes: notes[type.id] || undefined,
      }));

    const preserved: RequirementDraft[] = unrenderableRules.map((requirement) => ({
      document_type_id: requirement.document_type_id,
      is_required: true as const,
      min_coverage_cents: requirement.min_coverage_cents ?? undefined,
      requires_additional_insured: requirement.requires_additional_insured,
      requires_primary_noncontributory: requirement.requires_primary_noncontributory,
      requires_waiver_of_subrogation: requirement.requires_waiver_of_subrogation,
      notes: requirement.notes ?? undefined,
    }));

    onSave([...edited, ...preserved]);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex w-full flex-col gap-0 p-0 sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-2xl fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="border-b bg-muted/40 px-4 py-3 text-left">
          <SheetTitle className="text-sm font-semibold">What {companyName} must carry</SheetTitle>
          <SheetDescription className="text-xs">
            Rules set here replace your org policy for this vendor. To drop an inherited rule
            instead, waive it on its row — a waiver is recorded with a reason.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {grouped.map(({ kind, types }) => (
            <div key={kind}>
              <div className="microlabel border-b bg-muted/20 px-4 py-1.5">
                {complianceKindLabel(kind)}
              </div>
              <div className="divide-y">
                {types.map((type) => {
                  const isSelected = selected[type.id] ?? false;
                  const inherited = inheritedByTypeId.get(type.id);
                  return (
                    <div key={type.id}>
                      <div className="flex items-start gap-3 px-4 py-3">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            setSelected((prev) => ({ ...prev, [type.id]: checked === true }))
                          }
                          className="mt-0.5"
                          aria-label={`${inherited ? "Override" : "Require"} ${type.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{type.name}</span>
                            {inherited ? (
                              <StatusChip
                                label="Org policy"
                                className="border-border text-muted-foreground"
                              />
                            ) : null}
                            {projectOverlayTypeIds.has(type.id) ? (
                              <StatusChip
                                label="Project rule"
                                className="border-border text-muted-foreground"
                              />
                            ) : null}
                            {isSelected ? (
                              <StatusChip
                                label={inherited ? "Overridden" : "Vendor rule"}
                                className="border-primary/30 text-primary"
                              />
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {inherited && !isSelected
                              ? "Inherited from your org policy."
                              : type.description ||
                                (type.has_expiry
                                  ? `Expires · warned ${type.expiry_warning_days} days ahead`
                                  : "Does not expire")}
                          </p>
                        </div>
                      </div>

                      {isSelected ? (
                        <div className="border-t bg-muted/10 px-4 py-3">
                          {type.kind === "insurance" ? (
                            <div className="mb-3 flex flex-col gap-3">
                              <div className="max-w-xs">
                                <Label className="microlabel mb-1 block">Minimum coverage</Label>
                                <InputGroup>
                                  <InputGroupAddon>$</InputGroupAddon>
                                  <InputGroupInput
                                    inputMode="decimal"
                                    placeholder="1,000,000"
                                    value={minCoverage[type.id] || ""}
                                    onChange={(event) =>
                                      setMinCoverage((prev) => ({
                                        ...prev,
                                        [type.id]: event.target.value,
                                      }))
                                    }
                                    onBlur={() =>
                                      setMinCoverage((prev) => ({
                                        ...prev,
                                        [type.id]: formatMoneyInput(parseMoneyToCents(prev[type.id])),
                                      }))
                                    }
                                  />
                                </InputGroup>
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <Label className="microlabel">Required endorsements</Label>
                                <div className="grid gap-2 sm:grid-cols-3">
                                  {(
                                    [
                                      ["Additional insured", additionalInsured, setAdditionalInsured],
                                      [
                                        "Primary & non-contributory",
                                        primaryNoncontributory,
                                        setPrimaryNoncontributory,
                                      ],
                                      [
                                        "Waiver of subrogation",
                                        waiverOfSubrogation,
                                        setWaiverOfSubrogation,
                                      ],
                                    ] as const
                                  ).map(([label, state, setState]) => (
                                    <label
                                      key={label}
                                      className={cn(
                                        "flex min-h-9 items-center gap-2 border px-2.5 py-1.5 text-xs",
                                        state[type.id] ? "border-primary/40" : "bg-background",
                                      )}
                                    >
                                      <Checkbox
                                        checked={state[type.id] || false}
                                        onCheckedChange={(checked) =>
                                          setState((prev) => ({
                                            ...prev,
                                            [type.id]: checked === true,
                                          }))
                                        }
                                      />
                                      <span>{label}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : null}
                          <div className="flex flex-col gap-1.5">
                            <Label className="microlabel">Note for this requirement</Label>
                            <Textarea
                              rows={2}
                              className="text-sm"
                              placeholder="e.g. Must name us and the owner as additional insured"
                              value={notes[type.id] || ""}
                              onChange={(event) =>
                                setNotes((prev) => ({ ...prev, [type.id]: event.target.value }))
                              }
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t bg-background px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {selectedCount} vendor {selectedCount === 1 ? "rule" : "rules"} ·{" "}
            {inheritedByTypeId.size} inherited
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

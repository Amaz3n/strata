"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Save } from "lucide-react";
import { uploadFileAction } from "@/app/(app)/documents/actions";

import {
  createPlanVersionAction,
  releasePlanVersionAction,
  replaceTakeoffLinesAction,
  setCommunityAvailabilityAction,
  updateHousePlanAction,
  updatePlanVersionAction,
  upsertElevationAction,
} from "@/app/(app)/plans/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { unwrapAction } from "@/lib/action-result";
import type { CostType } from "@/lib/cost-types";
import type { BudgetTemplateDto } from "@/lib/services/budget-templates";
import type { ChecklistTemplate } from "@/lib/services/inspections";
import type { CommunityListItemDTO } from "@/lib/services/communities";
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  HousePlanVersionDto,
  PlanVersionDriftDto,
} from "@/lib/services/house-plans";
import type { ScheduleTemplate, CostCode } from "@/lib/types";

type TakeoffDraft = {
  costCodeId: string;
  costType: CostType | null;
  description: string;
  quantity: string;
  uom: string;
  unitCostDollars: string;
  elevationId: string;
};

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function BundleSnapshotSummary({
  snapshot,
}: {
  snapshot: Record<string, unknown> | null;
}) {
  if (!snapshot)
    return (
      <p className="text-sm text-muted-foreground">
        No release snapshot is available.
      </p>
    );
  const budget =
    typeof snapshot.budget_template === "object" && snapshot.budget_template
      ? (snapshot.budget_template as Record<string, unknown>)
      : null;
  const schedule =
    typeof snapshot.schedule_template === "object" && snapshot.schedule_template
      ? (snapshot.schedule_template as Record<string, unknown>)
      : null;
  const checklists = Array.isArray(snapshot.checklists)
    ? snapshot.checklists
    : [];
  const selections = Array.isArray(snapshot.selection_categories)
    ? snapshot.selection_categories
    : [];
  const budgetLines =
    budget && Array.isArray(budget.lines) ? budget.lines.length : 0;
  const scheduleItems =
    schedule && Array.isArray(schedule.items) ? schedule.items.length : 0;
  return (
    <div className="grid gap-3 border p-4 text-sm sm:grid-cols-2">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Budget
        </p>
        <p>
          {String(budget?.name ?? "None")} · {budgetLines} lines
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Schedule
        </p>
        <p>
          {String(schedule?.name ?? "None")} · {scheduleItems} items
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Checklists
        </p>
        <p>{checklists.length} captured</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Selection categories
        </p>
        <p>{selections.length} captured</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Plan set
        </p>
        <p>{snapshot.drawing_source_file_id ? "PDF captured" : "None"}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Captured
        </p>
        <p>
          {typeof snapshot.captured_at === "string"
            ? new Date(snapshot.captured_at).toLocaleString()
            : "At release"}
        </p>
      </div>
    </div>
  );
}

function toDrafts(version: HousePlanVersionDto): TakeoffDraft[] {
  return (version.takeoff_lines ?? []).map((line) => ({
    costCodeId: line.cost_code_id,
    costType: line.cost_type,
    description: line.description,
    quantity: String(line.quantity),
    uom: line.uom,
    unitCostDollars:
      line.unit_cost_cents == null
        ? ""
        : (line.unit_cost_cents / 100).toFixed(2),
    elevationId: line.elevation_id ?? "base",
  }));
}

export function PlanDetailClient({
  plan,
  drift,
  costCodes,
  budgetTemplates,
  scheduleTemplates,
  checklistTemplates,
  communities,
  availability,
  canWrite,
  canRelease,
}: {
  plan: HousePlanDto;
  drift: PlanVersionDriftDto[];
  costCodes: CostCode[];
  budgetTemplates: BudgetTemplateDto[];
  scheduleTemplates: ScheduleTemplate[];
  checklistTemplates: ChecklistTemplate[];
  communities: CommunityListItemDTO[];
  availability: CommunityPlanAvailabilityDto[];
  canWrite: boolean;
  canRelease: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const versions = plan.versions ?? [];
  const [versionId, setVersionId] = useState(
    versions.find((version) => version.status === "draft")?.id ??
      versions[0]?.id ??
      "",
  );
  const version = versions.find((item) => item.id === versionId) ?? versions[0];
  const [takeoff, setTakeoff] = useState<TakeoffDraft[]>(
    version ? toDrafts(version) : [],
  );
  const [elevationCode, setElevationCode] = useState("");
  const [elevationName, setElevationName] = useState("");
  const [bundleBudget, setBundleBudget] = useState(
    version?.budget_template_id ?? "none",
  );
  const [bundleSchedule, setBundleSchedule] = useState(
    version?.schedule_template_id ?? "none",
  );
  const [bundleDrawing, setBundleDrawing] = useState(
    version?.drawing_source_file_id ?? "",
  );
  const [bundleChecks, setBundleChecks] = useState<string[]>(
    version?.checklist_template_ids ?? [],
  );
  const [csvTakeoff, setCsvTakeoff] = useState("");
  const availabilityKeys = useMemo(
    () => [null, ...(plan.elevations ?? []).map((elevation) => elevation.id)],
    [plan.elevations],
  );
  const [availabilityDraft, setAvailabilityDraft] = useState<
    Record<
      string,
      { available: boolean; price: string; start: string; end: string }
    >
  >(() =>
    Object.fromEntries(
      communities.flatMap((community) =>
        [null, ...(plan.elevations ?? []).map((elevation) => elevation.id)].map(
          (elevationId) => {
            const entry = availability.find(
              (row) =>
                row.community_id === community.id &&
                row.elevation_id === elevationId,
            );
            return [
              `${community.id}:${elevationId ?? "all"}`,
              {
                available: entry?.is_available ?? false,
                price: entry ? (entry.base_price_cents / 100).toFixed(2) : "",
                start: entry?.effective_start ?? "",
                end: entry?.effective_end ?? "",
              },
            ];
          },
        ),
      ),
    ),
  );

  function chooseVersion(id: string) {
    setVersionId(id);
    const selected = versions.find((item) => item.id === id);
    if (!selected) return;
    setTakeoff(toDrafts(selected));
    setBundleBudget(selected.budget_template_id ?? "none");
    setBundleSchedule(selected.schedule_template_id ?? "none");
    setBundleDrawing(selected.drawing_source_file_id ?? "");
    setBundleChecks(selected.checklist_template_ids);
  }

  function refreshTask(operation: () => Promise<unknown>, success: string) {
    startTransition(async () => {
      try {
        await operation();
        toast.success(success);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The plan could not be updated",
        );
      }
    });
  }

  const manualTotal = useMemo(
    () =>
      takeoff.reduce(
        (sum, line) =>
          sum +
          Math.round(
            (Number(line.quantity) || 0) *
              (Number(line.unitCostDollars) || 0) *
              100,
          ),
        0,
      ),
    [takeoff],
  );
  const editableVersion = canWrite && version?.status === "draft";

  function addTakeoffLine() {
    setTakeoff((current) => [
      ...current,
      {
        costCodeId: costCodes[0]?.id ?? "",
        costType: costCodes[0]?.cost_type ?? null,
        description: "",
        quantity: "1",
        uom: costCodes[0]?.unit ?? "ea",
        unitCostDollars: "",
        elevationId: "base",
      },
    ]);
  }

  function saveTakeoff() {
    if (!version) return;
    refreshTask(
      async () =>
        unwrapAction(
          await replaceTakeoffLinesAction(
            plan.id,
            version.id,
            takeoff
              .filter(
                (line) =>
                  line.costCodeId && line.description.trim() && line.uom.trim(),
              )
              .map((line) => ({
                costCodeId: line.costCodeId,
                costType: line.costType,
                description: line.description,
                quantity: Number(line.quantity) || 0,
                uom: line.uom,
                unitCostCents:
                  line.unitCostDollars === ""
                    ? null
                    : Math.round(Number(line.unitCostDollars) * 100),
                elevationId:
                  line.elevationId === "base" ? null : line.elevationId,
              })),
          ),
        ),
      "Takeoff saved",
    );
  }

  function importTakeoffCsv() {
    const parsed = csvTakeoff
      .split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row, index) => {
        const [
          elevationValue = "base",
          costCodeValue = "",
          description = "",
          quantity = "0",
          uom = "ea",
          unitCost = "",
        ] = row.split(",").map((cell) => cell.trim());
        const costCode = costCodes.find(
          (code) =>
            code.id === costCodeValue ||
            code.code.toLowerCase() === costCodeValue.toLowerCase(),
        );
        const elevation = (plan.elevations ?? []).find(
          (item) =>
            item.id === elevationValue ||
            item.code.toLowerCase() === elevationValue.toLowerCase(),
        );
        if (!costCode || !description)
          throw new Error(
            `CSV row ${index + 1}: cost code and description are required`,
          );
        if (elevationValue.toLowerCase() !== "base" && !elevation)
          throw new Error(`CSV row ${index + 1}: elevation was not found`);
        return {
          costCodeId: costCode.id,
          costType: costCode.cost_type ?? null,
          description,
          quantity,
          uom: uom || "ea",
          unitCostDollars: unitCost,
          elevationId: elevation?.id ?? "base",
        } satisfies TakeoffDraft;
      });
    setTakeoff((current) => [...current, ...parsed]);
    setCsvTakeoff("");
    toast.success(
      `${parsed.length} takeoff line${parsed.length === 1 ? "" : "s"} imported`,
    );
  }

  function saveBundle() {
    if (!version) return;
    refreshTask(
      async () =>
        unwrapAction(
          await updatePlanVersionAction(plan.id, version.id, {
            label: version.label,
            notes: version.notes,
            budgetTemplateId: bundleBudget === "none" ? null : bundleBudget,
            scheduleTemplateId:
              bundleSchedule === "none" ? null : bundleSchedule,
            drawingSourceFileId: bundleDrawing || null,
            checklistTemplateIds: bundleChecks,
            selectionCategoryIds: version.selection_category_ids,
          }),
        ),
      "Bundle saved",
    );
  }

  function saveAvailability() {
    const entries = communities.flatMap((community) =>
      availabilityKeys.flatMap((elevationId) => {
        const draft =
          availabilityDraft[`${community.id}:${elevationId ?? "all"}`];
        if (!draft || (!draft.available && !draft.price)) return [];
        return [
          {
            communityId: community.id,
            housePlanId: plan.id,
            elevationId,
            isAvailable: draft.available,
            basePriceCents: Math.round((Number(draft.price) || 0) * 100),
            effectiveStart: draft.start || null,
            effectiveEnd: draft.end || null,
          },
        ];
      }),
    );
    refreshTask(
      async () =>
        unwrapAction(await setCommunityAvailabilityAction(plan.id, entries)),
      "Availability saved",
    );
  }

  function release(item: HousePlanVersionDto) {
    const failures = [
      item.takeoff_line_count === 0 && !item.budget_template_id
        ? "takeoff or budget template"
        : null,
      !item.schedule_template_id ? "schedule template" : null,
    ].filter(Boolean);
    if (failures.length > 0) {
      toast.error(`Release blocked: add ${failures.join(" and ")}`);
      return;
    }
    const summary = [
      `${item.takeoff_line_count} takeoff lines`,
      item.budget_template_id ? "budget template" : "no budget template",
      "schedule template",
      `${item.checklist_template_ids.length} checklists`,
      item.drawing_source_file_id ? "plan-set PDF" : "no plan-set PDF",
    ].join(", ");
    if (
      !window.confirm(
        `Release v${item.version_number} and snapshot ${summary}?\n\nLots started on this version keep it forever. This release cannot be edited.`,
      )
    )
      return;
    refreshTask(
      async () =>
        unwrapAction(await releasePlanVersionAction(plan.id, item.id)),
      "Version released",
    );
  }

  function uploadPlanSet(file: File | undefined) {
    if (!file) return;
    if (file.type !== "application/pdf")
      return toast.error("Choose a PDF plan set");
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("file", file);
        formData.set("category", "plans");
        formData.set("visibility", "private");
        const uploaded = unwrapAction(await uploadFileAction(formData));
        setBundleDrawing(uploaded.id);
        toast.success("Plan-set PDF uploaded; save the bundle to attach it");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Plan-set upload failed",
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{plan.code}</p>
          <h1 className="text-xl font-semibold">{plan.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span>{plan.series ?? "No series"}</span>
            <span>·</span>
            {canWrite ? (
              <Select
                value={plan.status}
                onValueChange={(status) =>
                  refreshTask(
                    async () =>
                      unwrapAction(
                        await updateHousePlanAction(plan.id, { status }),
                      ),
                    "Plan status updated",
                  )
                }
              >
                <SelectTrigger className="h-7 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="retired">Retired</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <span className="capitalize">{plan.status}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label className="sr-only">Plan version</Label>
          <Select value={version?.id} onValueChange={chooseVersion}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select version" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  v{item.version_number} · {item.status}
                  {item.label ? ` · ${item.label}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canWrite ? (
            <Button
              variant="outline"
              onClick={() =>
                refreshTask(
                  async () =>
                    unwrapAction(
                      await createPlanVersionAction(plan.id, {
                        copyFromVersionId: version?.id ?? null,
                      }),
                    ),
                  "Draft version created",
                )
              }
              disabled={pending}
            >
              <Plus className="h-4 w-4" />
              New version
            </Button>
          ) : null}
        </div>
      </div>
      <Tabs defaultValue="versions">
        <TabsList>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="takeoff">Takeoff</TabsTrigger>
          <TabsTrigger value="elevations">Elevations</TabsTrigger>
          <TabsTrigger value="bundle">Bundle</TabsTrigger>
          <TabsTrigger value="availability">Availability</TabsTrigger>
        </TabsList>
        <TabsContent value="versions" className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Released</TableHead>
                <TableHead className="text-right">Pinned lots</TableHead>
                <TableHead className="text-right">Takeoff</TableHead>
                <TableHead className="text-right">Manual total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((item) => {
                const itemDrift = drift.find(
                  (entry) => entry.version_id === item.id,
                );
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono">
                      v{item.version_number}
                    </TableCell>
                    <TableCell className="capitalize">{item.status}</TableCell>
                    <TableCell>{item.label ?? "—"}</TableCell>
                    <TableCell>
                      {item.released_at
                        ? new Date(item.released_at).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.pinned_lot_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.takeoff_line_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(item.takeoff_total_cents_manual)}
                    </TableCell>
                    <TableCell className="text-right">
                      {itemDrift ? (
                        <span className="text-xs text-muted-foreground">
                          {itemDrift.changes.length} changes ·{" "}
                          {money(itemDrift.manual_price_delta_cents)}
                        </span>
                      ) : item.status === "draft" && canRelease ? (
                        <Button
                          size="sm"
                          onClick={() => release(item)}
                          disabled={pending}
                        >
                          Release
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="takeoff" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Base lines apply to every elevation; elevation rows are deltas.
            </p>
            <div className="flex gap-2">
              <span className="self-center text-sm font-medium tabular-nums">
                {money(manualTotal)}
              </span>
              {editableVersion ? (
                <>
                  <Button variant="outline" onClick={addTakeoffLine}>
                    <Plus className="h-4 w-4" />
                    Line
                  </Button>
                  <Button onClick={saveTakeoff} disabled={pending}>
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          {editableVersion ? (
            <div className="grid gap-2 border p-3 sm:grid-cols-[1fr_auto]">
              <Textarea
                value={csvTakeoff}
                onChange={(event) => setCsvTakeoff(event.target.value)}
                placeholder="Paste CSV: elevation, cost code, description, quantity, uom, unit cost\nbase, 06100, Wall framing, 1, ls, 24500"
                className="min-h-20 font-mono text-xs"
              />
              <Button
                variant="outline"
                className="self-end"
                onClick={() => {
                  try {
                    importTakeoffCsv();
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "CSV import failed",
                    );
                  }
                }}
                disabled={!csvTakeoff.trim()}
              >
                Import CSV
              </Button>
            </div>
          ) : null}
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Elevation</TableHead>
                  <TableHead>Cost code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-24">Qty</TableHead>
                  <TableHead className="w-24">UOM</TableHead>
                  <TableHead className="w-36 text-right">Unit cost</TableHead>
                  <TableHead className="w-36 text-right">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {takeoff.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-32 text-center text-muted-foreground"
                    >
                      No takeoff lines on this version.
                    </TableCell>
                  </TableRow>
                ) : (
                  takeoff.map((line, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        <Select
                          disabled={!editableVersion}
                          value={line.elevationId}
                          onValueChange={(value) =>
                            setTakeoff((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, elevationId: value }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="base">Base</SelectItem>
                            {(plan.elevations ?? []).map((elevation) => (
                              <SelectItem
                                key={elevation.id}
                                value={elevation.id}
                              >
                                {elevation.code}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          disabled={!editableVersion}
                          value={line.costCodeId}
                          onValueChange={(value) =>
                            setTakeoff((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      costCodeId: value,
                                      costType:
                                        costCodes.find(
                                          (code) => code.id === value,
                                        )?.cost_type ?? null,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-52">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {costCodes.map((code) => (
                              <SelectItem key={code.id} value={code.id}>
                                {code.code} · {code.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          disabled={!editableVersion}
                          value={line.description}
                          onChange={(event) =>
                            setTakeoff((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, description: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          disabled={!editableVersion}
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) =>
                            setTakeoff((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, quantity: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          disabled={!editableVersion}
                          value={line.uom}
                          onChange={(event) =>
                            setTakeoff((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, uom: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          disabled={!editableVersion}
                          className="text-right tabular-nums"
                          value={line.unitCostDollars}
                          onChange={(event) =>
                            setTakeoff((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      unitCostDollars: event.target.value,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(
                          Math.round(
                            (Number(line.quantity) || 0) *
                              (Number(line.unitCostDollars) || 0) *
                              100,
                          ),
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        <TabsContent value="elevations" className="space-y-3">
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Swing</TableHead>
                  <TableHead className="text-right">
                    Heated sqft delta
                  </TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(plan.elevations ?? []).map((elevation) => (
                  <TableRow key={elevation.id}>
                    <TableCell className="font-mono">
                      {elevation.code}
                    </TableCell>
                    <TableCell>{elevation.name ?? "—"}</TableCell>
                    <TableCell>
                      {elevation.swing_applicable ? "Left / right" : "Fixed"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {elevation.heated_sqft_delta}
                    </TableCell>
                    <TableCell>
                      {elevation.is_active ? "Active" : "Inactive"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {canWrite ? (
            <div className="flex max-w-xl items-end gap-2">
              <div className="space-y-1">
                <Label>Code</Label>
                <Input
                  className="w-24"
                  value={elevationCode}
                  onChange={(event) =>
                    setElevationCode(event.target.value.toUpperCase())
                  }
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label>Name</Label>
                <Input
                  value={elevationName}
                  onChange={(event) => setElevationName(event.target.value)}
                />
              </div>
              <Button
                onClick={() =>
                  refreshTask(
                    async () =>
                      unwrapAction(
                        await upsertElevationAction(plan.id, {
                          code: elevationCode,
                          name: elevationName || null,
                          swingApplicable: true,
                          heatedSqftDelta: 0,
                          isActive: true,
                          sortOrder: (plan.elevations ?? []).length,
                        }),
                      ),
                    "Elevation added",
                  )
                }
                disabled={pending || !elevationCode}
              >
                Add elevation
              </Button>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="bundle" className="space-y-4">
          {editableVersion ? (
            <div className="grid gap-4 border p-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Budget template</Label>
                <Select
                  disabled={!editableVersion}
                  value={bundleBudget}
                  onValueChange={setBundleBudget}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {budgetTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name} · {template.line_count} lines
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Schedule template</Label>
                <Select
                  disabled={!editableVersion}
                  value={bundleSchedule}
                  onValueChange={setBundleSchedule}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {scheduleTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name} · {template.items.length} items
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Plan-set PDF</Label>
                <Input
                  type="file"
                  accept="application/pdf"
                  disabled={pending}
                  onChange={(event) => uploadPlanSet(event.target.files?.[0])}
                />
                <Input
                  readOnly
                  value={bundleDrawing}
                  placeholder="No uploaded PDF"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Checklists</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {checklistTemplates.map((template) => (
                    <label
                      key={template.id}
                      className="flex items-center gap-2 border p-2 text-sm"
                    >
                      <Checkbox
                        disabled={!editableVersion}
                        checked={bundleChecks.includes(template.id)}
                        onCheckedChange={(checked) =>
                          setBundleChecks((current) =>
                            checked
                              ? [...current, template.id]
                              : current.filter((id) => id !== template.id),
                          )
                        }
                      />
                      {template.name} · {template.item_count}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <BundleSnapshotSummary
              snapshot={version?.bundle_snapshot ?? null}
            />
          )}
          {editableVersion ? (
            <Button onClick={saveBundle} disabled={pending}>
              <Save className="h-4 w-4" />
              Save bundle
            </Button>
          ) : null}
        </TabsContent>
        <TabsContent value="availability" className="space-y-3">
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">Community</TableHead>
                  {availabilityKeys.map((elevationId) => (
                    <TableHead key={elevationId ?? "all"} className="min-w-56">
                      {elevationId === null
                        ? "All elevations"
                        : plan.elevations?.find(
                            (item) => item.id === elevationId,
                          )?.code}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {communities.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={availabilityKeys.length + 1}
                      className="h-28 text-center text-muted-foreground"
                    >
                      No communities are available.
                    </TableCell>
                  </TableRow>
                ) : (
                  communities.map((community) => (
                    <TableRow key={community.id}>
                      <TableCell>
                        <p className="font-medium">{community.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {community.divisionName ?? "Main"}
                        </p>
                      </TableCell>
                      {availabilityKeys.map((elevationId) => {
                        const key = `${community.id}:${elevationId ?? "all"}`;
                        const draft = availabilityDraft[key] ?? {
                          available: false,
                          price: "",
                          start: "",
                          end: "",
                        };
                        const patchDraft = (patch: Partial<typeof draft>) =>
                          setAvailabilityDraft((current) => ({
                            ...current,
                            [key]: { ...draft, ...patch },
                          }));
                        return (
                          <TableCell key={key}>
                            <div className="space-y-2">
                              <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                  disabled={!canWrite}
                                  checked={draft.available}
                                  onCheckedChange={(checked) =>
                                    patchDraft({ available: checked === true })
                                  }
                                />
                                Available
                              </label>
                              <Input
                                disabled={!canWrite}
                                className="h-8 text-right tabular-nums"
                                value={draft.price}
                                onChange={(event) =>
                                  patchDraft({ price: event.target.value })
                                }
                                placeholder="Base price"
                              />
                              <div className="grid grid-cols-2 gap-1">
                                <Input
                                  disabled={!canWrite}
                                  type="date"
                                  className="h-8 px-1 text-xs"
                                  value={draft.start}
                                  onChange={(event) =>
                                    patchDraft({ start: event.target.value })
                                  }
                                />
                                <Input
                                  disabled={!canWrite}
                                  type="date"
                                  className="h-8 px-1 text-xs"
                                  value={draft.end}
                                  onChange={(event) =>
                                    patchDraft({ end: event.target.value })
                                  }
                                />
                              </div>
                            </div>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {canWrite ? (
            <Button onClick={saveAvailability} disabled={pending}>
              <Save className="h-4 w-4" />
              Save availability
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

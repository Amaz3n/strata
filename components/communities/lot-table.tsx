"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Plus, Search } from "@/components/icons";
import { toast } from "sonner";

import {
  attachProjectToLotAction,
  bulkUpdateLotsAction,
  createLotRangeAction,
  createLotsAction,
  deleteLotAction,
  detachProjectFromLotAction,
  setLotStatusAction,
  updateLotAction,
} from "@/app/(app)/communities/actions";
import { CommunityStatusBadge } from "@/components/communities/community-status-badge";
import { Button } from "@/components/ui/button";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { unwrapAction } from "@/lib/action-result";
import { LOT_STATUSES, type LotStatus } from "@/lib/land/lot-lifecycle";
import type {
  CommunityPhaseDTO,
  LotTakedownDTO,
} from "@/lib/services/communities";
import type { LotDTO } from "@/lib/services/lots";

type ProjectOption = { id: string; name: string };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

type LotDraft = {
  lotNumber: string;
  block: string;
  address: string;
  phaseId: string;
  takedownId: string;
  swing: "left" | "right" | "either";
  premium: string;
  width: string;
  depth: string;
  notes: string;
};

const EMPTY_LOT_DRAFT: LotDraft = {
  lotNumber: "",
  block: "",
  address: "",
  phaseId: "none",
  takedownId: "none",
  swing: "either",
  premium: "",
  width: "",
  depth: "",
  notes: "",
};

function LotFields({
  draft,
  onChange,
  phases,
  takedowns,
}: {
  draft: LotDraft;
  onChange: (draft: LotDraft) => void;
  phases: CommunityPhaseDTO[];
  takedowns: LotTakedownDTO[];
}) {
  const patch = (value: Partial<LotDraft>) => onChange({ ...draft, ...value });
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="grid gap-1.5">
        <Label>Lot number</Label>
        <Input
          value={draft.lotNumber}
          onChange={(event) => patch({ lotNumber: event.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Block</Label>
        <Input
          value={draft.block}
          onChange={(event) => patch({ block: event.target.value })}
        />
      </div>
      <div className="col-span-2 grid gap-1.5">
        <Label>Address</Label>
        <Input
          value={draft.address}
          onChange={(event) => patch({ address: event.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Phase</Label>
        <Select
          value={draft.phaseId}
          onValueChange={(value) => patch({ phaseId: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {phases.map((phase) => (
              <SelectItem key={phase.id} value={phase.id}>
                {phase.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>Takedown</Label>
        <Select
          value={draft.takedownId}
          onValueChange={(value) => patch({ takedownId: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {takedowns.map((takedown) => (
              <SelectItem key={takedown.id} value={takedown.id}>
                {takedown.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>Swing</Label>
        <Select
          value={draft.swing}
          onValueChange={(value) =>
            patch({ swing: value as LotDraft["swing"] })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="right">Right</SelectItem>
            <SelectItem value="either">Either</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>Premium</Label>
        <Input
          inputMode="decimal"
          value={draft.premium}
          onChange={(event) => patch({ premium: event.target.value })}
          placeholder="0"
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Width (ft)</Label>
        <Input
          inputMode="decimal"
          value={draft.width}
          onChange={(event) => patch({ width: event.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Depth (ft)</Label>
        <Input
          inputMode="decimal"
          value={draft.depth}
          onChange={(event) => patch({ depth: event.target.value })}
        />
      </div>
      <div className="col-span-2 grid gap-1.5">
        <Label>Notes</Label>
        <Input
          value={draft.notes}
          onChange={(event) => patch({ notes: event.target.value })}
        />
      </div>
    </div>
  );
}

export function LotTable({
  communityId,
  lots,
  counts,
  phases,
  takedowns,
  projects,
  total,
  page,
  pageSize,
  filters,
  canWrite,
}: {
  communityId: string;
  lots: LotDTO[];
  counts: Record<LotStatus, number>;
  phases: CommunityPhaseDTO[];
  takedowns: LotTakedownDTO[];
  projects: ProjectOption[];
  total: number;
  page: number;
  pageSize: number;
  filters: { status?: string; phase?: string; q?: string };
  canWrite: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"range" | "single">("range");
  const [singleDraft, setSingleDraft] = useState<LotDraft>(EMPTY_LOT_DRAFT);
  const [editingLot, setEditingLot] = useState<LotDTO | null>(null);
  const [editDraft, setEditDraft] = useState<LotDraft>(EMPTY_LOT_DRAFT);
  const [attachLot, setAttachLot] = useState<LotDTO | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [fromNumber, setFromNumber] = useState("1");
  const [toNumber, setToNumber] = useState("1");
  const [prefix, setPrefix] = useState("");
  const [phaseId, setPhaseId] = useState("none");
  const [takedownId, setTakedownId] = useState("none");
  const [search, setSearch] = useState(filters.q ?? "");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const allPageSelected =
    lots.length > 0 && lots.every((lot) => selected.includes(lot.id));

  const baseParams = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.phase) params.set("phase", filters.phase);
    if (filters.q) params.set("q", filters.q);
    return params;
  }, [filters.phase, filters.q, filters.status]);

  function navigate(patch: Record<string, string | undefined>) {
    const params = new URLSearchParams(baseParams);
    Object.entries(patch).forEach(([key, value]) =>
      value ? params.set(key, value) : params.delete(key),
    );
    if (!("page" in patch)) params.delete("page");
    router.push(
      `/communities/${communityId}${params.size ? `?${params}` : ""}`,
    );
  }

  function createRange() {
    startTransition(async () => {
      try {
        unwrapAction(
          await createLotRangeAction(communityId, {
            fromNumber: Number(fromNumber),
            toNumber: Number(toNumber),
            prefix: prefix || undefined,
            phaseId: phaseId === "none" ? null : phaseId,
            takedownId: takedownId === "none" ? null : takedownId,
          }),
        );
        toast.success("Lots created");
        setCreateOpen(false);
        router.refresh();
      } catch (error) {
        toast.error("Unable to create lots", {
          description: (error as Error).message,
        });
      }
    });
  }

  function lotPayload(draft: LotDraft) {
    return {
      lotNumber: draft.lotNumber,
      block: draft.block || null,
      address: draft.address || null,
      phaseId: draft.phaseId === "none" ? null : draft.phaseId,
      takedownId: draft.takedownId === "none" ? null : draft.takedownId,
      swing: draft.swing,
      premiumCents: draft.premium ? Math.round(Number(draft.premium) * 100) : 0,
      dimensions: {
        widthFt: draft.width ? Number(draft.width) : undefined,
        depthFt: draft.depth ? Number(draft.depth) : undefined,
      },
      notes: draft.notes || null,
    };
  }

  function createSingle() {
    startTransition(async () => {
      try {
        unwrapAction(
          await createLotsAction(communityId, {
            lots: [{ ...lotPayload(singleDraft), status: "controlled" }],
          }),
        );
        toast.success("Lot created");
        setSingleDraft(EMPTY_LOT_DRAFT);
        setCreateOpen(false);
        router.refresh();
      } catch (error) {
        toast.error("Unable to create lot", {
          description: (error as Error).message,
        });
      }
    });
  }

  function openEdit(lot: LotDTO) {
    setEditingLot(lot);
    setEditDraft({
      lotNumber: lot.lotNumber,
      block: lot.block ?? "",
      address: lot.address ?? "",
      phaseId: lot.phaseId ?? "none",
      takedownId: lot.takedownId ?? "none",
      swing: lot.swing,
      premium: lot.premiumCents ? String(lot.premiumCents / 100) : "",
      width: lot.dimensions.widthFt ? String(lot.dimensions.widthFt) : "",
      depth: lot.dimensions.depthFt ? String(lot.dimensions.depthFt) : "",
      notes: lot.notes ?? "",
    });
  }

  function saveEdit() {
    if (!editingLot) return;
    startTransition(async () => {
      try {
        unwrapAction(
          await updateLotAction(
            editingLot.id,
            communityId,
            lotPayload(editDraft),
          ),
        );
        toast.success("Lot updated");
        setEditingLot(null);
        router.refresh();
      } catch (error) {
        toast.error("Unable to update lot", {
          description: (error as Error).message,
        });
      }
    });
  }

  function setStatus(lotIds: string[], status: LotStatus) {
    startTransition(async () => {
      try {
        if (lotIds.length === 1)
          unwrapAction(
            await setLotStatusAction(lotIds[0], communityId, {
              status,
              force: false,
            }),
          );
        else
          unwrapAction(
            await bulkUpdateLotsAction(communityId, {
              lotIds,
              patch: { status },
            }),
          );
        setSelected([]);
        toast.success(
          lotIds.length === 1
            ? "Lot status updated"
            : `${lotIds.length} lots updated`,
        );
        router.refresh();
      } catch (error) {
        toast.error("Unable to update lot status", {
          description: (error as Error).message,
        });
      }
    });
  }

  function bulkAssign(patch: {
    phaseId?: string | null;
    takedownId?: string | null;
  }) {
    startTransition(async () => {
      try {
        unwrapAction(
          await bulkUpdateLotsAction(communityId, { lotIds: selected, patch }),
        );
        setSelected([]);
        toast.success(`${selected.length} lots updated`);
        router.refresh();
      } catch (error) {
        toast.error("Unable to update lots", {
          description: (error as Error).message,
        });
      }
    });
  }

  function attach() {
    if (!attachLot || !selectedProject) return;
    startTransition(async () => {
      try {
        unwrapAction(
          await attachProjectToLotAction(
            attachLot.id,
            communityId,
            selectedProject,
          ),
        );
        toast.success("Project attached");
        setAttachLot(null);
        setSelectedProject("");
        router.refresh();
      } catch (error) {
        toast.error("Unable to attach project", {
          description: (error as Error).message,
        });
      }
    });
  }

  function remove(lot: LotDTO) {
    if (
      !window.confirm(
        `Delete lot ${lot.block ? `${lot.block}-` : ""}${lot.lotNumber}?`,
      )
    )
      return;
    startTransition(async () => {
      try {
        unwrapAction(await deleteLotAction(lot.id, communityId));
        toast.success("Lot deleted");
        router.refresh();
      } catch (error) {
        toast.error("Unable to delete lot", {
          description: (error as Error).message,
        });
      }
    });
  }

  function detach(lot: LotDTO) {
    if (
      !window.confirm(
        `Detach ${lot.projectName ?? "this project"} from lot ${lot.lotNumber}?`,
      )
    )
      return;
    startTransition(async () => {
      try {
        unwrapAction(await detachProjectFromLotAction(lot.id, communityId));
        toast.success("Project detached");
        router.refresh();
      } catch (error) {
        toast.error("Unable to detach project", {
          description: (error as Error).message,
        });
      }
    });
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filters.status ?? "all"}
            onValueChange={(value) =>
              navigate({ status: value === "all" ? undefined : value })
            }
          >
            <SelectTrigger className="h-8 w-36 rounded-none text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {LOT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status.replaceAll("_", " ")} ({counts[status]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {phases.length > 0 ? (
            <Select
              value={filters.phase ?? "all"}
              onValueChange={(value) =>
                navigate({ phase: value === "all" ? undefined : value })
              }
            >
              <SelectTrigger className="h-8 w-40 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All phases</SelectItem>
                {phases.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>
                    {phase.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <form
            className="relative"
            onSubmit={(event) => {
              event.preventDefault();
              navigate({ q: search.trim() || undefined });
            }}
          >
            <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-8 w-52 rounded-none pl-8 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Lot # or address"
            />
          </form>
        </div>
        {canWrite ? (
          <Button
            size="sm"
            className="rounded-none"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New lots
          </Button>
        ) : null}
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs">
          <span className="font-medium">{selected.length} selected</span>
          <Select
            onValueChange={(value) => setStatus(selected, value as LotStatus)}
          >
            <SelectTrigger className="h-7 w-40 rounded-none">
              <SelectValue placeholder="Set status" />
            </SelectTrigger>
            <SelectContent>
              {LOT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {phases.length > 0 ? (
            <Select
              onValueChange={(value) =>
                bulkAssign({ phaseId: value === "none" ? null : value })
              }
            >
              <SelectTrigger className="h-7 w-40 rounded-none">
                <SelectValue placeholder="Assign phase" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No phase</SelectItem>
                {phases.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>
                    {phase.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {takedowns.length > 0 ? (
            <Select
              onValueChange={(value) =>
                bulkAssign({ takedownId: value === "none" ? null : value })
              }
            >
              <SelectTrigger className="h-7 w-44 rounded-none">
                <SelectValue placeholder="Assign takedown" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No takedown</SelectItem>
                {takedowns.map((takedown) => (
                  <SelectItem key={takedown.id} value={takedown.id}>
                    {takedown.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      ) : null}

      {lots.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No lots found</p>
          <p className="text-xs text-muted-foreground">
            Add a range of lots or adjust the current filters.
          </p>
          {canWrite ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 rounded-none"
              onClick={() => setCreateOpen(true)}
            >
              Add lots
            </Button>
          ) : null}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide">
              <TableHead className="w-9">
                {canWrite ? (
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={(checked) =>
                      setSelected(checked ? lots.map((lot) => lot.id) : [])
                    }
                  />
                ) : null}
              </TableHead>
              <TableHead>Lot</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Dimensions</TableHead>
              <TableHead>Swing</TableHead>
              <TableHead className="text-right">Premium</TableHead>
              <TableHead>Takedown</TableHead>
              <TableHead>Project</TableHead>
              {canWrite ? (
                <TableHead className="text-right">Actions</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lots.map((lot) => (
              <TableRow key={lot.id} className="text-xs">
                <TableCell>
                  {canWrite ? (
                    <Checkbox
                      checked={selected.includes(lot.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, lot.id]
                            : current.filter((id) => id !== lot.id),
                        )
                      }
                    />
                  ) : null}
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {lot.block ? `${lot.block}-` : ""}
                  {lot.lotNumber}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lot.phaseName ?? "—"}
                </TableCell>
                <TableCell>
                  {canWrite ? (
                    <Select
                      value={lot.status}
                      onValueChange={(value) =>
                        setStatus([lot.id], value as LotStatus)
                      }
                    >
                      <SelectTrigger className="h-7 w-28 rounded-none border-0 px-0 shadow-none">
                        <CommunityStatusBadge status={lot.status} />
                      </SelectTrigger>
                      <SelectContent>
                        {LOT_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {status.replaceAll("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <CommunityStatusBadge status={lot.status} />
                  )}
                </TableCell>
                <TableCell className="max-w-52 truncate text-muted-foreground">
                  {lot.address ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {lot.dimensions.widthFt && lot.dimensions.depthFt
                    ? `${lot.dimensions.widthFt}×${lot.dimensions.depthFt} ft`
                    : "—"}
                </TableCell>
                <TableCell className="capitalize text-muted-foreground">
                  {lot.swing}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {lot.premiumCents ? money(lot.premiumCents) : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lot.takedownName ?? "—"}
                </TableCell>
                <TableCell>
                  {lot.projectId ? (
                    <Link
                      className="font-medium hover:underline"
                      href={`/projects/${lot.projectId}`}
                    >
                      {lot.projectName ?? "Open project"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                {canWrite ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(lot)}
                      >
                        Edit
                      </Button>
                      {!lot.projectId ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAttachLot(lot)}
                        >
                          Attach
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => detach(lot)}
                        >
                          Detach
                        </Button>
                      )}
                      {!lot.projectId &&
                      ["controlled", "owned", "developed"].includes(
                        lot.status,
                      ) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => remove(lot)}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {total > pageSize ? (
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total} lots · Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => navigate({ page: String(page - 1) })}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => navigate({ page: String(page + 1) })}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add lots</DialogTitle>
            <DialogDescription>
              Add one detailed lot or create a numbered range of up to 500.
            </DialogDescription>
          </DialogHeader>
          <div className="flex border-b text-xs">
            <button
              type="button"
              className={`px-3 py-2 ${createMode === "range" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
              onClick={() => setCreateMode("range")}
            >
              Range
            </button>
            <button
              type="button"
              className={`px-3 py-2 ${createMode === "single" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
              onClick={() => setCreateMode("single")}
            >
              Single
            </button>
          </div>
          {createMode === "range" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>From</Label>
                <Input
                  type="number"
                  min={0}
                  value={fromNumber}
                  onChange={(event) => setFromNumber(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>To</Label>
                <Input
                  type="number"
                  min={0}
                  value={toNumber}
                  onChange={(event) => setToNumber(event.target.value)}
                />
              </div>
              <div className="col-span-2 grid gap-1.5">
                <Label>Prefix</Label>
                <Input
                  value={prefix}
                  onChange={(event) => setPrefix(event.target.value)}
                  placeholder="Optional, e.g. A-"
                />
              </div>
              {phases.length > 0 ? (
                <div className="grid gap-1.5">
                  <Label>Phase</Label>
                  <Select value={phaseId} onValueChange={setPhaseId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {phases.map((phase) => (
                        <SelectItem key={phase.id} value={phase.id}>
                          {phase.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {takedowns.length > 0 ? (
                <div className="grid gap-1.5">
                  <Label>Takedown</Label>
                  <Select value={takedownId} onValueChange={setTakedownId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {takedowns
                        .filter((takedown) => takedown.status === "scheduled")
                        .map((takedown) => (
                          <SelectItem key={takedown.id} value={takedown.id}>
                            {takedown.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : (
            <LotFields
              draft={singleDraft}
              onChange={setSingleDraft}
              phases={phases}
              takedowns={takedowns}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            {createMode === "range" ? (
              <Button
                disabled={isPending || !fromNumber || !toNumber}
                onClick={createRange}
              >
                {isPending
                  ? "Creating…"
                  : `Create ${Math.max(0, Number(toNumber) - Number(fromNumber) + 1)} lots`}
              </Button>
            ) : (
              <Button
                disabled={isPending || !singleDraft.lotNumber.trim()}
                onClick={createSingle}
              >
                {isPending ? "Creating…" : "Create lot"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet
        open={Boolean(editingLot)}
        onOpenChange={(open) => {
          if (!open) setEditingLot(null);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Edit lot {editingLot?.lotNumber}</SheetTitle>
            <SheetDescription>
              Update the land record. Status changes remain separately audited
              from the table.
            </SheetDescription>
          </SheetHeader>
          <div className="py-6">
            <LotFields
              draft={editDraft}
              onChange={setEditDraft}
              phases={phases}
              takedowns={takedowns}
            />
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setEditingLot(null)}>
              Cancel
            </Button>
            <Button
              disabled={isPending || !editDraft.lotNumber.trim()}
              onClick={saveEdit}
            >
              {isPending ? "Saving…" : "Save changes"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <Dialog
        open={Boolean(attachLot)}
        onOpenChange={(open) => {
          if (!open) setAttachLot(null);
        }}
      >
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Attach project</DialogTitle>
            <DialogDescription>
              Link an existing project to lot {attachLot?.lotNumber}. The
              project posture will become Production.
            </DialogDescription>
          </DialogHeader>
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttachLot(null)}>
              Cancel
            </Button>
            <Button disabled={!selectedProject || isPending} onClick={attach}>
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { createHousePlanAction } from "@/app/(app)/plans/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { unwrapAction } from "@/lib/action-result";
import type { DivisionDTO } from "@/lib/services/divisions";
import type { HousePlanDto } from "@/lib/services/house-plans";
import type { CommunityListItemDTO } from "@/lib/services/communities";

export function PlanLibraryClient({
  plans,
  divisions,
  communities,
  canWrite,
}: {
  plans: HousePlanDto[];
  divisions: DivisionDTO[];
  communities: CommunityListItemDTO[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [seriesFilter, setSeriesFilter] = useState("all");
  const [divisionFilter, setDivisionFilter] = useState("all");
  const [communityFilter, setCommunityFilter] = useState("all");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [series, setSeries] = useState("");
  const [divisionId, setDivisionId] = useState("none");
  const filtered = useMemo(
    () =>
      plans.filter((plan) => {
        const haystack =
          `${plan.code} ${plan.name} ${plan.series ?? ""}`.toLowerCase();
        return (
          haystack.includes(query.toLowerCase()) &&
          (status === "all" || plan.status === status) &&
          (seriesFilter === "all" || plan.series === seriesFilter) &&
          (divisionFilter === "all" || plan.division_id === divisionFilter) &&
          (communityFilter === "all" ||
            plan.community_ids.includes(communityFilter))
        );
      }),
    [plans, query, status, seriesFilter, divisionFilter, communityFilter],
  );
  const seriesOptions = useMemo(
    () =>
      Array.from(
        new Set(
          plans
            .map((plan) => plan.series)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort(),
    [plans],
  );

  function create() {
    startTransition(async () => {
      try {
        const plan = unwrapAction(
          await createHousePlanAction({
            code,
            name,
            series: series || null,
            divisionId: divisionId === "none" ? null : divisionId,
            status: "draft",
          }),
        );
        toast.success("Plan created");
        setOpen(false);
        router.push(`/plans/${plan.id}`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not create plan",
        );
      }
    });
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background p-4 sm:flex-row sm:items-center">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search code, name, or series"
          className="sm:max-w-sm"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="retired">Retired</SelectItem>
          </SelectContent>
        </Select>
        <Select value={seriesFilter} onValueChange={setSeriesFilter}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All series</SelectItem>
            {seriesOptions.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={divisionFilter} onValueChange={setDivisionFilter}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All divisions</SelectItem>
            {divisions.map((division) => (
              <SelectItem key={division.id} value={division.id}>
                {division.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={communityFilter} onValueChange={setCommunityFilter}>
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All communities</SelectItem>
            {communities.map((community) => (
              <SelectItem key={community.id} value={community.id}>
                {community.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canWrite ? (
          <Button className="sm:ml-auto" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            New plan
          </Button>
        ) : null}
      </div>
      {filtered.length === 0 ? (
        <div className="p-12 text-center">
          <p className="font-medium">No plans yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first plan or adjust the filters.
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Series</TableHead>
              <TableHead className="text-right">Sq Ft</TableHead>
              <TableHead>Beds / Baths</TableHead>
              <TableHead className="text-right">Elevations</TableHead>
              <TableHead className="text-right">Released</TableHead>
              <TableHead className="text-right">Active lots</TableHead>
              <TableHead className="text-right">Communities</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((plan) => (
              <TableRow key={plan.id} className="h-12">
                <TableCell className="font-mono text-xs">
                  <Link
                    className="font-medium text-foreground hover:underline"
                    href={`/plans/${plan.id}`}
                  >
                    {plan.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link className="hover:underline" href={`/plans/${plan.id}`}>
                    {plan.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {plan.series ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {plan.heated_sqft?.toLocaleString() ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {plan.beds ?? "—"} / {plan.baths ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {plan.elevation_count}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {plan.current_released_version
                    ? `v${plan.current_released_version}`
                    : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {plan.active_lot_count}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {plan.community_count}
                </TableCell>
                <TableCell className="capitalize">{plan.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create house plan</DialogTitle>
            <DialogDescription>
              This creates the catalog record and a version 1 draft.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="1670"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Magnolia"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Series</Label>
              <Input
                value={series}
                onChange={(event) => setSeries(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Division</Label>
              <Select value={divisionId} onValueChange={setDivisionId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Org-wide</SelectItem>
                  {divisions.map((division) => (
                    <SelectItem key={division.id} value={division.id}>
                      {division.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={create}
              disabled={pending || !code.trim() || !name.trim()}
            >
              {pending ? "Creating…" : "Create plan"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

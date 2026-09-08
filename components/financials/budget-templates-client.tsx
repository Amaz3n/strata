"use client";

import { PresetTemplateWorkspace } from "@/components/settings/preset-template-workspace";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  archiveBudgetTemplateAction,
  createBudgetTemplateAction,
  updateBudgetTemplateAction,
} from "@/app/(app)/settings/templates/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Edit, FileText, Plus, Trash2 } from "@/components/icons";
import { unwrapAction } from "@/lib/action-result";
import { COST_TYPES, COST_TYPE_LABELS, type CostType } from "@/lib/cost-types";
import type { BudgetTemplateDto } from "@/lib/services/budget-templates";
import type { CostCode } from "@/lib/types";

type LineDraft = {
  costCodeId: string | null;
  costType: CostType | null;
  description: string;
  basis: "amount" | "quantity";
  amount: string;
  quantity: string;
  uom: string;
  unitCost: string;
};

const newLine = (): LineDraft => ({
  costCodeId: null,
  costType: null,
  description: "",
  basis: "amount",
  amount: "",
  quantity: "1",
  uom: "ea",
  unitCost: "",
});

const dollars = (value: number | null) =>
  value == null ? "" : (value / 100).toFixed(2);
const cents = (value: string) => Math.round((Number(value) || 0) * 100);
const money = (value: number) =>
  (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function toDrafts(template: BudgetTemplateDto): LineDraft[] {
  return (template.lines ?? []).map((line) => ({
    costCodeId: line.cost_code_id,
    costType: line.cost_type,
    description: line.description,
    basis: line.amount_cents == null ? "quantity" : "amount",
    amount: dollars(line.amount_cents),
    quantity: line.quantity?.toString() ?? "1",
    uom: line.uom ?? "ea",
    unitCost: dollars(line.unit_cost_cents),
  }));
}

export function BudgetTemplatesClient({
  initialTemplates,
  costCodes,
}: {
  initialTemplates: BudgetTemplateDto[];
  costCodes: CostCode[];
}) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [pending, startTransition] = useTransition();

  const startCreate = () => {
    setEditingId("new");
    setName("");
    setDescription("");
    setPropertyType("");
    setLines([newLine()]);
  };

  const startEdit = (template: BudgetTemplateDto) => {
    setEditingId(template.id);
    setName(template.name);
    setDescription(template.description ?? "");
    setPropertyType(template.property_type ?? "");
    setLines(toDrafts(template).length > 0 ? toDrafts(template) : [newLine()]);
  };

  const patchLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...patch } : line,
      ),
    );
  };

  const totalCents = lines.reduce(
    (sum, line) =>
      sum +
      (line.basis === "amount"
        ? cents(line.amount)
        : Math.round((Number(line.quantity) || 0) * cents(line.unitCost))),
    0,
  );

  const save = () => {
    if (!name.trim()) return toast.error("Template name is required.");
    const populated = lines.filter((line) => line.description.trim());
    if (populated.length === 0) return toast.error("Add at least one line.");
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      propertyType: propertyType.trim() || null,
      lines: populated.map((line) => ({
        costCodeId: line.costCodeId,
        costType: line.costType,
        description: line.description.trim(),
        amountCents: line.basis === "amount" ? cents(line.amount) : null,
        quantity: line.basis === "quantity" ? Number(line.quantity) || 0 : null,
        uom: line.basis === "quantity" ? line.uom.trim() || "ea" : null,
        unitCostCents: line.basis === "quantity" ? cents(line.unitCost) : null,
      })),
    };
    startTransition(async () => {
      try {
        const saved =
          editingId === "new"
            ? unwrapAction(await createBudgetTemplateAction(payload))
            : unwrapAction(
                await updateBudgetTemplateAction(editingId as string, payload),
              );
        setTemplates((current) =>
          [...current.filter((item) => item.id !== saved.id), saved].sort(
            (a, b) => a.name.localeCompare(b.name),
          ),
        );
        setEditingId(null);
        toast.success(
          editingId === "new"
            ? "Budget template created"
            : "Budget template saved",
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to save template",
        );
      }
    });
  };

  const archive = (template: BudgetTemplateDto) => {
    if (
      !window.confirm(
        `Archive “${template.name}”? Existing project budgets are unchanged.`,
      )
    )
      return;
    startTransition(async () => {
      try {
        unwrapAction(await archiveBudgetTemplateAction(template.id));
        setTemplates((current) =>
          current.filter((item) => item.id !== template.id),
        );
        if (editingId === template.id) setEditingId(null);
        toast.success("Budget template archived");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to archive template",
        );
      }
    });
  };

  return (
    <div className="space-y-4">
      {editingId ? (
        <PresetTemplateWorkspace
          kind="Budget"
          name={name}
          description={[description, propertyType].filter(Boolean).join(" · ")}
          rows={lines
            .filter((l) => l.description.trim() || l.costCodeId)
            .map((l) => ({
              label:
                l.description ||
                costCodes.find((c) => c.id === l.costCodeId)?.name ||
                "Budget line",
              detail:
                l.basis === "quantity"
                  ? `${l.quantity} ${l.uom} × ${money(cents(l.unitCost))}`
                  : "Fixed amount",
              value: money(
                l.basis === "quantity"
                  ? Math.round((Number(l.quantity) || 0) * cents(l.unitCost))
                  : cents(l.amount),
              ),
            }))}
          total={`Resolved total ${money(totalCents)}`}
          onClose={() => setEditingId(null)}
          onSave={save}
          busy={pending}
        >
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  aria-label="Template name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Standard production budget"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Property type</Label>
                <Input
                  aria-label="Property type"
                  value={propertyType}
                  onChange={(event) => setPropertyType(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label>Description</Label>
                <Textarea
                  aria-label="Template description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-3">
              {lines.map((line, index) => (
                <div
                  key={index}
                  className="grid grid-cols-2 gap-3 border bg-muted/10 p-4"
                >
                  <label className="col-span-2 space-y-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Description
                    </span>
                    <Input
                      aria-label={`Description ${index + 1}`}
                      value={line.description}
                      onChange={(event) =>
                        patchLine(index, {
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Cost code
                    </span>
                    <Select
                      value={line.costCodeId ?? "none"}
                      onValueChange={(value) =>
                        patchLine(index, {
                          costCodeId: value === "none" ? null : value,
                        })
                      }
                    >
                      <SelectTrigger aria-label={`Cost code ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Uncoded</SelectItem>
                        {costCodes.map((code) => (
                          <SelectItem key={code.id} value={code.id}>
                            {code.code} · {code.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Cost type
                    </span>
                    <Select
                      value={line.costType ?? "none"}
                      onValueChange={(value) =>
                        patchLine(index, {
                          costType:
                            value === "none" ? null : (value as CostType),
                        })
                      }
                    >
                      <SelectTrigger aria-label={`Cost type ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unspecified</SelectItem>
                        {COST_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {COST_TYPE_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Basis
                    </span>
                    <Select
                      value={line.basis}
                      onValueChange={(value) =>
                        patchLine(index, {
                          basis: value as LineDraft["basis"],
                        })
                      }
                    >
                      <SelectTrigger aria-label={`Basis ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="amount">Amount</SelectItem>
                        <SelectItem value="quantity">Qty × unit</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Amount / Quantity
                    </span>
                    <Input
                      aria-label={`Amount / Quantity ${index + 1}`}
                      className="text-right tabular-nums"
                      inputMode="decimal"
                      value={
                        line.basis === "amount" ? line.amount : line.quantity
                      }
                      onChange={(event) =>
                        patchLine(
                          index,
                          line.basis === "amount"
                            ? { amount: event.target.value }
                            : { quantity: event.target.value },
                        )
                      }
                    />
                  </label>
                  {line.basis === "quantity" && (
                    <label className="space-y-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Unit
                      </span>
                      <Input
                        aria-label={`Unit ${index + 1}`}
                        value={line.uom}
                        onChange={(event) =>
                          patchLine(index, { uom: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {line.basis === "quantity" && (
                    <label className="space-y-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Unit cost
                      </span>
                      <Input
                        aria-label={`Unit cost ${index + 1}`}
                        className="text-right tabular-nums"
                        inputMode="decimal"
                        value={line.unitCost}
                        onChange={(event) =>
                          patchLine(index, { unitCost: event.target.value })
                        }
                      />
                    </label>
                  )}
                  <div className="col-span-2 flex justify-end">
                    <Button
                      aria-label={`Remove budget line ${index + 1}`}
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setLines((current) =>
                          current.length === 1
                            ? current
                            : current.filter(
                                (_, lineIndex) => lineIndex !== index,
                              ),
                        )
                      }
                      disabled={lines.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                onClick={() => setLines((current) => [...current, newLine()])}
              >
                <Plus className="h-4 w-4" />
                Add line
              </Button>
              <span className="font-semibold tabular-nums">
                Resolved total {money(totalCents)}
              </span>
            </div>
          </div>
        </PresetTemplateWorkspace>
      ) : (
        <Button onClick={startCreate}>
          <Plus className="h-4 w-4" />
          New budget template
        </Button>
      )}

      {templates.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center border border-dashed text-center">
          <FileText className="mb-2 h-7 w-7 text-muted-foreground" />
          <p className="font-medium">No budget templates yet</p>
          <p className="text-sm text-muted-foreground">
            Create a reusable line set or save one from a project budget.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Property type</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Resolved total</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <p className="font-medium">{template.name}</p>
                    {template.description ? (
                      <p className="text-xs text-muted-foreground">
                        {template.description}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>{template.property_type ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {template.line_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(template.total_cents)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startEdit(template)}
                    >
                      <Edit className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => archive(template)}
                      disabled={pending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

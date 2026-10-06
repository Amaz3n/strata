"use client";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReportSelect, ReportOption } from "./report-select";
import type { ReportColumn } from "@/lib/reports/types";
import type { TableLayout } from "@/lib/reports/builder";
export function ReportFilters({
  columns,
  filters,
  onChange,
}: {
  columns: ReportColumn[];
  filters: TableLayout["filters"];
  onChange: (filters: TableLayout["filters"]) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">Filters</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={filters.length >= 12 || !columns.length}
          onClick={() =>
            onChange([
              ...filters,
              { column: columns[0].key, operator: "contains", value: "" },
            ])
          }
        >
          <Plus className="size-3" />
          Add filter
        </Button>
      </div>
      {filters.length > 1 && (
        <p className="text-xs text-muted-foreground">Match all filters</p>
      )}
      {filters.map((filter, index) => {
        const column = columns.find((c) => c.key === filter.column);
        const numeric = ["number", "money", "percent"].includes(
          column?.type ?? "",
        );
        const patch = (update: Partial<typeof filter>) =>
          onChange(
            filters.map((f, i) => (i === index ? { ...f, ...update } : f)),
          );
        return (
          <div key={index} className="space-y-2 rounded border p-2">
            <div className="flex gap-1">
              <ReportSelect
                aria-label={`Filter ${index + 1} column`}
                className="w-full text-xs"
                value={filter.column}
                onValueChange={(column) =>
                  patch({
                    column,
                    operator: ["money", "number", "percent"].includes(
                      columns.find((c) => c.key === column)?.type ?? "",
                    )
                      ? "equals"
                      : "contains",
                    value: "",
                  })
                }
              >
                {columns.map((c) => (
                  <ReportOption key={c.key} value={c.key}>
                    {c.header}
                  </ReportOption>
                ))}
              </ReportSelect>
              <Button
                aria-label={`Remove filter ${index + 1}`}
                size="icon"
                variant="ghost"
                onClick={() => onChange(filters.filter((_, i) => i !== index))}
              >
                <X className="size-3" />
              </Button>
            </div>
            <ReportSelect
              aria-label={`Filter ${index + 1} condition`}
              className="w-full text-xs"
              value={filter.operator}
              onValueChange={(operator) =>
                patch({ operator: operator as typeof filter.operator })
              }
            >
              <ReportOption value="contains">Contains</ReportOption>
              <ReportOption value="equals">Equals</ReportOption>
              <ReportOption value="not_equals">Does not equal</ReportOption>
              {numeric && (
                <>
                  <ReportOption value="gt">Greater than</ReportOption>
                  <ReportOption value="lt">Less than</ReportOption>
                </>
              )}
            </ReportSelect>
            <Input
              aria-label={`Filter ${index + 1} value`}
              placeholder={
                column?.type === "money" ? "Amount in dollars" : "Value"
              }
              value={filter.value}
              onChange={(e) => patch({ value: e.target.value })}
              className="h-8 text-xs"
            />
          </div>
        );
      })}
    </div>
  );
}

import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PricingScopeRow } from "../../../components/precon/pricing-scope-row";
import { EstimateHandoff } from "../../../components/drawings/workspace/estimate-handoff";
import { MeasurementContextBar } from "../../../components/drawings/measurement-context-bar";
import {
  pricingRowSchema,
  EMPTY_PRICING_WORKSHEET,
} from "../../../lib/precon/pricing-worksheet";
import type { ConditionRollup } from "../../../lib/services/takeoff";
const prospectId = "10000000-0000-4000-8000-000000000001";
const conditionId = "10000000-0000-4000-8000-000000000002";
const rowId = "10000000-0000-4000-8000-000000000003";
function Harness() {
  const [row, setRow] = useState(
    pricingRowSchema.parse({
      id: rowId,
      description: "LVP flooring",
      unit: "sf",
      quantity: 100,
      unit_cost_cents: 650,
    }),
  );
  const [open, setOpen] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [next, setNext] = useState(1240);
  const context = {
    destination: "pricing_worksheet" as const,
    targetId: prospectId,
    label: "Smith residence · Working estimate",
    rowId,
    rowLabel: row.description,
    conditionId,
    returnHref: "/estimate",
  };
  const rollup = {
    condition: {
      id: conditionId,
      name: row.description,
      uom: "sf",
      waste_pct: 10,
    },
    effective_quantity: next,
    measured_quantity: next / 1.1,
    markup_count: 5,
    sheets: [
      {
        drawing_sheet_id: "sheet",
        sheet_number: "A-2.1",
        quantity: next / 1.1,
      },
    ],
    pending_review_count: 0,
    unscaled_markup_count: 0,
  } as ConditionRollup;
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex justify-between border-b px-6 py-5">
        <div>
          <p className="text-xs text-muted-foreground">Smith residence</p>
          <h1 className="text-xl font-semibold">Working estimate</h1>
        </div>
        <button
          onClick={() => document.documentElement.classList.toggle("dark")}
        >
          Toggle theme
        </button>
      </header>
      {measuring && (
        <>
          <MeasurementContextBar context={context} />
          <div className="m-6 rounded-md border bg-muted p-6">
            <p className="text-lg font-medium">
              Five rooms reviewed · {next.toLocaleString()} SF
            </p>
            <p className="my-2 text-sm text-muted-foreground">
              Net floor area and 10% material waste. Apply to the existing
              flooring scope.
            </p>
            <button
              className="rounded bg-primary px-4 py-2 text-primary-foreground"
              onClick={() => setOpen(true)}
            >
              Use reviewed quantity
            </button>
          </div>
        </>
      )}
      <table className="w-full">
        <tbody>
          <PricingScopeRow
            row={row}
            status={{ kind: "priced", firmness: "guess", cost: Math.round(row.quantity * (row.unit_cost_cents ?? 0)) }}
            measurementsLoaded
            inspecting={false}
            onQuoteIntent={() => {}}
            worksheet={{ ...EMPTY_PRICING_WORKSHEET, rows: [row] }}
            packages={[]}
            costCodes={[]}
            editable
            selected={false}
            onSelect={() => {}}
            onChange={(patch) => setRow({ ...row, ...patch })}
            onRemove={() => {}}
            onMove={() => {}}
            onQuotes={() => {}}
            onUnlink={() => {}}
            prospectId={prospectId}
            onMeasure={() => setMeasuring(true)}
            measurement={rollup}
          />
        </tbody>
      </table>
      <button className="m-6 border p-2" onClick={() => setNext(1310)}>
        Simulate revised plans
      </button>
      {open && (
        <EstimateHandoff
          open
          projectId="10000000-0000-4000-8000-000000000004"
          housePlanVersionId={null}
          prospectId={prospectId}
          measurementContext={context}
          rollups={[rollup]}
          onOpenChange={setOpen}
          onReviewRevision={() => {}}
          onSent={() => {
            setOpen(false);
            setMeasuring(false);
            setRow({
              ...row,
              quantity: next,
              metadata: {
                takeoff: {
                  condition_id: conditionId,
                  measured_quantity: next,
                  uom: "sf",
                  net_quantity: next / 1.1,
                  waste_pct: 10,
                  synced_at: new Date().toISOString(),
                },
              },
            });
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);

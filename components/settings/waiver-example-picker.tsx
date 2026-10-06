"use client";
import { useRef, useState } from "react";
import {
  listWaiverExampleInvoices,
  getWaiverTemplateExample,
} from "@/app/(app)/settings/templates/waiver-actions";
export type WaiverExample = Awaited<
  ReturnType<typeof getWaiverTemplateExample>
>;
export function WaiverExamplePicker({
  projects,
  onChange,
}: {
  projects: { id: string; name: string }[];
  onChange: (value: WaiverExample | undefined) => void;
}) {
  const [project, setProject] = useState(""),
    [invoice, setInvoice] = useState(""),
    [invoices, setInvoices] = useState<{ id: string; label: string }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0);
  return (
    <div className="space-y-2 border-b px-4 py-3">
      <div className="flex flex-wrap gap-2">
        <select
          className="h-9 min-w-0 flex-1 border bg-background px-2 text-xs"
          aria-label="Example project"
          value={project}
          onChange={async (e) => {
            const id = e.target.value;
            const request = ++sequence.current;
            setProject(id);
            setInvoice("");
            setInvoices([]);
            setError("");
            onChange(undefined);
            setBusy(!!id);
            if (!id) return;
            try {
              const rows = await listWaiverExampleInvoices(id);
              if (request === sequence.current) setInvoices(rows);
            } catch (e) {
              if (request === sequence.current)
                setError(
                  e instanceof Error ? e.message : "Could not load invoices",
                );
            } finally {
              if (request === sequence.current) setBusy(false);
            }
          }}
        >
          <option value="">Illustrative example</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {project && (
          <select
            className="h-9 min-w-0 flex-1 border bg-background px-2 text-xs"
            aria-label="Example invoice"
            value={invoice}
            disabled={busy || !invoices.length}
            onChange={async (e) => {
              const id = e.target.value;
              const request = ++sequence.current;
              setInvoice(id);
              setError("");
              onChange(undefined);
              setBusy(!!id);
              if (!id) return;
              try {
                const example = await getWaiverTemplateExample(id);
                if (request === sequence.current) onChange(example);
              } catch (e) {
                if (request === sequence.current)
                  setError(
                    e instanceof Error ? e.message : "Could not load example",
                  );
              } finally {
                if (request === sequence.current) setBusy(false);
              }
            }}
          >
            <option value="">
              {busy
                ? "Loading…"
                : invoices.length
                  ? "Choose an invoice"
                  : "No invoices in this project"}
            </option>
            {invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading example…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        {invoice && !busy && !error
          ? "Uses invoice details with its total as the example waiver amount. Unknown answers remain marked. Nothing is sent or saved to the invoice."
          : "Choose an invoice to check familiar details, or use the illustrative example."}
      </p>
    </div>
  );
}

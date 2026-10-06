"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createAccountantPackageAction } from "@/app/(app)/books/actions";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AccountantHandoff({ asOf, canExport, canTax }: { asOf: string; canExport: boolean; canTax: boolean }) {
  const router = useRouter();
  const [year, setYear] = useState(asOf.slice(0, 4));
  const [pending, startTransition] = useTransition();
  if (!canExport && !canTax) return null;
  return (
    <section className="border bg-background p-5">
      <h2 className="text-sm font-semibold">Accountant handoff</h2>
      {canExport ? <>
        <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">Prepare a complete books export with a 1099 readiness summary for the selected year. The ledger export includes all dates.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="package-year" className="text-xs">Tax year</label>
            <Select value={year} onValueChange={setYear} disabled={pending}>
              <SelectTrigger id="package-year" className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>{Array.from({ length: 10 }, (_, index) => String(Number(asOf.slice(0, 4)) - index)).map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button variant="outline" disabled={pending} onClick={() => startTransition(async () => {
            const result = await createAccountantPackageAction({ taxYear: Number(year) });
            if (!result.success) { toast.error(result.error); return; }
            toast.success("Accountant package ready");
            router.refresh();
          })}>{pending ? "Preparing…" : "Prepare accountant package"}</Button>
        </div>
      </> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {canTax ? <>
          <Button asChild variant="ghost" size="sm"><Link href="/books/taxes">Tax filing records</Link></Button>
          <Button asChild variant="ghost" size="sm"><Link href="/reports?collection=tax">Tax reports</Link></Button>
        </> : null}
      </div>
    </section>
  );
}

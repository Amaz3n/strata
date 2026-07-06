import type { VendorBillSummary } from "@/lib/services/vendor-bills";

export function isBillOverdue(bill: VendorBillSummary): boolean {
  if ((bill.status ?? "").toLowerCase() === "paid" || !bill.due_date) return false;
  const paid = bill.paid_cents ?? 0;
  if ((bill.total_cents ?? 0) - paid <= 0) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${bill.due_date}T00:00:00`) < today;
}

/** A bill reads as "Overdue" when unpaid past its due date, else its status. */
export function payableStatusMeta(bill: VendorBillSummary): {
  label: string;
  className: string;
} {
  if (isBillOverdue(bill)) {
    return { label: "Overdue", className: "border-destructive/40 text-destructive" };
  }
  const status = (bill.status ?? "pending").toLowerCase();
  if (status === "paid") {
    return { label: "Paid", className: "border-success/40 text-success" };
  }
  if (status === "partial") {
    return { label: "Partial", className: "border-warning/40 text-warning" };
  }
  if (status === "approved") {
    return { label: "Approved", className: "border-primary/30 text-primary" };
  }
  return { label: "Pending", className: "border-border text-muted-foreground" };
}

"use client";
import {
  submitNativeInvoiceIncomeRecovery,
  type NativeInvoiceIncomeRecovery,
} from "./native-invoice-income-recovery";
import type { NativeInvoiceRecoveryScope } from "./native-invoice-recovery";
import { NATIVE_INVOICE_RECOVERY_EVENT } from "./native-invoice-recovery-client";
import {
  selectBooksNativeInvoiceIncomeAction,
  resolveBooksNativeInvoiceIncomeAction,
} from "@/app/(app)/books/actions";
function notify(scope: NativeInvoiceRecoveryScope) {
  window.dispatchEvent(
    new CustomEvent(NATIVE_INVOICE_RECOVERY_EVENT, {
      detail: { invoiceId: scope.invoiceId },
    }),
  );
}
export async function executeNativeInvoiceIncomeRecovery(
  scope: NativeInvoiceRecoveryScope,
  record: NativeInvoiceIncomeRecovery,
  decision?: { id: string; reason: string },
) {
  try {
    return await submitNativeInvoiceIncomeRecovery({
      storage: window.localStorage,
      locks: navigator.locks,
      scope,
      record,
      decision,
      onSaved: () => notify(scope),
      transport: (r) => {
        if (r.resolution)
          return resolveBooksNativeInvoiceIncomeAction({
            id: r.resolution.id,
            reason: r.resolution.reason,
            request: r.request,
          });
        return selectBooksNativeInvoiceIncomeAction(r.request);
      },
    });
  } finally {
    notify(scope);
  }
}

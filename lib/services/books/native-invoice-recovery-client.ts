"use client";
import {
  submitNativeInvoiceRecovery,
  resolveNativeInvoiceRecovery,
  type NativeInvoiceRecovery,
  type NativeInvoiceRecoveryScope,
} from "./native-invoice-recovery";
import {
  postBooksNativeProjectInvoiceAction,
  resolveBooksNativeProjectInvoiceRequestAction,
} from "@/app/(app)/books/actions";
export const NATIVE_INVOICE_RECOVERY_EVENT = "arc:native-invoice-recovery";
function notify(scope: NativeInvoiceRecoveryScope) {
  window.dispatchEvent(
    new CustomEvent(NATIVE_INVOICE_RECOVERY_EVENT, {
      detail: { invoiceId: scope.invoiceId },
    }),
  );
}
export async function executeNativeInvoiceRecovery(
  scope: NativeInvoiceRecoveryScope,
  record: NativeInvoiceRecovery,
) {
  try {
    return await submitNativeInvoiceRecovery({
      storage: window.localStorage,
      locks: navigator.locks,
      scope,
      record,
      onSaved: () => notify(scope),
      transport: (r) => postBooksNativeProjectInvoiceAction(r.request),
    });
  } finally {
    notify(scope);
  }
}
export async function resolveSavedNativeInvoiceRecovery(
  scope: NativeInvoiceRecoveryScope,
  record: NativeInvoiceRecovery,
  decision: { id: string; reason: string },
) {
  try {
    return await resolveNativeInvoiceRecovery({
      storage: window.localStorage,
      locks: navigator.locks,
      scope,
      record,
      decision,
      onSaved: () => notify(scope),
      transport: (r) => {
        if (!r.resolution)
          throw Error("Saved invoice resolution decision is required");
        return resolveBooksNativeProjectInvoiceRequestAction({
          id: r.resolution.id,
          request: r.request,
          reason: r.resolution.reason,
        });
      },
    });
  } finally {
    notify(scope);
  }
}

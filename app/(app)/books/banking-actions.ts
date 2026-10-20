"use server";
import { actionError } from "@/lib/action-result";
import {
  loadBankingTransactions,
  loadBankingOptions,
  mutateBankingTransaction,
  loadBankingDetail,
  uploadBankingReceipt,
  loadBankingReceiptInbox,
  loadUnmatchedCapturedExpenses,
  linkBankingReceipt,
  createBankingVendor,
  refreshBankingFeeds,
} from "@/lib/services/books/banking-workspace";
async function run<T>(fn: () => Promise<T>) {
  try {
    return { success: true as const, data: await fn() };
  } catch (error) {
    return actionError(error);
  }
}
export async function loadBankingTransactionsAction(
  input: Parameters<typeof loadBankingTransactions>[0],
) {
  return run(() => loadBankingTransactions(input));
}
export async function loadBankingOptionsAction() {
  return run(loadBankingOptions);
}
export async function mutateBankingTransactionAction(
  input: Parameters<typeof mutateBankingTransaction>[0],
) {
  return run(() => mutateBankingTransaction(input));
}
export async function loadBankingDetailAction(id: string) {
  return run(() => loadBankingDetail(id));
}
export async function uploadBankingReceiptAction(data: FormData) {
  return run(() => uploadBankingReceipt(data));
}
export async function loadBankingReceiptInboxAction() {
  return run(loadBankingReceiptInbox);
}
export async function loadUnmatchedCapturedExpensesAction() {
  return run(loadUnmatchedCapturedExpenses);
}
export async function linkBankingReceiptAction(
  input: Parameters<typeof linkBankingReceipt>[0],
) {
  return run(() => linkBankingReceipt(input));
}
export async function createBankingVendorAction(name: string) {
  return run(() => createBankingVendor(name));
}
export async function refreshBankingFeedsAction() {
  return run(refreshBankingFeeds);
}

export async function reconnectBankingAccountAction(bankAccountId: string) {
  return run(async () =>
    (await import("@/lib/services/books/bank-feeds")).createPlaidReconnectToken(
      bankAccountId,
    ),
  );
}

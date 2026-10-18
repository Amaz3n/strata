import { AlertTriangle, CreditCard, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBankDate } from "./banking-ui";
import styles from "./banking-account-card.module.css";

type AccountBrand =
  | "chase"
  | "bankOfAmerica"
  | "wellsFargo"
  | "capitalOne"
  | "americanExpress"
  | "plaid"
  | "neutral";

function accountBrand(institution: string | null | undefined): AccountBrand {
  const name = institution?.toLocaleLowerCase() ?? "";
  if (name.includes("chase")) return "chase";
  if (name.includes("bank of america")) return "bankOfAmerica";
  if (name.includes("wells fargo")) return "wellsFargo";
  if (name.includes("capital one")) return "capitalOne";
  if (name.includes("american express") || name.includes("amex"))
    return "americanExpress";
  if (name.includes("plaid")) return "plaid";
  return "neutral";
}

export function BankingAccountCard({
  account,
  institution,
  connectionStatus,
  connectionError,
  reviewCount,
  selected,
  onSelect,
}: {
  account: {
    name: string;
    mask: string | null;
    account_type: string;
    current_balance_cents: number | null;
    currency: string | null;
    balance_as_of: string | null;
    gl_account_id: string | null;
  };
  institution: string | null | undefined;
  connectionStatus: string | null | undefined;
  connectionError: string | null | undefined;
  reviewCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const brand = accountBrand(institution);
  const needsMapping = !account.gl_account_id;
  const needsConnectionAttention =
    connectionStatus === "error" || Boolean(connectionError);
  const hasWarning = needsMapping || needsConnectionAttention;
  const statusLabel =
    needsMapping && needsConnectionAttention
      ? "Mapping and connection need attention"
      : needsMapping
        ? "Account mapping needed"
        : needsConnectionAttention
          ? "Connection needs attention"
          : `Updated ${account.balance_as_of ? formatBankDate(account.balance_as_of.slice(0, 10)) : "awaiting sync"}`;
  const accountType =
    account.account_type === "credit" ? "Credit card" : "Bank account";
  const formattedBalance =
    account.current_balance_cents == null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: account.currency ?? "USD",
        }).format(account.current_balance_cents / 100);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${institution || accountType}, ${account.name}, ending in ${account.mask || "unknown"}, ${formattedBalance}, ${reviewCount} to review, ${statusLabel}${selected ? ", selected" : ""}`}
      className={cn(
        styles.card,
        styles[brand],
        "relative flex h-[8.75rem] w-56 shrink-0 flex-col overflow-hidden border border-white/20 p-3 text-left text-white outline-none",
        selected && styles.selected,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {account.account_type === "credit" ? (
          <CreditCard className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <Landmark className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate text-xs font-semibold tracking-[-0.005em] text-white/95">
          {institution || "Bank account"}
        </span>
      </span>

      <span className="mt-2 flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-white">
          {account.name}
        </span>
        <span className="shrink-0 text-[11px] font-medium tracking-[0.08em] text-white/90">
          •••• {account.mask || "—"}
        </span>
      </span>

      <span className="mt-1.5 block font-mono text-xl font-medium leading-none tracking-[-0.035em] tabular-nums text-white">
        {formattedBalance}
      </span>

      <span className="mt-auto flex items-end justify-between gap-2 border-t border-white/20 pt-2">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-white/90",
            hasWarning && "text-white",
          )}
        >
          {hasWarning ? (
            <AlertTriangle
              className="size-3.5 shrink-0"
              strokeWidth={2.25}
              aria-hidden="true"
            />
          ) : null}
          <span className="truncate" title={statusLabel}>
            {statusLabel}
          </span>
        </span>
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-white">
          {reviewCount} to review
        </span>
      </span>
    </button>
  );
}

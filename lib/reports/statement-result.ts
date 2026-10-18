import type { StatementsForPeriod } from "@/lib/services/books/statement-detail";
import { STATEMENT_DIMENSIONS } from "@/lib/services/books/statements";
import type { ReportColumn, ReportResult, ReportRow } from "./types";
import { formatMoneyCents } from "./format";

/**
 * The total row of a sliced P&L is the sum of its slices, and it must equal the
 * unsliced statement: a slice that lost or doubled a line fails loudly rather
 * than printing a total its rows do not add up to.
 */
function recombinedTotals(
  entries: Array<{ revenueCents: number; cogsCents: number; expenseCents: number; netIncomeCents: number }>,
  pnl: { revenueCents: number; cogsCents: number; expenseCents: number; netIncomeCents: number },
) {
  const sum = (key: "revenueCents" | "cogsCents" | "expenseCents" | "netIncomeCents") => entries.reduce((total, entry) => total + entry[key], 0)
  const totals = { revenueCents: sum("revenueCents"), cogsCents: sum("cogsCents"), expenseCents: sum("expenseCents"), netIncomeCents: sum("netIncomeCents") }
  for (const key of ["revenueCents", "cogsCents", "expenseCents", "netIncomeCents"] as const) {
    if (totals[key] !== pnl[key]) throw new Error("The slices of this statement do not add up to its total. The statement was not shown; report this to Arc support.")
  }
  return { name: "Total", ...totals, grossProfitCents: totals.revenueCents - totals.cogsCents }
}

/** A single statement representation for the interactive canvas, snapshots and exports. */
export function statementResult(
  slug: string,
  data: StatementsForPeriod,
  dimension = "account",
  monthly = false,
): ReportResult {
  const { profitLoss: pnl, balanceSheet: balance, trialBalance: trial } = data;
  // A closed period is served as it was closed; the heading says so.
  const asClosed = data.closedPeriod ? ` · as closed ${data.closedPeriod.closedAt.slice(0, 10)}` : "";
  const activity = (
    row: { accountId: string; code: string; name: string },
    startDate = data.startDate,
    endDate = data.endDate,
  ) => ({
    operatingOnly: slug === "books-profit-loss",
    accountId: row.accountId,
    code: row.code,
    name: row.name,
    startDate,
    endDate,
  });
  const columns: ReportColumn[] = [
    { key: "name", header: "Account" },
    { key: "amount", header: "Amount", type: "money" },
  ];
  const total = (key: string, name: string, amount: number): ReportRow => ({
    key,
    emphasis: "subtotal",
    cells: { name, amount },
  });
  if (slug === "books-profit-loss") {
    const sliceDimension = STATEMENT_DIMENSIONS.find((key) => key === dimension);
    if (dimension !== "account") {
      const entries =
        dimension === "project"
          ? pnl.byProject.map((p) => ({
              ...p,
              key: p.projectId ?? "unassigned",
              label: p.projectName,
            }))
          : (pnl.byDimension[dimension] ?? []);
      return {
        subtitle: `${data.startDate} through ${data.endDate} · accrual${asClosed}`,
        tables: [
          {
            key: "dimensions",
            title: "Profit & loss by dimension",
            description:
              "Unassigned includes postings without this classification. Dimensions reflect the classification at posting.",
            columns: [
              {
                key: "name",
                header: dimension === "project" ? "Project" : "Dimension",
              },
              ...[
                ["revenueCents", "Revenue"],
                ["cogsCents", "Direct costs"],
                ["grossProfitCents", "Gross profit"],
                ["expenseCents", "Expenses"],
                ["netIncomeCents", "Net income"],
              ].map(([key, header]) => ({
                key,
                header,
                type: "money" as const,
                aggregation: "sum" as const,
              })),
            ],
            rows: entries.map((p) => ({
              key: p.key || "unassigned",
              cells: {
                name: p.label,
                revenueCents: p.revenueCents,
                cogsCents: p.cogsCents,
                grossProfitCents: p.revenueCents - p.cogsCents,
                expenseCents: p.expenseCents,
                netIncomeCents: p.netIncomeCents,
              },
              // Each slice opens per account, and each account opens the lines
              // carrying this value (or none, for the unassigned slice).
              children: sliceDimension && "accounts" in p ? p.accounts.map((account) => ({
                key: `${p.key || "unassigned"}:${account.accountId}`,
                activity: { ...activity(account), dimension: { key: sliceDimension, value: p.key === "" ? null : p.key, label: p.label } },
                cells: {
                  name: `${account.code}  ${account.name}`,
                  revenueCents: account.accountType === "income" ? account.balanceCents : null,
                  cogsCents: account.accountType === "cogs" ? account.balanceCents : null,
                  expenseCents: account.accountType === "expense" ? account.balanceCents : null,
                  netIncomeCents: account.accountType === "income" ? account.balanceCents : -account.balanceCents,
                },
              })) : undefined,
            })),
            totals: recombinedTotals(entries, pnl),
          },
        ],
      };
    }
    const prior = data.priorProfitLoss;
    if (monthly)
      columns.splice(
        1,
        0,
        ...data.monthlyProfitLoss.map((m) => ({
          key: m.startDate,
          header: m.label,
          type: "money" as const,
        })),
      );
    else if (prior)
      columns.push(
        {
          key: "prior",
          header: data.comparisonLabel ?? "Comparison",
          type: "money",
        },
        { key: "variance", header: "Change", type: "money" },
        { key: "variancePercent", header: "Change %", type: "percent" },
      );
    const rows: ReportRow[] = [];
    const types = [
      ["income", "Revenue", "revenueCents"],
      ["cogs", "Direct costs", "cogsCents"],
      ["expense", "Operating expenses", "expenseCents"],
    ] as const;
    for (const [type, label, measure] of types) {
      rows.push({ key: type, emphasis: "group", cells: { name: label } });
      // Include comparative-only accounts so the displayed comparison reconciles.
      const accounts = new Map(
        [
          ...pnl.rows,
          ...(prior?.rows ?? []),
          ...data.monthlyProfitLoss.flatMap((m) => m.profitLoss.rows),
        ]
          .filter((r) => r.accountType === type)
          .map((r) => [r.accountId, r]),
      );
      for (const account of accounts.values()) {
        const current = pnl.rows.find((r) => r.accountId === account.accountId);
        const amount = current?.balanceCents ?? 0;
        const previous =
          prior?.rows.find((r) => r.accountId === account.accountId)
            ?.balanceCents ?? 0;
        const monthlyCells = Object.fromEntries(
          data.monthlyProfitLoss.map((m) => [
            m.startDate,
            m.profitLoss.rows.find((r) => r.accountId === account.accountId)
              ?.balanceCents ?? 0,
          ]),
        );
        rows.push({
          key: account.accountId,
          activity: activity(account),
          activities: {
            ...(data.comparisonRange
              ? {
                  prior: activity(
                    account,
                    data.comparisonRange.start,
                    data.comparisonRange.end,
                  ),
                }
              : {}),
            ...Object.fromEntries(
              data.monthlyProfitLoss.map((m) => [
                m.startDate,
                activity(account, m.startDate, m.endDate),
              ]),
            ),
          },
          cells: {
            name: `${account.code}  ${account.name}`,
            amount,
            prior: previous,
            variance: amount - previous,
            variancePercent: previous
              ? ((amount - previous) / Math.abs(previous)) * 100
              : null,
            ...monthlyCells,
          },
          children: current?.projects?.map((p) => ({
            key: `${account.accountId}:${p.projectId ?? "unassigned"}`,
            activity: {
              ...activity(account),
              projectId: p.projectId,
              projectName: p.projectName,
              unassignedOnly: !p.projectId,
            },
            cells: { name: p.projectName, amount: p.balanceCents },
          })),
        });
      }
      const subtotal = total(
        `total-${type}`,
        `Total ${label.toLowerCase()}`,
        pnl[measure],
      );
      subtotal.cells.prior = prior?.[measure] ?? null;
      subtotal.cells.variance = prior ? pnl[measure] - prior[measure] : null;
      subtotal.cells.variancePercent = prior?.[measure]
        ? ((pnl[measure] - prior[measure]) / Math.abs(prior[measure])) * 100
        : null;
      for (const month of data.monthlyProfitLoss)
        subtotal.cells[month.startDate] = month.profitLoss[measure];
      rows.push(subtotal);
      if (type === "cogs") {
        const gross = total("gross", "Gross profit", pnl.grossProfitCents);
        gross.cells.prior = prior?.grossProfitCents ?? null;
        gross.cells.variance = prior
          ? pnl.grossProfitCents - prior.grossProfitCents
          : null;
        gross.cells.variancePercent = prior?.grossProfitCents
          ? ((pnl.grossProfitCents - prior.grossProfitCents) /
              Math.abs(prior.grossProfitCents)) *
            100
          : null;
        for (const month of data.monthlyProfitLoss)
          gross.cells[month.startDate] = month.profitLoss.grossProfitCents;
        rows.push(gross);
      }
    }
    return {
      subtitle: `${data.startDate} through ${data.endDate} · accrual${asClosed}`,
      stats: [
        {
          key: "revenue",
          label: "Revenue",
          value: formatMoneyCents(pnl.revenueCents),
        },
        {
          key: "gross",
          label: "Gross profit",
          value: formatMoneyCents(pnl.grossProfitCents),
        },
        {
          key: "net",
          label: "Net income",
          value: formatMoneyCents(pnl.netIncomeCents),
        },
      ],
      tables: [
        {
          key: "accounts",
          locked: true,
          columns,
          rows,
          totals: {
            name: "Net income",
            amount: pnl.netIncomeCents,
            prior: prior?.netIncomeCents ?? null,
            variance: prior ? pnl.netIncomeCents - prior.netIncomeCents : null,
            variancePercent: prior?.netIncomeCents
              ? ((pnl.netIncomeCents - prior.netIncomeCents) /
                  Math.abs(prior.netIncomeCents)) *
                100
              : null,
            ...Object.fromEntries(
              data.monthlyProfitLoss.map((m) => [
                m.startDate,
                m.profitLoss.netIncomeCents,
              ]),
            ),
          },
        },
      ],
    };
  }
  if (slug === "books-balance-sheet") {
    const rows: ReportRow[] = [];
    for (const [type, label, amount] of [
      ["asset", "Assets", balance.assetCents],
      ["liability", "Liabilities", balance.liabilityCents],
      ["equity", "Equity", balance.equityCents],
    ] as const) {
      rows.push({ key: type, emphasis: "group", cells: { name: label } });
      rows.push(
        ...balance.rows
          .filter((r) => r.accountType === type)
          .map((r) => ({
            key: r.accountId,
            activity: activity(r, "1900-01-01"),
            cells: { name: `${r.code}  ${r.name}`, amount: r.balanceCents },
          })),
      );
      if (type === "equity")
        rows.push({
          key: "earnings",
          cells: {
            name: "Current period earnings",
            amount: balance.currentEarningsCents,
          },
        });
      rows.push(total(`total-${type}`, `Total ${label.toLowerCase()}`, amount));
    }
    return {
      subtitle: `As of ${data.endDate}${asClosed}`,
      notice: balance.differenceCents
        ? {
            tone: "warning",
            message: `Out of balance by ${formatMoneyCents(balance.differenceCents)}.`,
          }
        : undefined,
      tables: [
        {
          key: "accounts",
          locked: true,
          columns,
          rows,
          totals: {
            name: "Liabilities and equity",
            amount: balance.liabilityCents + balance.equityCents,
          },
        },
        ...(balance.contractPositions.length
          ? [
              {
                key: "contracts",
                locked: true,
                title: "Contract asset and liability positions",
                columns: [
                  { key: "contract", header: "Contract / project" },
                  { key: "asset", header: "Asset", type: "money" as const },
                  {
                    key: "liability",
                    header: "Liability",
                    type: "money" as const,
                  },
                ],
                rows: balance.contractPositions.map((p, i) => ({
                  key: String(i),
                  cells: {
                    contract: p.contractId ?? p.projectId ?? "Unassigned",
                    asset: p.assetCents,
                    liability: p.liabilityCents,
                  },
                })),
              },
            ]
          : []),
      ],
    };
  }
  return {
    subtitle: `As of ${data.endDate}${asClosed}`,
    notice:
      trial.totalDebitCents !== trial.totalCreditCents
        ? { tone: "warning", message: "Debits and credits do not balance." }
        : undefined,
    tables: [
      {
        key: "accounts",
        locked: true,
        columns: [
          columns[0],
          { key: "debit", header: "Debit", type: "money" },
          { key: "credit", header: "Credit", type: "money" },
        ],
        rows: trial.rows.map((r) => ({
          key: r.accountId,
          activity: activity(r, "1900-01-01"),
          cells: {
            name: `${r.code}  ${r.name}`,
            debit: r.debitCents,
            credit: r.creditCents,
          },
        })),
        totals: {
          name: "Total",
          debit: trial.totalDebitCents,
          credit: trial.totalCreditCents,
        },
      },
    ],
  };
}

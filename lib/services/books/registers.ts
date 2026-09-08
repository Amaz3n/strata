import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { recordAudit } from "@/lib/services/audit";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function requireRegisterManager(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireBooksWorkspaceEnabled(context.orgId);
  await requireAuthorization({
    permission: "books.adjust",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_register",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

async function account(
  service: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  id: string,
  allowedSubtypes: string[],
) {
  const { data, error } = await service
    .from("gl_accounts")
    .select("id, code, subtype, active")
    .eq("org_id", orgId)
    .eq("id", id)
    .single();
  if (error || !data || !data.active)
    throw new Error("The selected register account is unavailable");
  if (!allowedSubtypes.includes(String(data.subtype)))
    throw new Error(
      `Account ${data.code} is not valid for this register field`,
    );
  return data;
}

async function policyVersion(
  service: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
) {
  const { data, error } = await service
    .from("books_settings")
    .select("active_policy_version")
    .eq("org_id", orgId)
    .single();
  if (error)
    throw new Error(`Failed to load accounting policy: ${error.message}`);
  return Number(data.active_policy_version);
}

export async function getBooksRegisters(orgId?: string) {
  const context = await requireRegisterManager(orgId);
  const service = createServiceSupabaseClient();
  const [debts, debtEvents, assets, assetEvents, accounts] = await Promise.all([
    service
      .from("books_debt_instruments")
      .select(
        "id,name,opened_on,maturity_on,original_principal_cents,annual_interest_bps,payment_frequency,active,liability_account_id,cash_account_id,interest_expense_account_id",
      )
      .eq("org_id", context.orgId)
      .order("name"),
    service
      .from("books_debt_events")
      .select(
        "id,instrument_id,event_type,event_date,principal_cents,interest_cents,fee_cents,memo",
      )
      .eq("org_id", context.orgId)
      .order("event_date"),
    service
      .from("books_fixed_assets")
      .select(
        "id,asset_number,name,placed_in_service_on,acquisition_cost_cents,opening_accumulated_depreciation_cents,opening_as_of,salvage_value_cents,useful_life_months,status,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,funding_account_id",
      )
      .eq("org_id", context.orgId)
      .order("asset_number"),
    service
      .from("books_fixed_asset_events")
      .select(
        "id,asset_id,event_type,event_date,amount_cents,proceeds_cents,memo",
      )
      .eq("org_id", context.orgId)
      .order("event_date"),
    service
      .from("gl_accounts")
      .select("id,code,name,account_type,subtype,active")
      .eq("org_id", context.orgId)
      .eq("active", true)
      .order("code"),
  ]);
  const error =
    debts.error ??
    debtEvents.error ??
    assets.error ??
    assetEvents.error ??
    accounts.error;
  if (error)
    throw new Error(`Failed to load Books registers: ${error.message}`);
  const debtRows = (debts.data ?? []).map((debt) => {
    const events = (debtEvents.data ?? []).filter(
      (event) => event.instrument_id === debt.id,
    );
    const balanceCents = events.reduce(
      (sum, event) => {
        const principal = Number(event.principal_cents ?? 0);
        const interest = Number(event.interest_cents ?? 0);
        return (
          sum +
          (["draw", "interest_accrual"].includes(event.event_type)
            ? principal + interest
            : event.event_type === "payment"
              ? -principal
              : 0)
        );
      },
      Number(debt.original_principal_cents ?? 0),
    );
    return { ...debt, balanceCents, events: events.slice(-12).reverse() };
  });
  const assetRows = (assets.data ?? []).map((asset) => {
    const events = (assetEvents.data ?? []).filter(
      (event) => event.asset_id === asset.id,
    );
    const depreciationCents = events
      .filter((event) =>
        ["depreciation", "impairment"].includes(event.event_type),
      )
      .reduce((sum, event) => sum + Number(event.amount_cents ?? 0), Number(asset.opening_accumulated_depreciation_cents ?? 0));
    return {
      ...asset,
      depreciationCents,
      bookValueCents: Number(asset.acquisition_cost_cents) - depreciationCents,
      events: events.slice(-12).reverse(),
    };
  });
  return { debts: debtRows, assets: assetRows, accounts: accounts.data ?? [] };
}

export async function createDebtInstrument(
  input: {
    name: string;
    openedOn: string;
    maturityOn?: string | null;
    originalPrincipalCents: number;
    annualInterestBps: number;
    paymentFrequency: string;
    liabilityAccountId: string;
    cashAccountId: string;
    interestExpenseAccountId: string;
    notes?: string | null;
  },
  orgId?: string,
) {
  const context = await requireRegisterManager(orgId);
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(160),
      openedOn: isoDate,
      maturityOn: isoDate.nullish(),
      originalPrincipalCents: z.number().int().nonnegative(),
      annualInterestBps: z.number().int().min(0).max(100000),
      paymentFrequency: z.enum([
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "annual",
        "irregular",
      ]),
      liabilityAccountId: z.string().uuid(),
      cashAccountId: z.string().uuid(),
      interestExpenseAccountId: z.string().uuid(),
      notes: z.string().trim().max(1000).nullish(),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  await Promise.all([
    account(service, context.orgId, parsed.liabilityAccountId, [
      "current_debt",
      "long_term_debt",
    ]),
    account(service, context.orgId, parsed.cashAccountId, [
      "cash",
      "undeposited_funds",
    ]),
    account(service, context.orgId, parsed.interestExpenseAccountId, [
      "interest",
    ]),
  ]);
  const { data, error } = await service
    .from("books_debt_instruments")
    .insert({
      org_id: context.orgId,
      name: parsed.name,
      opened_on: parsed.openedOn,
      maturity_on: parsed.maturityOn ?? null,
      original_principal_cents: parsed.originalPrincipalCents,
      annual_interest_bps: parsed.annualInterestBps,
      payment_frequency: parsed.paymentFrequency,
      liability_account_id: parsed.liabilityAccountId,
      cash_account_id: parsed.cashAccountId,
      interest_expense_account_id: parsed.interestExpenseAccountId,
      notes: parsed.notes ?? null,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to create debt instrument: ${error.message}`);
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "books_debt_instrument",
    entityId: data.id,
    after: parsed,
    source: "books.registers",
  });
  return { id: data.id };
}

export async function recordDebtEvent(
  input: {
    instrumentId: string;
    eventType: "opening" | "draw" | "payment" | "interest_accrual" | "fee";
    eventDate: string;
    principalCents: number;
    interestCents: number;
    feeCents: number;
    memo: string;
  },
  orgId?: string,
) {
  const context = await requireRegisterManager(orgId);
  const parsed = z
    .object({
      instrumentId: z.string().uuid(),
      eventType: z.enum([
        "opening",
        "draw",
        "payment",
        "interest_accrual",
        "fee",
      ]),
      eventDate: isoDate,
      principalCents: z.number().int().nonnegative(),
      interestCents: z.number().int().nonnegative(),
      feeCents: z.number().int().nonnegative(),
      memo: z.string().trim().min(4).max(500),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  const { data: debt, error } = await service
    .from("books_debt_instruments")
    .select(
      "id,liability_account_id,cash_account_id,interest_expense_account_id",
    )
    .eq("org_id", context.orgId)
    .eq("id", parsed.instrumentId)
    .single();
  if (error)
    throw new Error(`Failed to load debt instrument: ${error.message}`);
  const total = parsed.principalCents + parsed.interestCents + parsed.feeCents;
  if (total <= 0) throw new Error("A debt event must contain an amount");
  if (parsed.eventType === "opening")
    throw new Error(
      "Use the instrument original principal for the opening position",
    );
  if (parsed.eventType === "draw" && (parsed.interestCents || parsed.feeCents))
    throw new Error("A draw contains principal only");
  const eventKey = `debt:${debt.id}:${randomUUID()}`;
  const lines: Array<Record<string, unknown>> = [];
  const add = (
    accountId: string,
    debit: number,
    credit: number,
    lineNo: number,
  ) =>
    lines.push({
      line_no: lineNo,
      account_id: accountId,
      debit_cents: debit,
      credit_cents: credit,
      description: parsed.memo,
      dimensions: { debt_instrument_id: debt.id },
    });
  if (parsed.eventType === "draw") {
    add(debt.cash_account_id, parsed.principalCents, 0, 1);
    add(debt.liability_account_id, 0, parsed.principalCents, 2);
  } else if (parsed.eventType === "payment") {
    let lineNo = 1;
    if (parsed.principalCents)
      add(debt.liability_account_id, parsed.principalCents, 0, lineNo++);
    if (parsed.interestCents + parsed.feeCents)
      add(
        debt.interest_expense_account_id,
        parsed.interestCents + parsed.feeCents,
        0,
        lineNo++,
      );
    add(debt.cash_account_id, 0, total, lineNo);
  } else if (parsed.eventType === "interest_accrual") {
    if (!parsed.interestCents || parsed.principalCents || parsed.feeCents)
      throw new Error("An interest accrual contains interest only");
    add(debt.interest_expense_account_id, parsed.interestCents, 0, 1);
    add(debt.liability_account_id, 0, parsed.interestCents, 2);
  } else {
    if (!parsed.feeCents || parsed.principalCents || parsed.interestCents)
      throw new Error("A fee event contains a fee only");
    add(debt.interest_expense_account_id, parsed.feeCents, 0, 1);
    add(debt.cash_account_id, 0, parsed.feeCents, 2);
  }
  const version = await policyVersion(service, context.orgId);
  const { data: journalId, error: postError } = await service.rpc(
    "post_books_registered_subledger_event_atomic",
    {
      p_org_id: context.orgId,
      p_register: "debt",
      p_parent_id: debt.id,
      p_event: {
        event_type: parsed.eventType,
        event_date: parsed.eventDate,
        principal_cents: parsed.principalCents,
        interest_cents: parsed.interestCents,
        fee_cents: parsed.feeCents,
        event_key: eventKey,
        memo: parsed.memo,
        created_by: context.userId,
      },
      p_entry: {
        entry_date: parsed.eventDate,
        entry_kind: "operational",
        memo: parsed.memo,
        posting_key: eventKey,
        projection_version: 1,
        policy_version: version,
        source_type: "books_debt_instrument",
        source_id: debt.id,
        created_by: context.userId,
      },
      p_lines: lines,
    },
  );
  if (postError)
    throw new Error(`Failed to post debt event: ${postError.message}`);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books_debt_event_posted",
    entityType: "books_debt_instrument",
    entityId: debt.id,
    payload: { journal_entry_id: journalId, ...parsed },
  });
  return { journalId: String(journalId) };
}

export async function createFixedAsset(
  input: {
    assetNumber: string;
    name: string;
    placedInServiceOn: string;
    acquisitionCostCents: number;
    salvageValueCents: number;
    usefulLifeMonths: number;
    assetAccountId: string;
    accumulatedDepreciationAccountId: string;
    depreciationExpenseAccountId: string;
    fundingAccountId: string;
    postAcquisition: boolean;
  },
  orgId?: string,
) {
  const context = await requireRegisterManager(orgId);
  const parsed = z
    .object({
      assetNumber: z.string().trim().min(1).max(64),
      name: z.string().trim().min(2).max(160),
      placedInServiceOn: isoDate,
      acquisitionCostCents: z.number().int().positive(),
      salvageValueCents: z.number().int().nonnegative(),
      usefulLifeMonths: z.number().int().min(1).max(1200),
      assetAccountId: z.string().uuid(),
      accumulatedDepreciationAccountId: z.string().uuid(),
      depreciationExpenseAccountId: z.string().uuid(),
      fundingAccountId: z.string().uuid(),
      postAcquisition: z.boolean(),
    })
    .parse(input);
  if (parsed.salvageValueCents > parsed.acquisitionCostCents)
    throw new Error("Salvage value cannot exceed cost");
  const service = createServiceSupabaseClient();
  await Promise.all([
    account(service, context.orgId, parsed.assetAccountId, ["fixed_assets"]),
    account(service, context.orgId, parsed.accumulatedDepreciationAccountId, [
      "accumulated_depreciation",
    ]),
    account(service, context.orgId, parsed.depreciationExpenseAccountId, [
      "depreciation",
    ]),
    account(service, context.orgId, parsed.fundingAccountId, [
      "cash",
      "accounts_payable",
      "current_debt",
      "long_term_debt",
      "owner_contributions",
      "other_liability",
    ]),
  ]);
  const { data: asset, error } = await service
    .from("books_fixed_assets")
    .insert({
      org_id: context.orgId,
      asset_number: parsed.assetNumber,
      name: parsed.name,
      placed_in_service_on: parsed.placedInServiceOn,
      acquisition_cost_cents: parsed.acquisitionCostCents,
      salvage_value_cents: parsed.salvageValueCents,
      useful_life_months: parsed.usefulLifeMonths,
      asset_account_id: parsed.assetAccountId,
      accumulated_depreciation_account_id:
        parsed.accumulatedDepreciationAccountId,
      depreciation_expense_account_id: parsed.depreciationExpenseAccountId,
      funding_account_id: parsed.fundingAccountId,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to register fixed asset: ${error.message}`);
  if (parsed.postAcquisition) {
    const version = await policyVersion(service, context.orgId);
    const eventKey = `fixed_asset:${asset.id}:acquisition`;
    const { error: postError } = await service.rpc(
      "post_books_registered_subledger_event_atomic",
      {
        p_org_id: context.orgId,
        p_register: "fixed_asset",
        p_parent_id: asset.id,
        p_event: {
          event_type: "acquisition",
          event_date: parsed.placedInServiceOn,
          amount_cents: parsed.acquisitionCostCents,
          event_key: eventKey,
          memo: `Acquire ${parsed.assetNumber} ${parsed.name}`,
          created_by: context.userId,
        },
        p_entry: {
          entry_date: parsed.placedInServiceOn,
          entry_kind: "operational",
          memo: `Acquire ${parsed.assetNumber} ${parsed.name}`,
          posting_key: eventKey,
          projection_version: 1,
          policy_version: version,
          source_type: "books_fixed_asset",
          source_id: asset.id,
          created_by: context.userId,
        },
        p_lines: [
          {
            line_no: 1,
            account_id: parsed.assetAccountId,
            debit_cents: parsed.acquisitionCostCents,
            credit_cents: 0,
            dimensions: { fixed_asset_id: asset.id },
          },
          {
            line_no: 2,
            account_id: parsed.fundingAccountId,
            debit_cents: 0,
            credit_cents: parsed.acquisitionCostCents,
            dimensions: { fixed_asset_id: asset.id },
          },
        ],
      },
    );
    if (postError) {
      await service
        .from("books_fixed_assets")
        .delete()
        .eq("org_id", context.orgId)
        .eq("id", asset.id);
      throw new Error(
        `Failed to register and post the asset acquisition: ${postError.message}`,
      );
    }
  }
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "books_fixed_asset",
    entityId: asset.id,
    after: parsed,
    source: "books.registers",
  });
  return { id: asset.id };
}

export async function postFixedAssetDepreciation(
  input: { assetId: string; throughDate: string; amountCents?: number },
  orgId?: string,
) {
  const context = await requireRegisterManager(orgId);
  const parsed = z
    .object({
      assetId: z.string().uuid(),
      throughDate: isoDate,
      amountCents: z.number().int().positive().optional(),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  const { data: asset, error } = await service
    .from("books_fixed_assets")
    .select(
      "id,asset_number,name,acquisition_cost_cents,opening_accumulated_depreciation_cents,opening_as_of,salvage_value_cents,useful_life_months,depreciation_expense_account_id,accumulated_depreciation_account_id,status",
    )
    .eq("org_id", context.orgId)
    .eq("id", parsed.assetId)
    .single();
  if (error || asset.status === "disposed")
    throw new Error("The fixed asset is unavailable");
  const { data: prior, error: priorError } = await service
    .from("books_fixed_asset_events")
    .select("amount_cents")
    .eq("org_id", context.orgId)
    .eq("asset_id", asset.id)
    .in("event_type", ["depreciation", "impairment"]);
  if (priorError)
    throw new Error(
      `Failed to load depreciation history: ${priorError.message}`,
    );
  const depreciable =
    Number(asset.acquisition_cost_cents) - Number(asset.salvage_value_cents);
  if (asset.opening_as_of && parsed.throughDate <= asset.opening_as_of)
    throw new Error("Depreciation must be dated after the opening cutover");
  const taken = (prior ?? []).reduce(
    (sum, row) => sum + Number(row.amount_cents),
    Number(asset.opening_accumulated_depreciation_cents ?? 0),
  );
  const remaining = depreciable - taken;
  if (remaining <= 0) throw new Error("The asset is already fully depreciated");
  const monthly = Math.max(
    1,
    Math.round(depreciable / Number(asset.useful_life_months)),
  );
  const amount = Math.min(parsed.amountCents ?? monthly, remaining);
  const eventKey = `fixed_asset:${asset.id}:depreciation:${parsed.throughDate}`;
  const version = await policyVersion(service, context.orgId);
  const memo = `Depreciation through ${parsed.throughDate} · ${asset.asset_number} ${asset.name}`;
  const { data: journalId, error: postError } = await service.rpc(
    "post_books_registered_subledger_event_atomic",
    {
      p_org_id: context.orgId,
      p_register: "fixed_asset",
      p_parent_id: asset.id,
      p_event: {
        event_type: "depreciation",
        event_date: parsed.throughDate,
        amount_cents: amount,
        event_key: eventKey,
        memo,
        created_by: context.userId,
      },
      p_entry: {
        entry_date: parsed.throughDate,
        entry_kind: "operational",
        memo,
        posting_key: eventKey,
        projection_version: 1,
        policy_version: version,
        source_type: "books_fixed_asset",
        source_id: asset.id,
        created_by: context.userId,
      },
      p_lines: [
        {
          line_no: 1,
          account_id: asset.depreciation_expense_account_id,
          debit_cents: amount,
          credit_cents: 0,
          dimensions: { fixed_asset_id: asset.id },
        },
        {
          line_no: 2,
          account_id: asset.accumulated_depreciation_account_id,
          debit_cents: 0,
          credit_cents: amount,
          dimensions: { fixed_asset_id: asset.id },
        },
      ],
    },
  );
  if (postError)
    throw new Error(`Failed to post depreciation: ${postError.message}`);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books_fixed_asset_depreciated",
    entityType: "books_fixed_asset",
    entityId: asset.id,
    payload: {
      journal_entry_id: journalId,
      amount_cents: amount,
      through_date: parsed.throughDate,
    },
  });
  return { journalId: String(journalId), amountCents: amount };
}

export async function disposeFixedAsset(
  input: {
    assetId: string;
    disposedOn: string;
    proceedsCents: number;
    cashAccountId: string;
    gainAccountId: string;
    lossAccountId: string;
  },
  orgId?: string,
) {
  const context = await requireRegisterManager(orgId);
  const parsed = z
    .object({
      assetId: z.string().uuid(),
      disposedOn: isoDate,
      proceedsCents: z.number().int().nonnegative(),
      cashAccountId: z.string().uuid(),
      gainAccountId: z.string().uuid(),
      lossAccountId: z.string().uuid(),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  const [{ data: asset, error }, cash, gain, loss] = await Promise.all([
    service
      .from("books_fixed_assets")
      .select(
        "id,asset_number,name,acquisition_cost_cents,opening_accumulated_depreciation_cents,opening_as_of,asset_account_id,accumulated_depreciation_account_id,status",
      )
      .eq("org_id", context.orgId)
      .eq("id", parsed.assetId)
      .single(),
    account(service, context.orgId, parsed.cashAccountId, [
      "cash",
      "undeposited_funds",
    ]),
    account(service, context.orgId, parsed.gainAccountId, ["other_revenue"]),
    account(service, context.orgId, parsed.lossAccountId, ["other_expense"]),
  ]);
  if (error || !asset || asset.status === "disposed")
    throw new Error("The fixed asset is unavailable");
  const { data: events, error: eventError } = await service
    .from("books_fixed_asset_events")
    .select("event_type,amount_cents")
    .eq("org_id", context.orgId)
    .eq("asset_id", asset.id)
    .in("event_type", ["depreciation", "impairment"]);
  if (eventError)
    throw new Error(`Failed to load depreciation: ${eventError.message}`);
  if (asset.opening_as_of && parsed.disposedOn <= asset.opening_as_of)
    throw new Error("Disposal must be dated after the opening cutover");
  const accumulated = (events ?? []).reduce(
    (sum, event) => sum + Number(event.amount_cents ?? 0),
    Number(asset.opening_accumulated_depreciation_cents ?? 0),
  );
  const cost = Number(asset.acquisition_cost_cents);
  const bookValue = Math.max(0, cost - accumulated);
  const gainCents = Math.max(0, parsed.proceedsCents - bookValue);
  const lossCents = Math.max(0, bookValue - parsed.proceedsCents);
  const lines: Array<Record<string, unknown>> = [];
  let lineNo = 1;
  if (parsed.proceedsCents)
    lines.push({
      line_no: lineNo++,
      account_id: cash.id,
      debit_cents: parsed.proceedsCents,
      credit_cents: 0,
      dimensions: { fixed_asset_id: asset.id },
    });
  if (accumulated)
    lines.push({
      line_no: lineNo++,
      account_id: asset.accumulated_depreciation_account_id,
      debit_cents: accumulated,
      credit_cents: 0,
      dimensions: { fixed_asset_id: asset.id },
    });
  if (lossCents)
    lines.push({
      line_no: lineNo++,
      account_id: loss.id,
      debit_cents: lossCents,
      credit_cents: 0,
      dimensions: { fixed_asset_id: asset.id },
    });
  lines.push({
    line_no: lineNo++,
    account_id: asset.asset_account_id,
    debit_cents: 0,
    credit_cents: cost,
    dimensions: { fixed_asset_id: asset.id },
  });
  if (gainCents)
    lines.push({
      line_no: lineNo,
      account_id: gain.id,
      debit_cents: 0,
      credit_cents: gainCents,
      dimensions: { fixed_asset_id: asset.id },
    });
  const eventKey = `fixed_asset:${asset.id}:disposal:${parsed.disposedOn}`;
  const memo = `Dispose ${asset.asset_number} ${asset.name}`;
  const version = await policyVersion(service, context.orgId);
  const { data: journalId, error: postError } = await service.rpc(
    "post_books_registered_subledger_event_atomic",
    {
      p_org_id: context.orgId,
      p_register: "fixed_asset",
      p_parent_id: asset.id,
      p_event: {
        event_type: "disposal",
        event_date: parsed.disposedOn,
        amount_cents: cost,
        proceeds_cents: parsed.proceedsCents,
        event_key: eventKey,
        memo,
        created_by: context.userId,
      },
      p_entry: {
        entry_date: parsed.disposedOn,
        entry_kind: "operational",
        memo,
        posting_key: eventKey,
        projection_version: 1,
        policy_version: version,
        source_type: "books_fixed_asset",
        source_id: asset.id,
        created_by: context.userId,
      },
      p_lines: lines,
    },
  );
  if (postError)
    throw new Error(`Failed to dispose fixed asset: ${postError.message}`);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books_fixed_asset_disposed",
    entityType: "books_fixed_asset",
    entityId: asset.id,
    payload: {
      journal_entry_id: journalId,
      proceeds_cents: parsed.proceedsCents,
      gain_cents: gainCents,
      loss_cents: lossCents,
    },
  });
  return { journalId: String(journalId), gainCents, lossCents };
}

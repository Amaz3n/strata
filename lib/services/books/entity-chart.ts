import { z } from "zod";
import { CONSTRUCTION_CHART_TEMPLATE } from "./chart-of-accounts";
import {
  ENTITY_CHART_CLASSIFICATIONS_V1,
  ENTITY_CONTROL_ROLES_V1,
} from "./entity-chart-policy-v1";
const code = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const ENTITY_CONTROL_ROLES = ENTITY_CONTROL_ROLES_V1;
const classifications: Record<
  string,
  { account_type: string; normal_balance: string }
> = ENTITY_CHART_CLASSIFICATIONS_V1;
export const entityChartDefinitionSchema = z
  .object({
    classification_version: z.literal(1),
    accounts: z
      .array(
        z
          .object({
            code,
            name: z.string().trim().min(2).max(160),
            account_type: z.enum([
              "asset",
              "liability",
              "equity",
              "income",
              "cogs",
              "expense",
            ]),
            subtype: z.enum(
              Object.keys(ENTITY_CHART_CLASSIFICATIONS_V1) as [
                string,
                ...string[],
              ],
            ),
            normal_balance: z.enum(["debit", "credit"]),
            cash_flow_category: z
              .enum(["cash", "operating", "investing", "financing"])
              .nullable(),
            parent_code: code.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    controls: z.record(code),
  })
  .strict()
  .superRefine((value, ctx) => {
    const bad = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const accounts = new Map(value.accounts.map((a) => [a.code, a]));
    if (accounts.size !== value.accounts.length)
      bad("Account codes must be unique in the entity chart");
    for (const a of value.accounts) {
      if (
        classifications[a.subtype]?.account_type !== a.account_type ||
        classifications[a.subtype]?.normal_balance !== a.normal_balance
      )
        bad("Account classification or normal balance differs: " + a.code);
      if (a.parent_code) {
        const p = accounts.get(a.parent_code);
        if (!p || p.account_type !== a.account_type)
          bad("Parent must belong to this chart and account type: " + a.code);
        const seen = new Set([a.code]);
        let next = a.parent_code;
        while (next) {
          if (seen.has(next)) {
            bad("Cyclic entity account hierarchy: " + a.code);
            break;
          }
          seen.add(next);
          if (seen.size > 32) {
            bad("Entity account hierarchy exceeds 32 levels: " + a.code);
            break;
          }
          next = accounts.get(next)?.parent_code ?? "";
        }
      }
    }
    if (
      Object.keys(value.controls).sort().join(",") !==
      Object.keys(ENTITY_CONTROL_ROLES).sort().join(",")
    )
      bad("Every construction control role must be mapped exactly once");
    for (const [role, expected] of Object.entries(ENTITY_CONTROL_ROLES)) {
      const a = accounts.get(value.controls[role]);
      if (
        !a ||
        a.account_type !== expected.account_type ||
        a.subtype !== expected.subtype ||
        a.normal_balance !== expected.normal_balance
      )
        bad("Control role uses missing or incompatible account: " + role);
    }
  });
export function constructionEntityChart() {
  return entityChartDefinitionSchema.parse({
    classification_version: 1,
    accounts: CONSTRUCTION_CHART_TEMPLATE.map((a) => ({
      code: a.code,
      name: a.name,
      account_type: a.accountType,
      subtype: a.subtype,
      normal_balance: a.normalBalance,
      cash_flow_category: a.cashFlowCategory ?? null,
      parent_code: null,
    })),
    controls: Object.fromEntries(
      Object.entries(ENTITY_CONTROL_ROLES).map(([role, a]) => [role, a.code]),
    ),
  });
}

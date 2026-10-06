// Immutable classification/control contract for entity chart definition version 1.
// New accounting policies require a new version; do not rewrite retained charts.
export const ENTITY_CHART_CLASSIFICATIONS_V1 = {
  cash: {
    account_type: "asset",
    normal_balance: "debit",
  },
  undeposited_funds: {
    account_type: "asset",
    normal_balance: "debit",
  },
  accounts_receivable: {
    account_type: "asset",
    normal_balance: "debit",
  },
  retainage_receivable: {
    account_type: "asset",
    normal_balance: "debit",
  },
  costs_in_excess: {
    account_type: "asset",
    normal_balance: "debit",
  },
  work_in_progress: {
    account_type: "asset",
    normal_balance: "debit",
  },
  prepaid_expenses: {
    account_type: "asset",
    normal_balance: "debit",
  },
  fixed_assets: {
    account_type: "asset",
    normal_balance: "debit",
  },
  accumulated_depreciation: {
    account_type: "asset",
    normal_balance: "credit",
  },
  other_asset: {
    account_type: "asset",
    normal_balance: "debit",
  },
  accounts_payable: {
    account_type: "liability",
    normal_balance: "credit",
  },
  retainage_payable: {
    account_type: "liability",
    normal_balance: "credit",
  },
  credit_card: {
    account_type: "liability",
    normal_balance: "credit",
  },
  payroll_clearing: {
    account_type: "liability",
    normal_balance: "credit",
  },
  sales_use_tax: {
    account_type: "liability",
    normal_balance: "credit",
  },
  customer_deposits: {
    account_type: "liability",
    normal_balance: "credit",
  },
  billings_in_excess: {
    account_type: "liability",
    normal_balance: "credit",
  },
  current_debt: {
    account_type: "liability",
    normal_balance: "credit",
  },
  long_term_debt: {
    account_type: "liability",
    normal_balance: "credit",
  },
  other_liability: {
    account_type: "liability",
    normal_balance: "credit",
  },
  expected_contract_loss_reserve: {
    account_type: "liability",
    normal_balance: "credit",
  },
  owner_equity: {
    account_type: "equity",
    normal_balance: "credit",
  },
  owner_contributions: {
    account_type: "equity",
    normal_balance: "credit",
  },
  owner_distributions: {
    account_type: "equity",
    normal_balance: "debit",
  },
  retained_earnings: {
    account_type: "equity",
    normal_balance: "credit",
  },
  construction_revenue: {
    account_type: "income",
    normal_balance: "credit",
  },
  other_revenue: {
    account_type: "income",
    normal_balance: "credit",
  },
  early_pay_discount: {
    account_type: "income",
    normal_balance: "credit",
  },
  payment_fee_recovery: {
    account_type: "income",
    normal_balance: "credit",
  },
  job_costs: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  subcontractor_costs: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  material_costs: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  direct_labor: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  equipment_costs: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  warranty_costs: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  expected_contract_loss_expense: {
    account_type: "cogs",
    normal_balance: "debit",
  },
  rent: {
    account_type: "expense",
    normal_balance: "debit",
  },
  insurance: {
    account_type: "expense",
    normal_balance: "debit",
  },
  software: {
    account_type: "expense",
    normal_balance: "debit",
  },
  professional_fees: {
    account_type: "expense",
    normal_balance: "debit",
  },
  utilities: {
    account_type: "expense",
    normal_balance: "debit",
  },
  bank_fees: {
    account_type: "expense",
    normal_balance: "debit",
  },
  interest: {
    account_type: "expense",
    normal_balance: "debit",
  },
  payroll: {
    account_type: "expense",
    normal_balance: "debit",
  },
  depreciation: {
    account_type: "expense",
    normal_balance: "debit",
  },
  other_expense: {
    account_type: "expense",
    normal_balance: "debit",
  },
} as const;
export const ENTITY_CONTROL_ROLES_V1 = {
  operatingCash: {
    code: "1000",
    account_type: "asset",
    subtype: "cash",
    normal_balance: "debit",
  },
  undepositedFunds: {
    code: "1010",
    account_type: "asset",
    subtype: "undeposited_funds",
    normal_balance: "debit",
  },
  accountsReceivable: {
    code: "1100",
    account_type: "asset",
    subtype: "accounts_receivable",
    normal_balance: "debit",
  },
  retainageReceivable: {
    code: "1110",
    account_type: "asset",
    subtype: "retainage_receivable",
    normal_balance: "debit",
  },
  contractAsset: {
    code: "1150",
    account_type: "asset",
    subtype: "costs_in_excess",
    normal_balance: "debit",
  },
  workInProgress: {
    code: "1160",
    account_type: "asset",
    subtype: "work_in_progress",
    normal_balance: "debit",
  },
  prepaidExpenses: {
    code: "1200",
    account_type: "asset",
    subtype: "prepaid_expenses",
    normal_balance: "debit",
  },
  fixedAssets: {
    code: "1500",
    account_type: "asset",
    subtype: "fixed_assets",
    normal_balance: "debit",
  },
  accumulatedDepreciation: {
    code: "1590",
    account_type: "asset",
    subtype: "accumulated_depreciation",
    normal_balance: "credit",
  },
  accountsPayable: {
    code: "2000",
    account_type: "liability",
    subtype: "accounts_payable",
    normal_balance: "credit",
  },
  retainagePayable: {
    code: "2010",
    account_type: "liability",
    subtype: "retainage_payable",
    normal_balance: "credit",
  },
  creditCards: {
    code: "2100",
    account_type: "liability",
    subtype: "credit_card",
    normal_balance: "credit",
  },
  payrollClearing: {
    code: "2200",
    account_type: "liability",
    subtype: "payroll_clearing",
    normal_balance: "credit",
  },
  employeeReimbursements: {
    code: "2220",
    account_type: "liability",
    subtype: "other_liability",
    normal_balance: "credit",
  },
  payrollDeductions: {
    code: "2230",
    account_type: "liability",
    subtype: "other_liability",
    normal_balance: "credit",
  },
  salesUseTaxPayable: {
    code: "2250",
    account_type: "liability",
    subtype: "sales_use_tax",
    normal_balance: "credit",
  },
  customerDeposits: {
    code: "2300",
    account_type: "liability",
    subtype: "customer_deposits",
    normal_balance: "credit",
  },
  contractLiability: {
    code: "2350",
    account_type: "liability",
    subtype: "billings_in_excess",
    normal_balance: "credit",
  },
  expectedLossReserve: {
    code: "2360",
    account_type: "liability",
    subtype: "expected_contract_loss_reserve",
    normal_balance: "credit",
  },
  currentDebt: {
    code: "2400",
    account_type: "liability",
    subtype: "current_debt",
    normal_balance: "credit",
  },
  longTermDebt: {
    code: "2500",
    account_type: "liability",
    subtype: "long_term_debt",
    normal_balance: "credit",
  },
  ownerEquity: {
    code: "3000",
    account_type: "equity",
    subtype: "owner_equity",
    normal_balance: "credit",
  },
  ownerContributions: {
    code: "3010",
    account_type: "equity",
    subtype: "owner_contributions",
    normal_balance: "credit",
  },
  ownerDistributions: {
    code: "3020",
    account_type: "equity",
    subtype: "owner_distributions",
    normal_balance: "debit",
  },
  retainedEarnings: {
    code: "3100",
    account_type: "equity",
    subtype: "retained_earnings",
    normal_balance: "credit",
  },
  constructionRevenue: {
    code: "4000",
    account_type: "income",
    subtype: "construction_revenue",
    normal_balance: "credit",
  },
  otherRevenue: {
    code: "4900",
    account_type: "income",
    subtype: "other_revenue",
    normal_balance: "credit",
  },
  earlyPayDiscounts: {
    code: "4910",
    account_type: "income",
    subtype: "early_pay_discount",
    normal_balance: "credit",
  },
  paymentFeeRecovery: {
    code: "4920",
    account_type: "income",
    subtype: "payment_fee_recovery",
    normal_balance: "credit",
  },
  jobCosts: {
    code: "5000",
    account_type: "cogs",
    subtype: "job_costs",
    normal_balance: "debit",
  },
  subcontractorCosts: {
    code: "5010",
    account_type: "cogs",
    subtype: "subcontractor_costs",
    normal_balance: "debit",
  },
  materialCosts: {
    code: "5020",
    account_type: "cogs",
    subtype: "material_costs",
    normal_balance: "debit",
  },
  laborCosts: {
    code: "5030",
    account_type: "cogs",
    subtype: "direct_labor",
    normal_balance: "debit",
  },
  equipmentCosts: {
    code: "5040",
    account_type: "cogs",
    subtype: "equipment_costs",
    normal_balance: "debit",
  },
  warrantyCosts: {
    code: "5050",
    account_type: "cogs",
    subtype: "warranty_costs",
    normal_balance: "debit",
  },
  expectedLossExpense: {
    code: "5060",
    account_type: "cogs",
    subtype: "expected_contract_loss_expense",
    normal_balance: "debit",
  },
  rentExpense: {
    code: "6000",
    account_type: "expense",
    subtype: "rent",
    normal_balance: "debit",
  },
  insuranceExpense: {
    code: "6010",
    account_type: "expense",
    subtype: "insurance",
    normal_balance: "debit",
  },
  softwareExpense: {
    code: "6020",
    account_type: "expense",
    subtype: "software",
    normal_balance: "debit",
  },
  professionalFees: {
    code: "6030",
    account_type: "expense",
    subtype: "professional_fees",
    normal_balance: "debit",
  },
  utilitiesExpense: {
    code: "6040",
    account_type: "expense",
    subtype: "utilities",
    normal_balance: "debit",
  },
  bankFees: {
    code: "6050",
    account_type: "expense",
    subtype: "bank_fees",
    normal_balance: "debit",
  },
  interestExpense: {
    code: "6060",
    account_type: "expense",
    subtype: "interest",
    normal_balance: "debit",
  },
  payrollExpense: {
    code: "6070",
    account_type: "expense",
    subtype: "payroll",
    normal_balance: "debit",
  },
  depreciationExpense: {
    code: "6080",
    account_type: "expense",
    subtype: "depreciation",
    normal_balance: "debit",
  },
  badDebtExpense: {
    code: "6090",
    account_type: "expense",
    subtype: "other_expense",
    normal_balance: "debit",
  },
  otherExpense: {
    code: "6900",
    account_type: "expense",
    subtype: "other_expense",
    normal_balance: "debit",
  },
  ownedLand: {
    code: "1120",
    account_type: "asset",
    subtype: "other_asset",
    normal_balance: "debit",
  },
  communityDevelopmentInventory: {
    code: "1130",
    account_type: "asset",
    subtype: "other_asset",
    normal_balance: "debit",
  },
  completedHomeInventory: {
    code: "1170",
    account_type: "asset",
    subtype: "work_in_progress",
    normal_balance: "debit",
  },
  warrantyReserve: {
    code: "2260",
    account_type: "liability",
    subtype: "other_liability",
    normal_balance: "credit",
  },
} as const;

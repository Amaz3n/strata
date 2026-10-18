# Customer billing

Billing remains the organization-wide receivables workspace. New invoice asks for a project, with an explicit **No project — general billing** option. Customer accounts in Directory offer the same choice, scoped to that customer's projects. General invoices require an Arc contact or accounting-provider customer. They use ordinary invoicing without job waivers, retainage, closing statements, or project billing sources. Existing project workflows retain their own policies.

General drafts can be resumed, duplicated, revised, credited, and paid through the same invoice inspector. Organizations with no projects can still open Billing. Recovery copies are scoped to the organization, user, project/general billing, customer, and composition target.

Customer accounts attribute project invoices through the project's client; only invoices without a project use the invoice's explicit customer. This prevents counting a project invoice against two different contacts. General billing appears alongside project balances. Collected amounts use payments less reversals, excluding credit memos and write-offs. A Statement action downloads a PDF of current open invoices and balances; it does not email the customer or deduct unapplied deposits.

Receive payment selects one customer before allocating a receipt across invoices. Customer/company account links preserve their scope. The server verifies each invoice's permission and customer relationship before the atomic allocation command. General invoices participate in this flow.

With Arc Books, Billing → Customer deposits offers deposit requests, application to open invoices, and recording refunds of available manual deposits. Deposit requests use the existing customer-deposit liability posting, not invoice revenue. Applications cannot cross a project-bound deposit's project. The existing invoice inspector retains credit memo and write-off actions.

Record refund is available on received manual invoice payments and available manual customer deposits. It records money already returned outside Arc; it does not initiate a bank transfer or refund a Stripe/QBO payment. Refunding a payment reopens that portion of the invoice, subject to existing credits. Use a credit memo when the charge is also being forgiven. External accounting records are flagged for review because the matching refund still needs to be recorded in that provider.

## Release and verification

Apply `20260921123155_customer_billing_refunds.sql` before releasing the refund buttons. The migration adds a service-only, permission-gated refund command with idempotency, payment locking, and a combined applied/refunded deposit balance guard. It does not alter existing customer balances.

Focused tests: `general-invoices`, `customer-account-billing`, `customer-refunds-service`, `customer-refunds-transaction`, plus the existing invoice/composer/receivables/payment suites. The transaction tests run actual PostgreSQL using an isolated PGlite module supplied through `ARC_PGLITE_MODULE`. Live financial records are not mutated during UI verification.

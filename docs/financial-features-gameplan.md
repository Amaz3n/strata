# Strata Financial Features — LLM-Optimized Execution Plan

**Purpose**: Step-by-step, phase-scoped build script with exact tables, services, actions, jobs, and acceptance criteria. Designed for SWFL custom home builders competing against Procore/Buildertrend at local scale.

**Differentiator Strategy**: Win on simplicity, speed, and builder-specific workflows — not feature count.

---

## Architecture Context

### Stack
- **Frontend**: Next.js 16 (App Router), TypeScript, shadcn/ui, Tailwind CSS
- **Backend**: Supabase (Auth/DB/Storage/Edge Functions)
- **Payments**: Stripe (ACH-first, cards secondary)
- **Pattern**: Server actions → Service layer → Supabase client

### Code Conventions (follow exactly)
```typescript
// Service pattern: lib/services/<module>.ts
export async function createThing(input: ThingInput, orgId?: string) {
  const parsed = thingInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  // ... business logic
  await recordAudit({ orgId: resolvedOrgId, action: "insert", entityType: "thing", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "thing_created", entityType: "thing", entityId: data.id, payload: {} })
  return mapThing(data)
}

// Server action pattern: app/<domain>/actions.ts
"use server"
export async function createThingAction(prevState: unknown, formData: FormData) {
  try {
    const result = await createThing({ ...parseFormData(formData) })
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}
```

### Multi-tenancy Rules
- Every table has `org_id uuid not null references orgs(id)`
- Every query includes `.eq("org_id", resolvedOrgId)`
- RLS enabled on all tables with `is_org_member(org_id)` check
- Service-role client only in trusted server paths

---

## Phase 1: Get Paid Faster (ACH-First Payments)

**Objective**: Collect payments faster than any competitor. ACH-first (lowest fees), instant pay links via SMS, automatic reconciliation.

**Killer Features (Differentiators)**:
1. **One-Tap SMS Payment** — Client receives SMS with amount, taps link, confirms bank, done. No login required.
2. **Instant Bank Verification** — Plaid instant auth, no micro-deposits for 80%+ of banks.
3. **Smart Payment Reminders** — Auto-escalate: email → SMS → call prompt based on days overdue.
4. **Automatic Lien Waiver Generation** — Payment triggers conditional→unconditional waiver flow.
5. **Payment Plans** — Split large invoices into scheduled draws with auto-charge.
6. **Fee Transparency** — Show exact ACH vs card fee before payment; clients choose.

### Phase 1.1: Schema & Foundation

#### 1.1.1 New Tables (Migration)

```sql
-- Add balance_due_cents to invoices if missing
alter table invoices add column if not exists balance_due_cents integer;
alter table invoices add column if not exists tax_rate numeric;

-- Draw schedules (payment plans)
create table if not exists draw_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  contract_id uuid references contracts(id) on delete set null,
  draw_number integer not null,
  title text not null,
  description text,
  amount_cents integer not null check (amount_cents >= 0),
  percent_of_contract numeric,
  due_date date,
  due_trigger text, -- 'date', 'milestone', 'approval'
  milestone_id uuid references schedule_items(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'invoiced', 'partial', 'paid')),
  invoiced_at timestamptz,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index draw_schedules_org_idx on draw_schedules (org_id);
create index draw_schedules_project_idx on draw_schedules (project_id);
create index draw_schedules_status_idx on draw_schedules (status);
create unique index draw_schedules_project_number_idx on draw_schedules (project_id, draw_number);
alter table draw_schedules enable row level security;
create policy "draw_schedules_access" on draw_schedules for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger draw_schedules_set_updated_at before update on draw_schedules for each row execute function public.tg_set_updated_at();

-- Lien waivers
create table if not exists lien_waivers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  payment_id uuid references payments(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  waiver_type text not null check (waiver_type in ('conditional', 'unconditional', 'final')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'signed', 'rejected', 'expired')),
  amount_cents integer not null check (amount_cents >= 0),
  through_date date not null,
  claimant_name text not null,
  property_description text,
  document_file_id uuid references files(id) on delete set null,
  signed_file_id uuid references files(id) on delete set null,
  signature_data jsonb, -- { signature_svg, signed_at, signer_name, signer_ip }
  sent_at timestamptz,
  signed_at timestamptz,
  expires_at timestamptz,
  token_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lien_waivers_org_idx on lien_waivers (org_id);
create index lien_waivers_project_idx on lien_waivers (project_id);
create index lien_waivers_payment_idx on lien_waivers (payment_id);
create index lien_waivers_status_idx on lien_waivers (status);
create unique index lien_waivers_token_idx on lien_waivers (token_hash) where token_hash is not null;
alter table lien_waivers enable row level security;
create policy "lien_waivers_access" on lien_waivers for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger lien_waivers_set_updated_at before update on lien_waivers for each row execute function public.tg_set_updated_at();

-- Payment schedules (auto-charge recurring)
create table if not exists payment_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  payment_method_id uuid references payment_methods(id) on delete set null,
  total_amount_cents integer not null check (total_amount_cents > 0),
  installment_amount_cents integer not null check (installment_amount_cents > 0),
  installments_total integer not null check (installments_total > 0),
  installments_paid integer not null default 0,
  frequency text not null default 'monthly' check (frequency in ('weekly', 'biweekly', 'monthly')),
  next_charge_date date,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'canceled', 'failed')),
  auto_charge boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payment_schedules_org_idx on payment_schedules (org_id);
create index payment_schedules_next_charge_idx on payment_schedules (next_charge_date) where status = 'active';
alter table payment_schedules enable row level security;
create policy "payment_schedules_access" on payment_schedules for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger payment_schedules_set_updated_at before update on payment_schedules for each row execute function public.tg_set_updated_at();

-- Reminder delivery tracking
create table if not exists reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  reminder_id uuid not null references reminders(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  channel text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed', 'clicked')),
  sent_at timestamptz,
  delivered_at timestamptz,
  clicked_at timestamptz,
  error_message text,
  provider_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index reminder_deliveries_org_idx on reminder_deliveries (org_id);
create index reminder_deliveries_invoice_idx on reminder_deliveries (invoice_id);
create unique index reminder_deliveries_unique_idx on reminder_deliveries (reminder_id, invoice_id, channel, date(created_at));
alter table reminder_deliveries enable row level security;
create policy "reminder_deliveries_access" on reminder_deliveries for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Late fee applications (tracking each application)
create table if not exists late_fee_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  late_fee_rule_id uuid not null references late_fees(id) on delete cascade,
  invoice_line_id uuid references invoice_lines(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  applied_at timestamptz not null default now(),
  application_number integer not null,
  metadata jsonb not null default '{}'::jsonb
);

create index late_fee_applications_org_idx on late_fee_applications (org_id);
create index late_fee_applications_invoice_idx on late_fee_applications (invoice_id);
create unique index late_fee_applications_unique_idx on late_fee_applications (invoice_id, late_fee_rule_id, application_number);
alter table late_fee_applications enable row level security;
create policy "late_fee_applications_access" on late_fee_applications for all using (auth.role() = 'service_role' or is_org_member(org_id));
```

#### 1.1.2 Types (lib/types.ts additions)

```typescript
export interface DrawSchedule {
  id: string
  org_id: string
  project_id: string
  invoice_id?: string | null
  contract_id?: string | null
  draw_number: number
  title: string
  description?: string | null
  amount_cents: number
  percent_of_contract?: number | null
  due_date?: string | null
  due_trigger?: 'date' | 'milestone' | 'approval' | null
  milestone_id?: string | null
  status: 'pending' | 'invoiced' | 'partial' | 'paid'
  invoiced_at?: string | null
  paid_at?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface LienWaiver {
  id: string
  org_id: string
  project_id: string
  payment_id?: string | null
  company_id?: string | null
  contact_id?: string | null
  waiver_type: 'conditional' | 'unconditional' | 'final'
  status: 'pending' | 'sent' | 'signed' | 'rejected' | 'expired'
  amount_cents: number
  through_date: string
  claimant_name: string
  property_description?: string | null
  document_file_id?: string | null
  signed_file_id?: string | null
  signature_data?: {
    signature_svg?: string
    signed_at?: string
    signer_name?: string
    signer_ip?: string
  }
  sent_at?: string | null
  signed_at?: string | null
  expires_at?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface PaymentSchedule {
  id: string
  org_id: string
  project_id: string
  contact_id?: string | null
  payment_method_id?: string | null
  total_amount_cents: number
  installment_amount_cents: number
  installments_total: number
  installments_paid: number
  frequency: 'weekly' | 'biweekly' | 'monthly'
  next_charge_date?: string | null
  status: 'active' | 'paused' | 'completed' | 'canceled' | 'failed'
  auto_charge: boolean
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface ReminderDelivery {
  id: string
  org_id: string
  reminder_id: string
  invoice_id: string
  channel: 'email' | 'sms'
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'clicked'
  sent_at?: string | null
  delivered_at?: string | null
  clicked_at?: string | null
  error_message?: string | null
  provider_message_id?: string | null
  metadata?: Record<string, any>
  created_at?: string
}
```

### Phase 1.2: Stripe Integration (Real Implementation)

#### 1.2.1 Stripe Adapter (lib/integrations/payments/stripe.ts)

```typescript
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia',
})

export interface CreateStripeIntentParams {
  amount_cents: number
  currency: string
  invoice_id: string
  org_id: string
  project_id?: string | null
  description?: string
  customer_id?: string
  payment_method_types?: string[]
  metadata?: Record<string, string>
}

export interface StripeIntentResult {
  provider_intent_id: string
  client_secret: string
  status: string
}

export async function createStripePaymentIntent(params: CreateStripeIntentParams): Promise<StripeIntentResult> {
  const paymentMethodTypes = params.payment_method_types ?? ['us_bank_account', 'card']

  const intent = await stripe.paymentIntents.create({
    amount: params.amount_cents,
    currency: params.currency,
    payment_method_types: paymentMethodTypes,
    description: params.description,
    customer: params.customer_id,
    metadata: {
      org_id: params.org_id,
      project_id: params.project_id ?? '',
      invoice_id: params.invoice_id,
      ...params.metadata,
    },
    // ACH-specific options for faster settlement
    payment_method_options: {
      us_bank_account: {
        financial_connections: {
          permissions: ['payment_method', 'balances'],
        },
        verification_method: 'instant', // Use Plaid instant verification
      },
    },
  })

  return {
    provider_intent_id: intent.id,
    client_secret: intent.client_secret!,
    status: intent.status,
  }
}

export async function retrieveStripePaymentIntent(intentId: string) {
  return stripe.paymentIntents.retrieve(intentId)
}

export async function createStripeCustomer(params: {
  email: string
  name: string
  metadata?: Record<string, string>
}) {
  return stripe.customers.create({
    email: params.email,
    name: params.name,
    metadata: params.metadata,
  })
}

export async function attachPaymentMethod(customerId: string, paymentMethodId: string) {
  return stripe.paymentMethods.attach(paymentMethodId, { customer: customerId })
}

export function constructWebhookEvent(payload: string, signature: string) {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  )
}

export function mapStripeEventToDomain(event: Stripe.Event) {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent
      return {
        type: 'payment_succeeded',
        provider_payment_id: intent.id,
        amount_cents: intent.amount,
        currency: intent.currency,
        method: mapPaymentMethodType(intent.payment_method_types[0]),
        fee_cents: 0, // Calculate from balance transaction
        metadata: intent.metadata,
        invoice_id: intent.metadata.invoice_id,
        org_id: intent.metadata.org_id,
      }
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent
      return {
        type: 'payment_failed',
        provider_payment_id: intent.id,
        error: intent.last_payment_error?.message,
        metadata: intent.metadata,
      }
    }
    case 'charge.succeeded': {
      const charge = event.data.object as Stripe.Charge
      return {
        type: 'charge_succeeded',
        provider_payment_id: charge.payment_intent as string,
        provider_charge_id: charge.id,
        fee_cents: charge.balance_transaction ? 0 : 0, // Fetch separately
        receipt_url: charge.receipt_url,
      }
    }
    default:
      return null
  }
}

function mapPaymentMethodType(stripeType: string): string {
  switch (stripeType) {
    case 'us_bank_account': return 'ach'
    case 'card': return 'card'
    default: return stripeType
  }
}

// Calculate platform fee (pass-through + margin)
export function calculateFees(amount_cents: number, method: 'ach' | 'card') {
  if (method === 'ach') {
    // ACH: 0.8% capped at $5 (Stripe) + $0.50 platform fee
    const stripeFee = Math.min(Math.round(amount_cents * 0.008), 500)
    const platformFee = 50
    return { stripe_fee: stripeFee, platform_fee: platformFee, total_fee: stripeFee + platformFee }
  } else {
    // Card: 2.9% + $0.30 (Stripe) + 0.5% platform fee
    const stripeFee = Math.round(amount_cents * 0.029) + 30
    const platformFee = Math.round(amount_cents * 0.005)
    return { stripe_fee: stripeFee, platform_fee: platformFee, total_fee: stripeFee + platformFee }
  }
}
```

#### 1.2.2 Webhook Handler (app/api/webhooks/stripe/route.ts)

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { constructWebhookEvent, mapStripeEventToDomain } from '@/lib/integrations/payments/stripe'
import { recordPayment } from '@/lib/services/payments'
import { createServiceSupabaseClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const payload = await request.text()
  const signature = request.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  let event
  try {
    event = constructWebhookEvent(payload, signature)
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const domainEvent = mapStripeEventToDomain(event)
  if (!domainEvent) {
    // Unhandled event type, acknowledge receipt
    return NextResponse.json({ received: true })
  }

  const supabase = createServiceSupabaseClient()

  try {
    if (domainEvent.type === 'payment_succeeded') {
      // Idempotency check
      const { data: existing } = await supabase
        .from('payments')
        .select('id')
        .eq('provider_payment_id', domainEvent.provider_payment_id)
        .maybeSingle()

      if (!existing) {
        await recordPayment({
          invoice_id: domainEvent.invoice_id,
          amount_cents: domainEvent.amount_cents,
          currency: domainEvent.currency,
          method: domainEvent.method,
          provider: 'stripe',
          provider_payment_id: domainEvent.provider_payment_id,
          status: 'succeeded',
          fee_cents: domainEvent.fee_cents,
          idempotency_key: domainEvent.provider_payment_id,
        }, domainEvent.org_id)

        // Trigger post-payment workflows via outbox
        await supabase.from('outbox').insert({
          org_id: domainEvent.org_id,
          job_type: 'payment_succeeded',
          payload: domainEvent,
        })
      }
    }

    if (domainEvent.type === 'payment_failed') {
      await supabase.from('payment_intents')
        .update({ status: 'failed' })
        .eq('provider_intent_id', domainEvent.provider_payment_id)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Webhook processing error:', error)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
```

### Phase 1.3: HMAC-Signed Pay Links

**Why**: Random tokens can be guessed/brute-forced. HMAC ensures link contains tamper-proof payload.

#### 1.3.1 Signed Link Utilities (lib/services/payments.ts additions)

```typescript
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

const LINK_SECRET = process.env.PAYMENT_LINK_SECRET!

interface PayLinkPayload {
  org_id: string
  project_id: string
  invoice_id: string
  exp: number // Unix timestamp
  nonce: string
}

export function generateSignedPayLink(params: {
  orgId: string
  projectId: string
  invoiceId: string
  expiresInHours?: number
}): { url: string; token: string } {
  const nonce = randomBytes(16).toString('hex')
  const exp = Math.floor(Date.now() / 1000) + (params.expiresInHours ?? 72) * 3600

  const payload: PayLinkPayload = {
    org_id: params.orgId,
    project_id: params.projectId,
    invoice_id: params.invoiceId,
    exp,
    nonce,
  }

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', LINK_SECRET).update(payloadStr).digest('base64url')
  const token = `${payloadStr}.${signature}`

  const url = `${process.env.NEXT_PUBLIC_APP_URL}/p/pay/${token}`
  return { url, token }
}

export function validateSignedPayLink(token: string): PayLinkPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payloadStr, signature] = parts

  // Verify signature
  const expectedSig = createHmac('sha256', LINK_SECRET).update(payloadStr).digest('base64url')
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return null
  }

  // Decode payload
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as PayLinkPayload

    // Check expiration
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

// Rotate nonce after successful payment (prevents replay)
export async function rotatePayLinkNonce(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const newNonce = randomBytes(16).toString('hex')

  await supabase
    .from('payment_links')
    .update({ nonce: newNonce, used_count: supabase.rpc('increment', { x: 1 }) })
    .eq('invoice_id', invoiceId)
    .eq('org_id', orgId)
}
```

### Phase 1.4: Lien Waiver Automation

**Killer Feature**: Payment triggers automatic lien waiver generation and sends for signature.

#### 1.4.1 Lien Waiver Service (lib/services/lien-waivers.ts)

```typescript
import { z } from 'zod'
import { requireOrgContext } from '@/lib/services/context'
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { recordAudit } from '@/lib/services/audit'
import { recordEvent } from '@/lib/services/events'
import { createHmac, randomBytes } from 'crypto'

const createLienWaiverSchema = z.object({
  project_id: z.string().uuid(),
  payment_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  waiver_type: z.enum(['conditional', 'unconditional', 'final']),
  amount_cents: z.number().int().min(0),
  through_date: z.string(),
  claimant_name: z.string().min(1),
  property_description: z.string().optional(),
})

export async function createLienWaiver(input: z.infer<typeof createLienWaiverSchema>, orgId?: string) {
  const parsed = createLienWaiverSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const token = randomBytes(32).toString('hex')
  const tokenHash = createHmac('sha256', process.env.LIEN_WAIVER_SECRET!).update(token).digest('hex')

  const { data, error } = await supabase
    .from('lien_waivers')
    .insert({
      org_id: resolvedOrgId,
      ...parsed,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create lien waiver: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    action: 'insert',
    entityType: 'lien_waiver',
    entityId: data.id,
    after: data,
  })

  return { waiver: data, signatureUrl: `${process.env.NEXT_PUBLIC_APP_URL}/sign/lien-waiver/${token}` }
}

export async function signLienWaiver(token: string, signatureData: {
  signature_svg: string
  signer_name: string
  signer_ip?: string
}) {
  const supabase = createServiceSupabaseClient()
  const tokenHash = createHmac('sha256', process.env.LIEN_WAIVER_SECRET!).update(token).digest('hex')

  const { data: waiver, error: findError } = await supabase
    .from('lien_waivers')
    .select('*')
    .eq('token_hash', tokenHash)
    .eq('status', 'sent')
    .maybeSingle()

  if (findError || !waiver) {
    throw new Error('Lien waiver not found or already signed')
  }

  if (waiver.expires_at && new Date(waiver.expires_at) < new Date()) {
    throw new Error('Lien waiver has expired')
  }

  const { data, error } = await supabase
    .from('lien_waivers')
    .update({
      status: 'signed',
      signed_at: new Date().toISOString(),
      signature_data: {
        ...signatureData,
        signed_at: new Date().toISOString(),
      },
    })
    .eq('id', waiver.id)
    .select('*')
    .single()

  if (error) {
    throw new Error(`Failed to sign lien waiver: ${error.message}`)
  }

  await recordEvent({
    orgId: waiver.org_id,
    eventType: 'lien_waiver_signed',
    entityType: 'lien_waiver',
    entityId: waiver.id,
    payload: { claimant_name: waiver.claimant_name, amount_cents: waiver.amount_cents },
  })

  return data
}

// Auto-generate conditional waiver when payment is recorded
export async function generateConditionalWaiverForPayment(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  const { data: payment } = await supabase
    .from('payments')
    .select('*, invoice:invoices(project_id, project:projects(name, location))')
    .eq('id', paymentId)
    .eq('org_id', orgId)
    .single()

  if (!payment?.invoice?.project_id) return null

  // Find vendor/sub associated with this payment (if applicable)
  // For client payments, skip waiver generation

  return createLienWaiver({
    project_id: payment.invoice.project_id,
    payment_id: paymentId,
    waiver_type: 'conditional',
    amount_cents: payment.amount_cents,
    through_date: new Date().toISOString().split('T')[0],
    claimant_name: 'TBD', // Will be set when sending
    property_description: payment.invoice.project?.location?.formatted,
  }, orgId)
}

// Convert conditional to unconditional when payment clears
export async function convertToUnconditionalWaiver(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  const { data: conditionalWaiver } = await supabase
    .from('lien_waivers')
    .select('*')
    .eq('payment_id', paymentId)
    .eq('org_id', orgId)
    .eq('waiver_type', 'conditional')
    .eq('status', 'signed')
    .maybeSingle()

  if (!conditionalWaiver) return null

  // Create unconditional waiver
  return createLienWaiver({
    project_id: conditionalWaiver.project_id,
    payment_id: paymentId,
    company_id: conditionalWaiver.company_id,
    contact_id: conditionalWaiver.contact_id,
    waiver_type: 'unconditional',
    amount_cents: conditionalWaiver.amount_cents,
    through_date: conditionalWaiver.through_date,
    claimant_name: conditionalWaiver.claimant_name,
    property_description: conditionalWaiver.property_description,
  }, orgId)
}
```

### Phase 1.5: Smart Reminders & Late Fees

#### 1.5.1 Reminder Job (app/api/jobs/reminders/route.ts)

```typescript
import { NextResponse } from 'next/server'
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { sendReminderEmail, sendReminderSMS } from '@/lib/services/mailer'

export async function POST() {
  const supabase = createServiceSupabaseClient()

  // Find all due reminders that haven't been sent today
  const { data: reminders, error } = await supabase
    .from('reminders')
    .select(`
      id, org_id, invoice_id, channel, schedule, offset_days, template_id,
      invoice:invoices(
        id, org_id, project_id, invoice_number, status, due_date,
        balance_due_cents, total_cents,
        recipient:contacts(id, full_name, email, phone)
      )
    `)
    .not('invoice.status', 'in', '("paid","void")')

  if (error || !reminders) {
    return NextResponse.json({ error: error?.message }, { status: 500 })
  }

  const now = new Date()
  const today = now.toISOString().split('T')[0]

  for (const reminder of reminders) {
    if (!reminder.invoice?.due_date || !reminder.invoice?.balance_due_cents) continue

    const dueDate = new Date(reminder.invoice.due_date)
    const daysDiff = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const daysOverdue = -daysDiff

    let shouldSend = false
    if (reminder.schedule === 'before_due' && daysDiff === reminder.offset_days) {
      shouldSend = true
    } else if (reminder.schedule === 'after_due' && daysOverdue === reminder.offset_days) {
      shouldSend = true
    } else if (reminder.schedule === 'overdue' && daysOverdue >= reminder.offset_days && daysOverdue % 7 === 0) {
      // Weekly overdue reminders
      shouldSend = true
    }

    if (!shouldSend) continue

    // Check if already sent today
    const { data: existing } = await supabase
      .from('reminder_deliveries')
      .select('id')
      .eq('reminder_id', reminder.id)
      .eq('invoice_id', reminder.invoice.id)
      .eq('channel', reminder.channel)
      .gte('created_at', `${today}T00:00:00Z`)
      .maybeSingle()

    if (existing) continue

    // Send reminder
    try {
      let providerMessageId: string | undefined

      if (reminder.channel === 'email' && reminder.invoice.recipient?.email) {
        providerMessageId = await sendReminderEmail({
          to: reminder.invoice.recipient.email,
          recipientName: reminder.invoice.recipient.full_name,
          invoiceNumber: reminder.invoice.invoice_number,
          amountDue: reminder.invoice.balance_due_cents,
          dueDate: reminder.invoice.due_date,
          daysOverdue: daysOverdue > 0 ? daysOverdue : undefined,
          payLink: `${process.env.NEXT_PUBLIC_APP_URL}/p/pay/${reminder.invoice.id}`, // TODO: use signed link
        })
      } else if (reminder.channel === 'sms' && reminder.invoice.recipient?.phone) {
        providerMessageId = await sendReminderSMS({
          to: reminder.invoice.recipient.phone,
          message: `Payment reminder: Invoice #${reminder.invoice.invoice_number} for $${(reminder.invoice.balance_due_cents / 100).toFixed(2)} is ${daysOverdue > 0 ? `${daysOverdue} days overdue` : `due ${reminder.invoice.due_date}`}. Pay now: [link]`,
        })
      }

      // Record delivery
      await supabase.from('reminder_deliveries').insert({
        org_id: reminder.org_id,
        reminder_id: reminder.id,
        invoice_id: reminder.invoice.id,
        channel: reminder.channel,
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_message_id: providerMessageId,
      })
    } catch (err) {
      await supabase.from('reminder_deliveries').insert({
        org_id: reminder.org_id,
        reminder_id: reminder.id,
        invoice_id: reminder.invoice.id,
        channel: reminder.channel,
        status: 'failed',
        error_message: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return NextResponse.json({ processed: reminders.length })
}
```

#### 1.5.2 Late Fee Job (app/api/jobs/late-fees/route.ts)

```typescript
import { NextResponse } from 'next/server'
import { createServiceSupabaseClient } from '@/lib/supabase/server'

export async function POST() {
  const supabase = createServiceSupabaseClient()

  // Find all late fee rules
  const { data: rules, error: rulesError } = await supabase
    .from('late_fees')
    .select('*')

  if (rulesError || !rules) {
    return NextResponse.json({ error: rulesError?.message }, { status: 500 })
  }

  const now = new Date()
  let applied = 0

  for (const rule of rules) {
    // Find overdue invoices for this org/project
    let query = supabase
      .from('invoices')
      .select('id, org_id, project_id, due_date, balance_due_cents, total_cents')
      .eq('org_id', rule.org_id)
      .in('status', ['sent', 'overdue'])
      .gt('balance_due_cents', 0)
      .lt('due_date', now.toISOString().split('T')[0])

    if (rule.project_id) {
      query = query.eq('project_id', rule.project_id)
    }

    const { data: invoices } = await query

    for (const invoice of invoices ?? []) {
      const dueDate = new Date(invoice.due_date!)
      const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))

      // Check grace period
      if (daysOverdue <= (rule.grace_days ?? 0)) continue

      // Count existing applications
      const { count } = await supabase
        .from('late_fee_applications')
        .select('id', { count: 'exact', head: true })
        .eq('invoice_id', invoice.id)
        .eq('late_fee_rule_id', rule.id)

      const applicationCount = count ?? 0

      // Check max applications
      if (rule.max_applications && applicationCount >= rule.max_applications) continue

      // Check repeat interval
      if (applicationCount > 0 && rule.repeat_days) {
        const { data: lastApplication } = await supabase
          .from('late_fee_applications')
          .select('applied_at')
          .eq('invoice_id', invoice.id)
          .eq('late_fee_rule_id', rule.id)
          .order('applied_at', { ascending: false })
          .limit(1)
          .single()

        if (lastApplication) {
          const daysSinceLast = Math.floor(
            (now.getTime() - new Date(lastApplication.applied_at).getTime()) / (1000 * 60 * 60 * 24)
          )
          if (daysSinceLast < rule.repeat_days) continue
        }
      }

      // Calculate fee amount
      let feeAmountCents: number
      if (rule.strategy === 'fixed') {
        feeAmountCents = rule.amount_cents ?? 0
      } else {
        feeAmountCents = Math.round((invoice.balance_due_cents ?? 0) * ((rule.percent_rate ?? 0) / 100))
      }

      if (feeAmountCents <= 0) continue

      // Add late fee as invoice line
      const { data: newLine, error: lineError } = await supabase
        .from('invoice_lines')
        .insert({
          org_id: invoice.org_id,
          invoice_id: invoice.id,
          description: `Late Fee (${daysOverdue} days overdue)`,
          quantity: 1,
          unit_price_cents: feeAmountCents,
          taxable: false,
          metadata: { late_fee_rule_id: rule.id, days_overdue: daysOverdue },
        })
        .select('id')
        .single()

      if (lineError) continue

      // Record application
      await supabase.from('late_fee_applications').insert({
        org_id: invoice.org_id,
        invoice_id: invoice.id,
        late_fee_rule_id: rule.id,
        invoice_line_id: newLine.id,
        amount_cents: feeAmountCents,
        application_number: applicationCount + 1,
      })

      // Recalculate invoice totals
      const { data: lines } = await supabase
        .from('invoice_lines')
        .select('quantity, unit_price_cents')
        .eq('invoice_id', invoice.id)

      const newTotal = (lines ?? []).reduce(
        (sum, line) => sum + (line.quantity ?? 1) * (line.unit_price_cents ?? 0),
        0
      )

      await supabase
        .from('invoices')
        .update({
          total_cents: newTotal,
          balance_due_cents: newTotal - ((invoice.total_cents ?? 0) - (invoice.balance_due_cents ?? 0)),
          status: 'overdue',
        })
        .eq('id', invoice.id)

      applied++
    }
  }

  return NextResponse.json({ applied })
}
```

### Phase 1.6: Payment Portal UI

#### 1.6.1 Pay Page (app/p/pay/[token]/page.tsx)

```typescript
import { validateSignedPayLink } from '@/lib/services/payments'
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { PaymentClient } from './payment-client'

export default async function PayPage({ params }: { params: { token: string } }) {
  const payload = validateSignedPayLink(params.token)
  if (!payload) {
    notFound()
  }

  const supabase = createServiceSupabaseClient()

  const { data: invoice } = await supabase
    .from('invoices')
    .select(`
      id, org_id, project_id, invoice_number, title, status,
      issue_date, due_date, notes, subtotal_cents, tax_cents,
      total_cents, balance_due_cents,
      project:projects(name),
      org:orgs(name, logo_url),
      lines:invoice_lines(id, description, quantity, unit, unit_price_cents, taxable)
    `)
    .eq('id', payload.invoice_id)
    .eq('org_id', payload.org_id)
    .single()

  if (!invoice) {
    notFound()
  }

  // Check if already paid
  if (invoice.status === 'paid' || (invoice.balance_due_cents ?? 0) <= 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-6xl mb-4">✓</div>
          <h1 className="text-2xl font-bold text-green-600">Invoice Paid</h1>
          <p className="text-gray-600 mt-2">Thank you for your payment!</p>
        </div>
      </div>
    )
  }

  return (
    <PaymentClient
      invoice={invoice}
      token={params.token}
      orgName={invoice.org?.name ?? 'Your Builder'}
    />
  )
}
```

#### 1.6.2 Payment Client Component (app/p/pay/[token]/payment-client.tsx)

```typescript
'use client'

import { useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { formatCurrency } from '@/lib/utils'
import { createPaymentIntentAction } from './actions'

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

interface PaymentClientProps {
  invoice: {
    id: string
    invoice_number: string
    title: string
    balance_due_cents: number
    total_cents: number
    due_date?: string
    lines: Array<{
      description: string
      quantity: number
      unit_price_cents: number
    }>
  }
  token: string
  orgName: string
}

export function PaymentClient({ invoice, token, orgName }: PaymentClientProps) {
  const [paymentMethod, setPaymentMethod] = useState<'ach' | 'card'>('ach')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [isCreatingIntent, setIsCreatingIntent] = useState(false)

  // Calculate fees for display
  const achFee = Math.min(Math.round(invoice.balance_due_cents * 0.008), 500) + 50
  const cardFee = Math.round(invoice.balance_due_cents * 0.034) + 30

  const handleContinue = async () => {
    setIsCreatingIntent(true)
    try {
      const result = await createPaymentIntentAction({
        token,
        method: paymentMethod,
      })

      if (result.success && result.clientSecret) {
        setClientSecret(result.clientSecret)
      } else {
        alert(result.error ?? 'Failed to initialize payment')
      }
    } finally {
      setIsCreatingIntent(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">{orgName}</h1>
          <p className="text-gray-600">Invoice #{invoice.invoice_number}</p>
        </div>

        {/* Invoice Summary */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">Invoice Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {invoice.lines.map((line, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-gray-600">{line.description}</span>
                  <span>{formatCurrency(line.quantity * line.unit_price_cents)}</span>
                </div>
              ))}
              <div className="border-t pt-2 mt-2">
                <div className="flex justify-between font-semibold">
                  <span>Amount Due</span>
                  <span className="text-xl">{formatCurrency(invoice.balance_due_cents)}</span>
                </div>
                {invoice.due_date && (
                  <p className="text-sm text-gray-500 mt-1">
                    Due: {new Date(invoice.due_date).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payment Method Selection */}
        {!clientSecret && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-lg">Payment Method</CardTitle>
            </CardHeader>
            <CardContent>
              <RadioGroup value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as 'ach' | 'card')}>
                <div className="flex items-center space-x-2 p-4 border rounded-lg mb-2 cursor-pointer hover:bg-gray-50">
                  <RadioGroupItem value="ach" id="ach" />
                  <Label htmlFor="ach" className="flex-1 cursor-pointer">
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-medium">Bank Transfer (ACH)</div>
                        <div className="text-sm text-gray-500">Lowest fees, 2-3 business days</div>
                      </div>
                      <div className="text-sm text-green-600">+{formatCurrency(achFee)} fee</div>
                    </div>
                  </Label>
                </div>
                <div className="flex items-center space-x-2 p-4 border rounded-lg cursor-pointer hover:bg-gray-50">
                  <RadioGroupItem value="card" id="card" />
                  <Label htmlFor="card" className="flex-1 cursor-pointer">
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-medium">Credit/Debit Card</div>
                        <div className="text-sm text-gray-500">Instant processing</div>
                      </div>
                      <div className="text-sm text-orange-600">+{formatCurrency(cardFee)} fee</div>
                    </div>
                  </Label>
                </div>
              </RadioGroup>

              <Button
                onClick={handleContinue}
                disabled={isCreatingIntent}
                className="w-full mt-4"
                size="lg"
              >
                {isCreatingIntent ? 'Initializing...' : `Pay ${formatCurrency(invoice.balance_due_cents + (paymentMethod === 'ach' ? achFee : cardFee))}`}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Stripe Payment Form */}
        {clientSecret && (
          <Card>
            <CardContent className="pt-6">
              <Elements stripe={stripePromise} options={{ clientSecret }}>
                <PaymentForm
                  amount={invoice.balance_due_cents + (paymentMethod === 'ach' ? achFee : cardFee)}
                  onCancel={() => setClientSecret(null)}
                />
              </Elements>
            </CardContent>
          </Card>
        )}

        {/* Security Footer */}
        <div className="text-center text-sm text-gray-500 mt-8">
          <p>🔒 Secured by Stripe</p>
          <p className="mt-1">Your payment information is encrypted and secure.</p>
        </div>
      </div>
    </div>
  )
}

function PaymentForm({ amount, onCancel }: { amount: number; onCancel: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setIsProcessing(true)
    setError(null)

    const { error: submitError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/p/pay/success`,
      },
    })

    if (submitError) {
      setError(submitError.message ?? 'Payment failed')
      setIsProcessing(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
      <div className="flex gap-2 mt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isProcessing}>
          Back
        </Button>
        <Button type="submit" disabled={!stripe || isProcessing} className="flex-1">
          {isProcessing ? 'Processing...' : `Pay ${formatCurrency(amount)}`}
        </Button>
      </div>
    </form>
  )
}
```

### Phase 1 Acceptance Criteria

```markdown
## Phase 1 Acceptance Tests

### P1.1 Pay Link Flow
- [x] Builder generates pay link for invoice → receives signed URL
- [x] Client clicks link → sees invoice summary with line items
- [ ] Client selects ACH → sees fee ($0.50 + 0.8% capped at $5)
- [ ] Client selects Card → sees fee (3.4%)
- [ ] Client completes payment → invoice balance_due_cents = 0, status = 'paid'
- [x] Webhook receives event → payment row created with provider_payment_id
- [x] Duplicate webhook → no duplicate payment (idempotency)
- [ ] Expired link → shows error page

### P1.2 Reminders
- [ ] Invoice 3 days before due → email sent (if rule exists)
- [ ] Invoice 1 day overdue → SMS sent (if rule exists)
- [ ] Invoice 7 days overdue → weekly reminder sent
- [ ] Duplicate reminders → blocked (same day dedup)
- [ ] Paid invoice → no reminders sent

### P1.3 Late Fees
- [ ] Invoice 15 days overdue with 10-day grace → late fee line added
- [ ] Fixed fee rule → exact amount added
- [ ] Percent fee rule → calculated correctly
- [ ] Max applications = 3 → only 3 fees applied
- [ ] Repeat days = 30 → fee applied monthly

### P1.4 Lien Waivers
- [x] Payment succeeded → conditional waiver generated
- [ ] Waiver sent to sub → receives signature link
- [ ] Sub signs waiver → status = 'signed', signature_data populated
- [x] Payment clears (after 5 days) → unconditional waiver generated
- [x] Expired waiver link → shows error
```

---

## Phase 2: Budgets, Cost Codes & Variance

**Objective**: Give builders real-time visibility into project financials. Know if you're making money before it's too late.

**Killer Features (Differentiators)**:
1. **One-Page Budget Dashboard** — Not 17 clicks deep like Procore. See budget vs actual on project page.
2. **Variance Alerts** — SMS/email when cost code exceeds threshold (10%, 25%, 50%).
3. **Cost Code Templates** — Pre-built for residential (NAHB), commercial (CSI). Import from Excel.
4. **Change Order Impact** — Approved COs auto-update budget. See margin impact before approval.
5. **Profit Margin Tracker** — Real-time gross margin on dashboard. Green/yellow/red status.
6. **Client Budget View** — Optional transparency mode for cost-plus contracts.

### Phase 2.1: Schema

```sql
-- Cost code library enhancements
alter table cost_codes add column if not exists division text;
alter table cost_codes add column if not exists standard text; -- 'nahb', 'csi', 'custom'
alter table cost_codes add column if not exists unit text;
alter table cost_codes add column if not exists default_unit_cost_cents integer;
alter table cost_codes add column if not exists is_active boolean default true;

-- Budget snapshots for trend tracking
create table if not exists budget_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  budget_id uuid not null references budgets(id) on delete cascade,
  snapshot_date date not null,
  total_budget_cents integer not null,
  total_committed_cents integer not null,
  total_actual_cents integer not null,
  total_invoiced_cents integer not null,
  variance_cents integer not null,
  margin_percent numeric,
  by_cost_code jsonb not null default '[]'::jsonb, -- [{code, budget, committed, actual, variance}]
  created_at timestamptz not null default now()
);

create index budget_snapshots_org_idx on budget_snapshots (org_id);
create index budget_snapshots_project_date_idx on budget_snapshots (project_id, snapshot_date);
create unique index budget_snapshots_unique_idx on budget_snapshots (budget_id, snapshot_date);
alter table budget_snapshots enable row level security;
create policy "budget_snapshots_access" on budget_snapshots for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Variance alerts
create table if not exists variance_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  budget_id uuid references budgets(id) on delete set null,
  cost_code_id uuid references cost_codes(id) on delete set null,
  alert_type text not null check (alert_type in ('threshold_exceeded', 'over_budget', 'margin_warning')),
  threshold_percent integer,
  current_percent integer,
  budget_cents integer,
  actual_cents integer,
  variance_cents integer,
  status text not null default 'active' check (status in ('active', 'acknowledged', 'resolved')),
  acknowledged_by uuid references app_users(id),
  acknowledged_at timestamptz,
  notified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index variance_alerts_org_idx on variance_alerts (org_id);
create index variance_alerts_project_idx on variance_alerts (project_id);
create index variance_alerts_status_idx on variance_alerts (status) where status = 'active';
alter table variance_alerts enable row level security;
create policy "variance_alerts_access" on variance_alerts for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Add cost_code_id to financial line tables
alter table invoice_lines add column if not exists cost_code_id uuid references cost_codes(id);
alter table change_order_lines add column if not exists cost_code_id uuid references cost_codes(id);
alter table commitment_lines add column if not exists cost_code_id uuid references cost_codes(id);
alter table bill_lines add column if not exists cost_code_id uuid references cost_codes(id);

create index if not exists invoice_lines_cost_code_idx on invoice_lines (cost_code_id);
create index if not exists change_order_lines_cost_code_idx on change_order_lines (cost_code_id);
create index if not exists commitment_lines_cost_code_idx on commitment_lines (cost_code_id);
create index if not exists bill_lines_cost_code_idx on bill_lines (cost_code_id);
```

### Phase 2.2: Cost Code Service (lib/services/cost-codes.ts)

```typescript
import { z } from 'zod'
import { requireOrgContext } from '@/lib/services/context'
import { recordAudit } from '@/lib/services/audit'

const costCodeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  parent_id: z.string().uuid().optional(),
  division: z.string().optional(),
  category: z.string().optional(),
  standard: z.enum(['nahb', 'csi', 'custom']).default('custom'),
  unit: z.string().optional(),
  default_unit_cost_cents: z.number().int().min(0).optional(),
})

export async function createCostCode(input: z.infer<typeof costCodeSchema>, orgId?: string) {
  const parsed = costCodeSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from('cost_codes')
    .insert({ org_id: resolvedOrgId, ...parsed })
    .select('*')
    .single()

  if (error) throw new Error(`Failed to create cost code: ${error.message}`)

  await recordAudit({
    orgId: resolvedOrgId,
    action: 'insert',
    entityType: 'cost_code',
    entityId: data.id,
    after: data,
  })

  return data
}

export async function listCostCodes(orgId?: string, includeInactive = false) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from('cost_codes')
    .select('*')
    .eq('org_id', resolvedOrgId)
    .order('code')

  if (!includeInactive) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to list cost codes: ${error.message}`)

  return data ?? []
}

// Import NAHB residential cost codes
export async function seedNAHBCostCodes(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const nahbCodes = [
    { division: '01', code: '01-000', name: 'General Requirements', category: 'general' },
    { division: '01', code: '01-100', name: 'Permits & Fees', category: 'general' },
    { division: '01', code: '01-200', name: 'Insurance', category: 'general' },
    { division: '02', code: '02-000', name: 'Site Work', category: 'sitework' },
    { division: '02', code: '02-100', name: 'Clearing & Grading', category: 'sitework' },
    { division: '02', code: '02-200', name: 'Excavation', category: 'sitework' },
    { division: '02', code: '02-300', name: 'Fill & Backfill', category: 'sitework' },
    { division: '03', code: '03-000', name: 'Concrete', category: 'concrete' },
    { division: '03', code: '03-100', name: 'Footings', category: 'concrete' },
    { division: '03', code: '03-200', name: 'Foundation Walls', category: 'concrete' },
    { division: '03', code: '03-300', name: 'Slabs', category: 'concrete' },
    { division: '03', code: '03-400', name: 'Flatwork', category: 'concrete' },
    { division: '04', code: '04-000', name: 'Masonry', category: 'masonry' },
    { division: '05', code: '05-000', name: 'Metals/Steel', category: 'metals' },
    { division: '06', code: '06-000', name: 'Wood & Plastics', category: 'framing' },
    { division: '06', code: '06-100', name: 'Rough Framing - Labor', category: 'framing' },
    { division: '06', code: '06-200', name: 'Rough Framing - Material', category: 'framing' },
    { division: '06', code: '06-300', name: 'Finish Carpentry', category: 'framing' },
    { division: '07', code: '07-000', name: 'Thermal & Moisture', category: 'envelope' },
    { division: '07', code: '07-100', name: 'Insulation', category: 'envelope' },
    { division: '07', code: '07-200', name: 'Roofing', category: 'envelope' },
    { division: '07', code: '07-300', name: 'Siding', category: 'envelope' },
    { division: '08', code: '08-000', name: 'Doors & Windows', category: 'openings' },
    { division: '09', code: '09-000', name: 'Finishes', category: 'finishes' },
    { division: '09', code: '09-100', name: 'Drywall', category: 'finishes' },
    { division: '09', code: '09-200', name: 'Paint', category: 'finishes' },
    { division: '09', code: '09-300', name: 'Flooring', category: 'finishes' },
    { division: '09', code: '09-400', name: 'Tile', category: 'finishes' },
    { division: '10', code: '10-000', name: 'Specialties', category: 'specialties' },
    { division: '11', code: '11-000', name: 'Equipment', category: 'equipment' },
    { division: '11', code: '11-100', name: 'Appliances', category: 'equipment' },
    { division: '12', code: '12-000', name: 'Furnishings', category: 'furnishings' },
    { division: '12', code: '12-100', name: 'Cabinets', category: 'furnishings' },
    { division: '12', code: '12-200', name: 'Countertops', category: 'furnishings' },
    { division: '15', code: '15-000', name: 'Mechanical', category: 'mechanical' },
    { division: '15', code: '15-100', name: 'Plumbing - Rough', category: 'mechanical' },
    { division: '15', code: '15-200', name: 'Plumbing - Finish', category: 'mechanical' },
    { division: '15', code: '15-300', name: 'HVAC', category: 'mechanical' },
    { division: '16', code: '16-000', name: 'Electrical', category: 'electrical' },
    { division: '16', code: '16-100', name: 'Electrical - Rough', category: 'electrical' },
    { division: '16', code: '16-200', name: 'Electrical - Finish', category: 'electrical' },
    { division: '16', code: '16-300', name: 'Low Voltage', category: 'electrical' },
  ]

  const toInsert = nahbCodes.map((c) => ({
    org_id: resolvedOrgId,
    ...c,
    standard: 'nahb' as const,
    is_active: true,
  }))

  const { error } = await supabase.from('cost_codes').upsert(toInsert, {
    onConflict: 'org_id,code',
    ignoreDuplicates: true,
  })

  if (error) throw new Error(`Failed to seed NAHB codes: ${error.message}`)

  return { inserted: toInsert.length }
}

// Import from CSV/Excel
export async function importCostCodes(
  rows: Array<{ code: string; name: string; division?: string; category?: string }>,
  orgId?: string
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const toInsert = rows.map((row) => ({
    org_id: resolvedOrgId,
    code: row.code,
    name: row.name,
    division: row.division,
    category: row.category,
    standard: 'custom' as const,
    is_active: true,
  }))

  const { data, error } = await supabase
    .from('cost_codes')
    .upsert(toInsert, { onConflict: 'org_id,code' })
    .select('id')

  if (error) throw new Error(`Failed to import cost codes: ${error.message}`)

  return { imported: data?.length ?? 0 }
}
```

### Phase 2.3: Budget Service (lib/services/budgets.ts)

```typescript
import { z } from 'zod'
import { requireOrgContext } from '@/lib/services/context'
import { recordAudit } from '@/lib/services/audit'
import { recordEvent } from '@/lib/services/events'

const budgetLineSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  description: z.string().min(1),
  amount_cents: z.number().int().min(0),
  metadata: z.record(z.any()).optional(),
})

const createBudgetSchema = z.object({
  project_id: z.string().uuid(),
  lines: z.array(budgetLineSchema),
  status: z.enum(['draft', 'approved', 'locked']).default('draft'),
})

export async function createBudget(input: z.infer<typeof createBudgetSchema>, orgId?: string) {
  const parsed = createBudgetSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const totalCents = parsed.lines.reduce((sum, line) => sum + line.amount_cents, 0)

  const { data: budget, error: budgetError } = await supabase
    .from('budgets')
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      status: parsed.status,
      total_cents: totalCents,
    })
    .select('*')
    .single()

  if (budgetError || !budget) {
    throw new Error(`Failed to create budget: ${budgetError?.message}`)
  }

  if (parsed.lines.length > 0) {
    const linesToInsert = parsed.lines.map((line, idx) => ({
      org_id: resolvedOrgId,
      budget_id: budget.id,
      cost_code_id: line.cost_code_id,
      description: line.description,
      amount_cents: line.amount_cents,
      sort_order: idx,
      metadata: line.metadata ?? {},
    }))

    const { error: linesError } = await supabase.from('budget_lines').insert(linesToInsert)
    if (linesError) {
      throw new Error(`Failed to create budget lines: ${linesError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    action: 'insert',
    entityType: 'budget',
    entityId: budget.id,
    after: { ...budget, lines: parsed.lines },
  })

  return budget
}

export async function getBudgetWithActuals(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Get budget with lines
  const { data: budget, error: budgetError } = await supabase
    .from('budgets')
    .select(`
      *,
      lines:budget_lines(
        id, cost_code_id, description, amount_cents, sort_order,
        cost_code:cost_codes(id, code, name, category)
      )
    `)
    .eq('org_id', resolvedOrgId)
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (budgetError) throw new Error(`Failed to get budget: ${budgetError.message}`)
  if (!budget) return null

  // Get committed (approved commitments/POs)
  const { data: commitments } = await supabase
    .from('commitment_lines')
    .select('cost_code_id, unit_cost_cents, quantity')
    .eq('org_id', resolvedOrgId)
    .in('commitment_id',
      supabase
        .from('commitments')
        .select('id')
        .eq('project_id', projectId)
        .eq('status', 'approved')
    )

  // Get actuals (paid invoices to vendors, bills)
  const { data: billLines } = await supabase
    .from('bill_lines')
    .select('cost_code_id, unit_cost_cents, quantity')
    .eq('org_id', resolvedOrgId)
    .in('bill_id',
      supabase
        .from('vendor_bills')
        .select('id')
        .eq('project_id', projectId)
        .in('status', ['approved', 'paid'])
    )

  // Get invoiced (to client)
  const { data: invoiceLines } = await supabase
    .from('invoice_lines')
    .select('cost_code_id, unit_price_cents, quantity')
    .eq('org_id', resolvedOrgId)
    .in('invoice_id',
      supabase
        .from('invoices')
        .select('id')
        .eq('project_id', projectId)
        .in('status', ['sent', 'paid'])
    )

  // Get approved change orders
  const { data: coLines } = await supabase
    .from('change_order_lines')
    .select('cost_code_id, unit_cost_cents, quantity')
    .eq('org_id', resolvedOrgId)
    .in('change_order_id',
      supabase
        .from('change_orders')
        .select('id')
        .eq('project_id', projectId)
        .eq('status', 'approved')
    )

  // Aggregate by cost code
  const byCostCode = new Map<string, {
    budget_cents: number
    committed_cents: number
    actual_cents: number
    invoiced_cents: number
    co_adjustment_cents: number
  }>()

  // Initialize from budget lines
  for (const line of budget.lines ?? []) {
    const key = line.cost_code_id ?? 'uncoded'
    byCostCode.set(key, {
      budget_cents: line.amount_cents,
      committed_cents: 0,
      actual_cents: 0,
      invoiced_cents: 0,
      co_adjustment_cents: 0,
    })
  }

  // Add commitments
  for (const line of commitments ?? []) {
    const key = line.cost_code_id ?? 'uncoded'
    const existing = byCostCode.get(key) ?? { budget_cents: 0, committed_cents: 0, actual_cents: 0, invoiced_cents: 0, co_adjustment_cents: 0 }
    existing.committed_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  // Add actuals
  for (const line of billLines ?? []) {
    const key = line.cost_code_id ?? 'uncoded'
    const existing = byCostCode.get(key) ?? { budget_cents: 0, committed_cents: 0, actual_cents: 0, invoiced_cents: 0, co_adjustment_cents: 0 }
    existing.actual_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  // Add invoiced
  for (const line of invoiceLines ?? []) {
    const key = line.cost_code_id ?? 'uncoded'
    const existing = byCostCode.get(key) ?? { budget_cents: 0, committed_cents: 0, actual_cents: 0, invoiced_cents: 0, co_adjustment_cents: 0 }
    existing.invoiced_cents += (line.unit_price_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  // Add CO adjustments
  for (const line of coLines ?? []) {
    const key = line.cost_code_id ?? 'uncoded'
    const existing = byCostCode.get(key) ?? { budget_cents: 0, committed_cents: 0, actual_cents: 0, invoiced_cents: 0, co_adjustment_cents: 0 }
    existing.co_adjustment_cents += (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    byCostCode.set(key, existing)
  }

  // Calculate totals
  let totalBudget = 0
  let totalCommitted = 0
  let totalActual = 0
  let totalInvoiced = 0
  let totalCOAdjustment = 0

  const breakdown = Array.from(byCostCode.entries()).map(([costCodeId, values]) => {
    totalBudget += values.budget_cents
    totalCommitted += values.committed_cents
    totalActual += values.actual_cents
    totalInvoiced += values.invoiced_cents
    totalCOAdjustment += values.co_adjustment_cents

    const adjustedBudget = values.budget_cents + values.co_adjustment_cents
    const variance = adjustedBudget - values.actual_cents
    const variancePercent = adjustedBudget > 0 ? Math.round((values.actual_cents / adjustedBudget) * 100) : 0

    return {
      cost_code_id: costCodeId === 'uncoded' ? null : costCodeId,
      budget_cents: values.budget_cents,
      co_adjustment_cents: values.co_adjustment_cents,
      adjusted_budget_cents: adjustedBudget,
      committed_cents: values.committed_cents,
      actual_cents: values.actual_cents,
      invoiced_cents: values.invoiced_cents,
      variance_cents: variance,
      variance_percent: variancePercent,
      status: variancePercent > 100 ? 'over' : variancePercent > 90 ? 'warning' : 'ok',
    }
  })

  const adjustedTotalBudget = totalBudget + totalCOAdjustment
  const grossMarginCents = totalInvoiced - totalActual
  const grossMarginPercent = totalInvoiced > 0 ? Math.round((grossMarginCents / totalInvoiced) * 100) : 0

  return {
    budget,
    summary: {
      total_budget_cents: totalBudget,
      total_co_adjustment_cents: totalCOAdjustment,
      adjusted_budget_cents: adjustedTotalBudget,
      total_committed_cents: totalCommitted,
      total_actual_cents: totalActual,
      total_invoiced_cents: totalInvoiced,
      total_variance_cents: adjustedTotalBudget - totalActual,
      variance_percent: adjustedTotalBudget > 0 ? Math.round((totalActual / adjustedTotalBudget) * 100) : 0,
      gross_margin_cents: grossMarginCents,
      gross_margin_percent: grossMarginPercent,
      status: grossMarginPercent < 10 ? 'critical' : grossMarginPercent < 20 ? 'warning' : 'healthy',
    },
    breakdown,
  }
}

// Take nightly snapshot
export async function takeBudgetSnapshot(projectId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const data = await getBudgetWithActuals(projectId, orgId)
  if (!data?.budget) return null

  const today = new Date().toISOString().split('T')[0]

  const { data: snapshot, error } = await supabase
    .from('budget_snapshots')
    .upsert({
      org_id: orgId,
      project_id: projectId,
      budget_id: data.budget.id,
      snapshot_date: today,
      total_budget_cents: data.summary.adjusted_budget_cents,
      total_committed_cents: data.summary.total_committed_cents,
      total_actual_cents: data.summary.total_actual_cents,
      total_invoiced_cents: data.summary.total_invoiced_cents,
      variance_cents: data.summary.total_variance_cents,
      margin_percent: data.summary.gross_margin_percent,
      by_cost_code: data.breakdown,
    }, { onConflict: 'budget_id,snapshot_date' })
    .select('*')
    .single()

  return snapshot
}

// Check variance thresholds and create alerts
export async function checkVarianceAlerts(projectId: string, orgId: string, thresholds = [25, 50, 100]) {
  const supabase = createServiceSupabaseClient()
  const data = await getBudgetWithActuals(projectId, orgId)
  if (!data?.budget) return []

  const alerts = []

  for (const line of data.breakdown) {
    if (line.variance_percent >= thresholds[0]) {
      // Check if alert already exists
      const { data: existing } = await supabase
        .from('variance_alerts')
        .select('id')
        .eq('project_id', projectId)
        .eq('cost_code_id', line.cost_code_id)
        .eq('status', 'active')
        .maybeSingle()

      if (!existing) {
        const { data: alert } = await supabase
          .from('variance_alerts')
          .insert({
            org_id: orgId,
            project_id: projectId,
            budget_id: data.budget.id,
            cost_code_id: line.cost_code_id,
            alert_type: line.variance_percent >= 100 ? 'over_budget' : 'threshold_exceeded',
            threshold_percent: thresholds.find(t => line.variance_percent >= t),
            current_percent: line.variance_percent,
            budget_cents: line.adjusted_budget_cents,
            actual_cents: line.actual_cents,
            variance_cents: line.variance_cents,
          })
          .select('*')
          .single()

        if (alert) alerts.push(alert)
      }
    }
  }

  // Check overall margin warning
  if (data.summary.gross_margin_percent < 15) {
    const { data: existing } = await supabase
      .from('variance_alerts')
      .select('id')
      .eq('project_id', projectId)
      .eq('alert_type', 'margin_warning')
      .eq('status', 'active')
      .maybeSingle()

    if (!existing) {
      const { data: alert } = await supabase
        .from('variance_alerts')
        .insert({
          org_id: orgId,
          project_id: projectId,
          budget_id: data.budget.id,
          alert_type: 'margin_warning',
          current_percent: data.summary.gross_margin_percent,
          metadata: { message: `Gross margin is ${data.summary.gross_margin_percent}%` },
        })
        .select('*')
        .single()

      if (alert) alerts.push(alert)
    }
  }

  return alerts
}
```

### Phase 2 Acceptance Criteria

```markdown
## Phase 2 Acceptance Tests

### P2.1 Cost Codes
- [x] Seed NAHB codes → 40+ cost codes created (service in place)
- [x] Import CSV → codes created/updated (service in place)
- [x] Cost code tree displays correctly (parent/child)
- [x] Assign cost code to invoice line → persisted

### P2.2 Budget
- [x] Create budget with lines → total calculated (service)
- [x] View budget → shows budget vs committed vs actual vs invoiced (aggregation service)
- [x] Approved CO → adjusts budget automatically (COs included in actuals/adjusted budget)
- [x] Locked budget → edit blocked (DB trigger)

### P2.3 Variance
- [x] Actual exceeds 25% of budget → alert created
- [x] Actual exceeds 100% of budget → "over_budget" alert
- [x] Margin drops below 15% → "margin_warning" alert
- [x] Acknowledge alert → status = 'acknowledged'
- [x] Nightly snapshot → records totals and by-cost-code breakdown

### P2.4 Dashboard
- [x] Project page shows budget summary card
- [x] Color coding: green (<90%), yellow (90-100%), red (>100%)
- [x] Trend arrow shows week-over-week change
- [x] Gross margin displayed prominently
```

---

## Phase 3: Estimates → Proposals → Contracts

**Objective**: Win jobs faster with professional proposals and seamless contract signing.

**Killer Features (Differentiators)**:
1. **60-Second Proposal** — Template → customize → send. No PDF export/email dance.
2. **Interactive Client Portal** — Client reviews line items, asks questions inline, accepts.
3. **One-Click Contract Generation** — Proposal accepted → contract + budget + draw schedule created.
4. **Allowance Tracking** — Selections pull from allowances, auto-adjust on overage.
5. **E-Sign Built-In** — No DocuSign needed. Signature + audit trail included.
6. **Draw Schedule from Contract** — Milestone-based billing auto-created from contract terms.

### Phase 3.1: Schema

```sql
-- Enhance proposals
alter table proposals add column if not exists number text;
alter table proposals add column if not exists title text;
alter table proposals add column if not exists summary text;
alter table proposals add column if not exists terms text;
alter table proposals add column if not exists valid_until date;
alter table proposals add column if not exists total_cents integer;
alter table proposals add column if not exists signature_required boolean default true;
alter table proposals add column if not exists signature_data jsonb;
alter table proposals add column if not exists token_hash text;
alter table proposals add column if not exists viewed_at timestamptz;

create unique index if not exists proposals_token_hash_idx on proposals (token_hash) where token_hash is not null;
create unique index if not exists proposals_org_number_idx on proposals (org_id, number) where number is not null;

-- Proposal line items (separate from estimate for flexibility)
create table if not exists proposal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  proposal_id uuid not null references proposals(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  line_type text not null default 'item' check (line_type in ('item', 'section', 'allowance', 'option')),
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  markup_percent numeric,
  is_optional boolean default false,
  is_selected boolean default true,
  allowance_cents integer,
  notes text,
  sort_order integer default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index proposal_lines_org_idx on proposal_lines (org_id);
create index proposal_lines_proposal_idx on proposal_lines (proposal_id);
alter table proposal_lines enable row level security;
create policy "proposal_lines_access" on proposal_lines for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Enhance contracts
alter table contracts add column if not exists number text;
alter table contracts add column if not exists contract_type text default 'fixed' check (contract_type in ('fixed', 'cost_plus', 'time_materials'));
alter table contracts add column if not exists markup_percent numeric;
alter table contracts add column if not exists retainage_percent numeric default 0;
alter table contracts add column if not exists retainage_release_trigger text;
alter table contracts add column if not exists signature_data jsonb;

create unique index if not exists contracts_org_number_idx on contracts (org_id, number) where number is not null;

-- Retainage tracking
create table if not exists retainage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'held' check (status in ('held', 'released', 'invoiced', 'paid')),
  held_at timestamptz not null default now(),
  released_at timestamptz,
  release_invoice_id uuid references invoices(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index retainage_org_idx on retainage (org_id);
create index retainage_project_idx on retainage (project_id);
create index retainage_contract_idx on retainage (contract_id);
create index retainage_status_idx on retainage (status);
alter table retainage enable row level security;
create policy "retainage_access" on retainage for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger retainage_set_updated_at before update on retainage for each row execute function public.tg_set_updated_at();

-- Allowance tracking
create table if not exists allowances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  selection_category_id uuid references selection_categories(id) on delete set null,
  name text not null,
  budget_cents integer not null check (budget_cents >= 0),
  used_cents integer not null default 0 check (used_cents >= 0),
  status text not null default 'open' check (status in ('open', 'at_budget', 'over', 'closed')),
  overage_handling text default 'co' check (overage_handling in ('co', 'client_direct', 'absorb')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index allowances_org_idx on allowances (org_id);
create index allowances_project_idx on allowances (project_id);
alter table allowances enable row level security;
create policy "allowances_access" on allowances for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger allowances_set_updated_at before update on allowances for each row execute function public.tg_set_updated_at();

-- Estimate templates
create table if not exists estimate_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text,
  project_type text, -- 'custom_home', 'remodel', 'addition', etc.
  property_type text, -- 'residential', 'commercial'
  lines jsonb not null default '[]'::jsonb,
  is_active boolean default true,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index estimate_templates_org_idx on estimate_templates (org_id);
alter table estimate_templates enable row level security;
create policy "estimate_templates_access" on estimate_templates for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger estimate_templates_set_updated_at before update on estimate_templates for each row execute function public.tg_set_updated_at();
```

### Phase 3.2: Proposal Service (lib/services/proposals.ts)

```typescript
import { z } from 'zod'
import { createHmac, randomBytes } from 'crypto'
import { requireOrgContext } from '@/lib/services/context'
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { recordAudit } from '@/lib/services/audit'
import { recordEvent } from '@/lib/services/events'

const proposalLineSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  line_type: z.enum(['item', 'section', 'allowance', 'option']).default('item'),
  description: z.string().min(1),
  quantity: z.number().default(1),
  unit: z.string().optional(),
  unit_cost_cents: z.number().int().optional(),
  markup_percent: z.number().optional(),
  is_optional: z.boolean().default(false),
  allowance_cents: z.number().int().optional(),
  notes: z.string().optional(),
})

const createProposalSchema = z.object({
  project_id: z.string().uuid(),
  estimate_id: z.string().uuid().optional(),
  recipient_contact_id: z.string().uuid().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  terms: z.string().optional(),
  valid_until: z.string().optional(),
  lines: z.array(proposalLineSchema),
  markup_percent: z.number().optional(),
  tax_rate: z.number().optional(),
})

export async function createProposal(input: z.infer<typeof createProposalSchema>, orgId?: string) {
  const parsed = createProposalSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Generate proposal number
  const { count } = await supabase
    .from('proposals')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', resolvedOrgId)

  const number = `P-${String((count ?? 0) + 1).padStart(4, '0')}`

  // Calculate totals
  const markup = parsed.markup_percent ?? 0
  let subtotal = 0
  for (const line of parsed.lines) {
    if (!line.is_optional || line.is_selected !== false) {
      const lineCost = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
      const lineMarkup = Math.round(lineCost * (line.markup_percent ?? markup) / 100)
      subtotal += lineCost + lineMarkup
    }
  }

  const taxRate = parsed.tax_rate ?? 0
  const tax = Math.round(subtotal * taxRate / 100)
  const total = subtotal + tax

  // Generate access token
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHmac('sha256', process.env.PROPOSAL_SECRET!).update(token).digest('hex')

  const { data: proposal, error } = await supabase
    .from('proposals')
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      estimate_id: parsed.estimate_id,
      recipient_contact_id: parsed.recipient_contact_id,
      number,
      title: parsed.title,
      summary: parsed.summary,
      terms: parsed.terms,
      valid_until: parsed.valid_until,
      total_cents: total,
      token_hash: tokenHash,
      status: 'draft',
      snapshot: { markup_percent: markup, tax_rate: taxRate, subtotal_cents: subtotal, tax_cents: tax },
    })
    .select('*')
    .single()

  if (error || !proposal) {
    throw new Error(`Failed to create proposal: ${error?.message}`)
  }

  // Insert lines
  const linesToInsert = parsed.lines.map((line, idx) => ({
    org_id: resolvedOrgId,
    proposal_id: proposal.id,
    ...line,
    sort_order: idx,
  }))

  await supabase.from('proposal_lines').insert(linesToInsert)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: 'insert',
    entityType: 'proposal',
    entityId: proposal.id,
    after: proposal,
  })

  return {
    proposal,
    viewUrl: `${process.env.NEXT_PUBLIC_APP_URL}/proposal/${token}`,
  }
}

export async function sendProposal(proposalId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: proposal, error } = await supabase
    .from('proposals')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', proposalId)
    .eq('org_id', resolvedOrgId)
    .select('*, recipient:contacts(email, full_name)')
    .single()

  if (error || !proposal) {
    throw new Error(`Failed to send proposal: ${error?.message}`)
  }

  // Queue email notification
  await supabase.from('outbox').insert({
    org_id: resolvedOrgId,
    job_type: 'send_proposal_email',
    payload: {
      proposal_id: proposalId,
      recipient_email: proposal.recipient?.email,
      recipient_name: proposal.recipient?.full_name,
    },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: 'proposal_sent',
    entityType: 'proposal',
    entityId: proposalId,
    payload: { recipient: proposal.recipient?.email },
  })

  return proposal
}

export async function acceptProposal(
  token: string,
  signatureData: { signature_svg: string; signer_name: string; signer_ip?: string }
) {
  const supabase = createServiceSupabaseClient()
  const tokenHash = createHmac('sha256', process.env.PROPOSAL_SECRET!).update(token).digest('hex')

  const { data: proposal, error: findError } = await supabase
    .from('proposals')
    .select('*, lines:proposal_lines(*), project:projects(name)')
    .eq('token_hash', tokenHash)
    .eq('status', 'sent')
    .maybeSingle()

  if (findError || !proposal) {
    throw new Error('Proposal not found or already accepted')
  }

  // Check validity
  if (proposal.valid_until && new Date(proposal.valid_until) < new Date()) {
    throw new Error('Proposal has expired')
  }

  // Update proposal
  const { error: updateError } = await supabase
    .from('proposals')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      signature_data: { ...signatureData, signed_at: new Date().toISOString() },
    })
    .eq('id', proposal.id)

  if (updateError) throw new Error(`Failed to accept proposal: ${updateError.message}`)

  // Create contract
  const contractNumber = `C-${proposal.number?.replace('P-', '')}`
  const { data: contract } = await supabase
    .from('contracts')
    .insert({
      org_id: proposal.org_id,
      project_id: proposal.project_id,
      proposal_id: proposal.id,
      number: contractNumber,
      title: proposal.title ?? `Contract for ${proposal.project?.name}`,
      status: 'active',
      total_cents: proposal.total_cents,
      signed_at: new Date().toISOString(),
      effective_date: new Date().toISOString().split('T')[0],
      terms: proposal.terms,
      signature_data: signatureData,
      snapshot: proposal.snapshot,
    })
    .select('*')
    .single()

  // Create budget from proposal lines
  const budgetLines = (proposal.lines ?? [])
    .filter((line: any) => line.line_type !== 'section' && (!line.is_optional || line.is_selected))
    .map((line: any, idx: number) => ({
      org_id: proposal.org_id,
      cost_code_id: line.cost_code_id,
      description: line.description,
      amount_cents: (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
      sort_order: idx,
    }))

  if (budgetLines.length > 0 && contract) {
    const { data: budget } = await supabase
      .from('budgets')
      .insert({
        org_id: proposal.org_id,
        project_id: proposal.project_id,
        status: 'approved',
        total_cents: budgetLines.reduce((sum: number, l: any) => sum + l.amount_cents, 0),
      })
      .select('id')
      .single()

    if (budget) {
      await supabase
        .from('budget_lines')
        .insert(budgetLines.map((l: any) => ({ ...l, budget_id: budget.id })))
    }
  }

  // Create allowances from allowance lines
  const allowanceLines = (proposal.lines ?? []).filter((line: any) => line.line_type === 'allowance')
  for (const line of allowanceLines) {
    await supabase.from('allowances').insert({
      org_id: proposal.org_id,
      project_id: proposal.project_id,
      contract_id: contract?.id,
      name: line.description,
      budget_cents: line.allowance_cents ?? (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
    })
  }

  await recordEvent({
    orgId: proposal.org_id,
    eventType: 'proposal_accepted',
    entityType: 'proposal',
    entityId: proposal.id,
    payload: { contract_id: contract?.id, signer_name: signatureData.signer_name },
  })

  return { proposal, contract }
}

// Create draw schedule from contract
export async function createDrawScheduleFromContract(
  contractId: string,
  draws: Array<{
    title: string
    percent: number
    due_trigger: 'date' | 'milestone' | 'approval'
    due_date?: string
    milestone_id?: string
  }>,
  orgId?: string
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: contract } = await supabase
    .from('contracts')
    .select('id, project_id, total_cents')
    .eq('id', contractId)
    .eq('org_id', resolvedOrgId)
    .single()

  if (!contract) throw new Error('Contract not found')

  // Validate draws sum to 100%
  const totalPercent = draws.reduce((sum, d) => sum + d.percent, 0)
  if (totalPercent !== 100) {
    throw new Error(`Draw percentages must sum to 100% (currently ${totalPercent}%)`)
  }

  const drawsToInsert = draws.map((draw, idx) => ({
    org_id: resolvedOrgId,
    project_id: contract.project_id,
    contract_id: contractId,
    draw_number: idx + 1,
    title: draw.title,
    percent_of_contract: draw.percent,
    amount_cents: Math.round((contract.total_cents ?? 0) * draw.percent / 100),
    due_trigger: draw.due_trigger,
    due_date: draw.due_date,
    milestone_id: draw.milestone_id,
    status: 'pending',
  }))

  const { data, error } = await supabase
    .from('draw_schedules')
    .insert(drawsToInsert)
    .select('*')

  if (error) throw new Error(`Failed to create draw schedule: ${error.message}`)

  return data
}
```

### Phase 3.3: Proposal Portal UI (app/proposal/[token]/page.tsx)

```typescript
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { createHmac } from 'crypto'
import { notFound } from 'next/navigation'
import { ProposalViewClient } from './proposal-view-client'

export default async function ProposalPage({ params }: { params: { token: string } }) {
  const tokenHash = createHmac('sha256', process.env.PROPOSAL_SECRET!).update(params.token).digest('hex')
  const supabase = createServiceSupabaseClient()

  const { data: proposal } = await supabase
    .from('proposals')
    .select(`
      *,
      lines:proposal_lines(* order by sort_order),
      project:projects(name, address),
      org:orgs(name, logo_url),
      recipient:contacts(full_name, email)
    `)
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (!proposal) {
    notFound()
  }

  // Record view
  if (!proposal.viewed_at) {
    await supabase
      .from('proposals')
      .update({ viewed_at: new Date().toISOString() })
      .eq('id', proposal.id)
  }

  // Check if already accepted
  if (proposal.status === 'accepted') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-6xl mb-4">✓</div>
          <h1 className="text-2xl font-bold text-green-600">Proposal Accepted</h1>
          <p className="text-gray-600 mt-2">
            Thank you! Your contract has been generated.
          </p>
        </div>
      </div>
    )
  }

  // Check if expired
  if (proposal.valid_until && new Date(proposal.valid_until) < new Date()) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-6xl mb-4">⏰</div>
          <h1 className="text-2xl font-bold text-orange-600">Proposal Expired</h1>
          <p className="text-gray-600 mt-2">
            This proposal expired on {new Date(proposal.valid_until).toLocaleDateString()}.
            <br />Please contact us for an updated proposal.
          </p>
        </div>
      </div>
    )
  }

  return <ProposalViewClient proposal={proposal} token={params.token} />
}
```

### Phase 3 Acceptance Criteria

```markdown
## Phase 3 Acceptance Tests

### P3.1 Estimates
- [x] Create estimate from template → lines populated
- [x] Add/edit/remove lines → totals recalculate
- [x] Duplicate estimate → new version created
- [x] Convert to proposal → proposal created with lines

### P3.2 Proposals
- [x] Generate proposal → number assigned (P-0001)
- [x] Send proposal → status = 'sent', email sent
- [x] Client views proposal → viewed_at recorded
- [x] Client accepts → signature captured, status = 'accepted'
- [x] Expired proposal → shows expiry message

### P3.3 Contracts
- [x] Proposal accepted → contract auto-created
- [x] Contract signed → signature_data populated
- [x] Budget auto-created from proposal lines
- [x] Allowances created from allowance lines

### P3.4 Draw Schedules
- [x] Create draw schedule → percentages sum to 100%
- [x] Draw due → shows in billing dashboard
- [x] Invoice draw → status = 'invoiced'
- [x] Draw paid → status = 'paid'

### P3.5 Retainage
- [x] Invoice with retainage → retainage record created (held)
- [x] Final draw → retainage release available
- [x] Release retainage → creates release invoice
```

---

## Cross-Cutting Requirements (All Phases)

### Security
- [ ] All payment links HMAC-signed with expiry
- [ ] Webhook signatures verified
- [ ] RLS on all financial tables
- [ ] Audit log on financial mutations
- [ ] Portal tokens scoped to org/project

### Performance
- [ ] Budget calculations cached/optimized
- [ ] Snapshot queries avoid N+1
- [ ] Payment webhooks process < 5s

### Observability
- [ ] Structured logging with org_id/invoice_id/payment_id
- [ ] Error tracking with context
- [ ] Sync/job status dashboard

### Testing
- [ ] Unit tests for fee calculations
- [ ] Integration tests for payment flows
- [ ] E2E tests for portal acceptance

---

## Priority Execution Order

1. **Phase 1.1-1.2**: Schema + Stripe integration (foundation)
2. **Phase 1.3**: HMAC pay links (security)
3. **Phase 1.6**: Portal UI (user-facing value)
4. **Phase 1.4-1.5**: Lien waivers + reminders (automation)
5. **Phase 2.2**: Cost codes (prerequisite for budgets)
6. **Phase 2.3**: Budget service with actuals (core value)
7. **Phase 3.2**: Proposals (sales workflow)
8. **Phase 3 remainder**: Contracts + draws (close the loop)

---

## Differentiator Summary

| Feature | Procore | Buildertrend | Strata |
|---------|---------|--------------|--------|
| ACH-first payments | ❌ | ❌ | ✅ (lowest fees) |
| SMS pay links | ❌ | ❌ | ✅ (one-tap) |
| Auto lien waivers | ❌ | Manual | ✅ (payment-triggered) |
| Budget variance alerts | Complex setup | Manual checks | ✅ (auto SMS/email) |
| One-page budget view | 17 clicks | 5 clicks | ✅ (project page) |
| Proposal → Contract → Budget | Separate modules | Separate | ✅ (one-click) |
| Mobile-first portal | App required | Web only | ✅ (PWA optimized) |
| Setup time | Weeks | Days | Hours |
| Price | $500-2000+/mo | $99-499/mo | Flat + usage |

**Win message**: "Procore is for enterprise. Buildertrend is complex. Strata is built for builders like you — get paid faster, know your margins, close deals quicker."

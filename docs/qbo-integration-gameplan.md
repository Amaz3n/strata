# QuickBooks Online Integration — LLM-Optimized Gameplan

**Purpose**: Enable Strata users to sync invoices to QuickBooks Online automatically, eliminating double-entry and making accounting effortless for small builders.

**Differentiator Strategy**: One-click setup, automatic sync, zero manual reconciliation. "Set it and forget it" — unlike Procore's complex accounting integrations that require certified accountants.

---

## Executive Summary

### Why QBO?
- 80%+ of small contractors use QuickBooks (Online or Desktop)
- Construction-specific accounting is painful — Strata can make it invisible
- Competitors charge $200+/mo for accounting integrations; we include it

### Design Principles
1. **Zero-Touch Default** — Invoices sync automatically without user intervention
2. **Graceful Degradation** — App works perfectly without QBO; QBO is a "power-up"
3. **Unified Invoice Numbers** — Invoice numbers follow QBO sequence (2-way sync)
4. **Conflict Resolution** — Strata is source of truth; QBO conflicts surface as notifications
5. **Batch Efficiency** — Sync jobs grouped to avoid API rate limits and reduce latency

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         STRATA APP                               │
├─────────────────────────────────────────────────────────────────┤
│  Invoice Created/Updated/Paid                                    │
│          │                                                       │
│          ▼                                                       │
│  ┌───────────────┐    ┌──────────────────┐                      │
│  │ Invoice       │───▶│ Event System     │                      │
│  │ Service       │    │ (recordEvent)    │                      │
│  └───────────────┘    └────────┬─────────┘                      │
│                                │                                 │
│                    ┌───────────▼───────────┐                    │
│                    │    Outbox Table       │                    │
│                    │  (qbo_sync_invoice)   │                    │
│                    └───────────┬───────────┘                    │
│                                │                                 │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Supabase Edge Fn      │
                    │   (process-qbo-sync)    │
                    │   - Runs every 5 min    │
                    │   - Batches up to 30    │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  QBO Adapter Service    │
                    │  lib/integrations/      │
                    │  accounting/qbo.ts      │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   QuickBooks Online     │
                    │   REST API              │
                    └─────────────────────────┘
```

---

## 2-Way Invoice Number Sync (Critical Feature)

**Goal**: When QBO is connected, Strata invoice numbers should follow QBO's numbering sequence. This ensures the builder's accounting stays clean — no duplicate numbers, no gaps, one source of truth for invoice numbering.

### How QBO Invoice Numbers Work

According to [Intuit's developer documentation](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice):
- The `DocNumber` field is QBO's invoice number
- If you **omit DocNumber** when creating an invoice via API, QBO auto-assigns the next sequential number
- However, the auto-assigned number may not be returned immediately in the API response — you need to **query the invoice by ID** after creation to get it

### Strategy: "Reserve from QBO" Pattern

Since Strata users create invoices in our UI (not QBO), we need to **reserve the next invoice number from QBO before the user starts creating the invoice**. This ensures:

1. User sees the correct invoice # while filling out the form
2. No race conditions with other QBO users
3. Invoice numbers stay sequential

```
┌─────────────────────────────────────────────────────────────────────────┐
│  USER FLOW: Create Invoice (with QBO connected)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. User clicks "New Invoice"                                            │
│           │                                                              │
│           ▼                                                              │
│  2. Strata calls QBO API: get next invoice number                        │
│     ┌─────────────────────────────────────────────────────┐             │
│     │ SELECT DocNumber FROM Invoice                        │             │
│     │ ORDERBY DocNumber DESC MAXRESULTS 1                  │             │
│     │ → Returns "1047" → Next is "1048"                    │             │
│     └─────────────────────────────────────────────────────┘             │
│           │                                                              │
│           ▼                                                              │
│  3. Invoice form pre-fills with "1048" (readonly)                        │
│           │                                                              │
│           ▼                                                              │
│  4. User fills out invoice details, clicks Save                          │
│           │                                                              │
│           ▼                                                              │
│  5. Strata saves invoice locally with invoice_number = "1048"            │
│           │                                                              │
│           ▼                                                              │
│  6. Background sync creates invoice in QBO with DocNumber = "1048"       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Handling Edge Cases

#### Race Condition: Two Users Creating Invoices Simultaneously

```
User A: Gets "1048" → Fills form (5 min) → Saves
User B: Gets "1048" → Fills form (1 min) → Saves → Syncs to QBO first

Problem: User B takes "1048" in QBO, User A's sync fails
```

**Solution: Optimistic Locking + Auto-Increment Fallback**

1. When syncing to QBO, if `DocNumber` is already taken, QBO returns an error
2. Catch this error → Query QBO for the actual next number → Update Strata invoice → Retry sync
3. Notify user: "Invoice number updated from 1048 to 1049 to match QuickBooks"

#### Offline/Disconnected Mode

If QBO connection is down when user creates invoice:
1. Fall back to Strata's own sequence (prefix with "S-" to distinguish)
2. When connection restored, sync invoice to QBO with QBO's next number
3. Update Strata's invoice_number to match
4. User gets notification: "Invoice S-1048 synced to QuickBooks as 1049"

#### QBO Has Custom Number Format

Some QBO users have custom formats like "INV-001" or "2024-0001". We should:
1. On connect, detect QBO's numbering pattern
2. Store pattern in `qbo_connections.settings.invoice_number_pattern`
3. Generate Strata numbers following same pattern

### Schema Additions

```sql
-- Add to qbo_connections.settings:
-- {
--   ...existing settings,
--   "invoice_number_sync": true,
--   "invoice_number_pattern": "numeric" | "prefix" | "custom",
--   "invoice_number_prefix": "INV-",
--   "last_known_invoice_number": "1047"
-- }

-- Add reservation tracking to prevent race conditions
create table if not exists qbo_invoice_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  reserved_number text not null,
  reserved_by uuid references app_users(id),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  used_by_invoice_id uuid references invoices(id) on delete set null,
  status text not null default 'reserved' check (status in ('reserved', 'used', 'expired', 'released'))
);

create unique index qbo_invoice_reservations_active_idx
  on qbo_invoice_reservations (org_id, reserved_number)
  where status = 'reserved';

create index qbo_invoice_reservations_expires_idx
  on qbo_invoice_reservations (expires_at)
  where status = 'reserved';
```

### Invoice Number Service (lib/services/invoice-numbers.ts)

```typescript
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { QBOClient } from '@/lib/integrations/accounting/qbo-api'
import { getQBOConnection } from '@/lib/services/qbo-connection'

interface NextInvoiceNumber {
  number: string
  source: 'qbo' | 'local'
  reservation_id?: string
}

/**
 * Get the next invoice number for an org.
 * If QBO is connected, reserves the next number from QBO.
 * Otherwise, falls back to local sequence.
 */
export async function getNextInvoiceNumber(orgId: string): Promise<NextInvoiceNumber> {
  const supabase = createServiceSupabaseClient()

  // Check if QBO is connected with invoice number sync enabled
  const connection = await getQBOConnection(orgId)

  if (connection?.settings?.invoice_number_sync !== false) {
    const client = await QBOClient.forOrg(orgId)

    if (client) {
      try {
        // Get highest invoice number from QBO
        const lastNumber = await client.getLastInvoiceNumber()
        const nextNumber = incrementInvoiceNumber(lastNumber, connection?.settings)

        // Reserve this number
        const { data: reservation } = await supabase
          .from('qbo_invoice_reservations')
          .insert({
            org_id: orgId,
            reserved_number: nextNumber,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
          })
          .select('id')
          .single()

        return {
          number: nextNumber,
          source: 'qbo',
          reservation_id: reservation?.id,
        }
      } catch (err) {
        console.warn('Failed to get QBO invoice number, falling back to local', err)
      }
    }
  }

  // Fall back to local sequence
  const { data: lastInvoice } = await supabase
    .from('invoices')
    .select('invoice_number')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const lastNumber = lastInvoice?.invoice_number ?? '0'
  const nextNumber = incrementInvoiceNumber(lastNumber, null)

  return {
    number: nextNumber,
    source: 'local',
  }
}

/**
 * Release a reserved invoice number (if user cancels form)
 */
export async function releaseInvoiceNumberReservation(reservationId: string) {
  const supabase = createServiceSupabaseClient()

  await supabase
    .from('qbo_invoice_reservations')
    .update({ status: 'released' })
    .eq('id', reservationId)
    .eq('status', 'reserved')
}

/**
 * Mark a reservation as used when invoice is created
 */
export async function markReservationUsed(reservationId: string, invoiceId: string) {
  const supabase = createServiceSupabaseClient()

  await supabase
    .from('qbo_invoice_reservations')
    .update({
      status: 'used',
      used_by_invoice_id: invoiceId,
    })
    .eq('id', reservationId)
}

/**
 * Increment invoice number based on pattern
 */
function incrementInvoiceNumber(
  current: string,
  settings?: { invoice_number_pattern?: string; invoice_number_prefix?: string } | null
): string {
  // Handle numeric: "1047" → "1048"
  const numericMatch = current.match(/^(\d+)$/)
  if (numericMatch) {
    return String(parseInt(numericMatch[1], 10) + 1)
  }

  // Handle prefix: "INV-0047" → "INV-0048"
  const prefixMatch = current.match(/^([A-Za-z-]+)(\d+)$/)
  if (prefixMatch) {
    const prefix = prefixMatch[1]
    const num = parseInt(prefixMatch[2], 10) + 1
    const padLength = prefixMatch[2].length
    return `${prefix}${String(num).padStart(padLength, '0')}`
  }

  // Handle year prefix: "2024-0047" → "2024-0048"
  const yearMatch = current.match(/^(\d{4}-)(\d+)$/)
  if (yearMatch) {
    const year = yearMatch[1]
    const num = parseInt(yearMatch[2], 10) + 1
    const padLength = yearMatch[2].length
    return `${year}${String(num).padStart(padLength, '0')}`
  }

  // Default: treat as numeric starting from 1
  const numOnly = current.replace(/\D/g, '')
  if (numOnly) {
    return String(parseInt(numOnly, 10) + 1)
  }

  return '1001' // Start at 1001 if no pattern detected
}

/**
 * Cleanup expired reservations (run periodically)
 */
export async function cleanupExpiredReservations() {
  const supabase = createServiceSupabaseClient()

  await supabase
    .from('qbo_invoice_reservations')
    .update({ status: 'expired' })
    .eq('status', 'reserved')
    .lt('expires_at', new Date().toISOString())
}
```

### QBO API Addition (add to qbo-api.ts)

```typescript
// Add to QBOClient class:

async getLastInvoiceNumber(): Promise<string> {
  // Query for the most recent invoice by DocNumber
  // Note: DocNumber is a string field, so we order by MetaData.CreateTime as backup
  const query = `SELECT DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 1`

  const result = await this.request<{ QueryResponse: { Invoice?: Array<{ DocNumber: string }> } }>(
    'GET',
    `query?query=${encodeURIComponent(query)}`
  )

  return result.QueryResponse.Invoice?.[0]?.DocNumber ?? '1000'
}

async checkDocNumberExists(docNumber: string): Promise<boolean> {
  const query = `SELECT Id FROM Invoice WHERE DocNumber = '${docNumber}'`

  const result = await this.request<{ QueryResponse: { Invoice?: any[] } }>(
    'GET',
    `query?query=${encodeURIComponent(query)}`
  )

  return (result.QueryResponse.Invoice?.length ?? 0) > 0
}
```

### Updated Invoice Creation Flow

```typescript
// In app/invoices/actions.ts

export async function getNextInvoiceNumberAction() {
  const { orgId } = await requireOrgContext()
  return getNextInvoiceNumber(orgId)
}

export async function releaseInvoiceNumberAction(reservationId: string) {
  await releaseInvoiceNumberReservation(reservationId)
}

// Update createInvoiceAction to handle reservation
export async function createInvoiceAction(
  prevState: unknown,
  formData: FormData
) {
  const reservationId = formData.get('reservation_id') as string | null

  // ... existing validation and creation ...

  if (reservationId) {
    await markReservationUsed(reservationId, result.id)
  }

  return { success: true, data: result }
}
```

### UI Changes

```typescript
// In invoice form component:

'use client'

import { useEffect, useState } from 'react'
import { getNextInvoiceNumberAction, releaseInvoiceNumberAction } from '@/app/invoices/actions'

export function InvoiceForm({ onClose }: { onClose: () => void }) {
  const [invoiceNumber, setInvoiceNumber] = useState<string>('')
  const [reservationId, setReservationId] = useState<string | null>(null)
  const [numberSource, setNumberSource] = useState<'qbo' | 'local'>('local')
  const [isLoadingNumber, setIsLoadingNumber] = useState(true)

  // Fetch next invoice number on mount
  useEffect(() => {
    async function fetchNumber() {
      setIsLoadingNumber(true)
      try {
        const result = await getNextInvoiceNumberAction()
        setInvoiceNumber(result.number)
        setNumberSource(result.source)
        if (result.reservation_id) {
          setReservationId(result.reservation_id)
        }
      } finally {
        setIsLoadingNumber(false)
      }
    }
    fetchNumber()

    // Release reservation on unmount/cancel
    return () => {
      if (reservationId) {
        releaseInvoiceNumberAction(reservationId)
      }
    }
  }, [])

  return (
    <form>
      <div className="flex items-center gap-2">
        <Label>Invoice Number</Label>
        {isLoadingNumber ? (
          <Skeleton className="w-24 h-8" />
        ) : (
          <div className="flex items-center gap-2">
            <Input
              value={invoiceNumber}
              readOnly
              className="w-32 bg-muted"
            />
            {numberSource === 'qbo' && (
              <Badge variant="outline" className="text-xs">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                From QuickBooks
              </Badge>
            )}
          </div>
        )}
      </div>

      <input type="hidden" name="invoice_number" value={invoiceNumber} />
      <input type="hidden" name="reservation_id" value={reservationId ?? ''} />

      {/* ... rest of form ... */}
    </form>
  )
}
```

### Sync Conflict Resolution

When syncing to QBO and the DocNumber is already taken:

```typescript
// In qbo-sync.ts, update syncInvoiceToQBO:

try {
  const result = await client.createInvoice(qboInvoice)
  // ... success handling
} catch (err) {
  if (err instanceof QBOError && err.isDuplicateDocNumber) {
    // DocNumber taken - get the real next number
    const newNumber = await client.getNextAvailableDocNumber(qboInvoice.DocNumber)

    // Update Strata invoice
    await supabase
      .from('invoices')
      .update({
        invoice_number: newNumber,
        metadata: supabase.sql`metadata || '{"invoice_number_changed": true}'::jsonb`
      })
      .eq('id', invoice.id)

    // Retry with new number
    qboInvoice.DocNumber = newNumber
    const result = await client.createInvoice(qboInvoice)

    // Notify user
    await createNotification({
      org_id: invoice.org_id,
      type: 'invoice_number_changed',
      title: 'Invoice number updated',
      message: `Invoice ${invoice.invoice_number} was changed to ${newNumber} to match QuickBooks`,
      entity_type: 'invoice',
      entity_id: invoice.id,
    })

    return { success: true, qbo_id: result.Id, number_changed: true }
  }

  throw err
}
```

### Settings UI Addition

```typescript
// Add to QBOConnectionCard settings section:

<div className="flex items-center justify-between">
  <div>
    <Label htmlFor="invoice-number-sync">Sync invoice numbers</Label>
    <p className="text-xs text-muted-foreground">
      New invoices will follow QuickBooks numbering
    </p>
  </div>
  <Switch
    id="invoice-number-sync"
    checked={settings.invoice_number_sync !== false}
    onCheckedChange={(v) => handleSettingChange('invoice_number_sync', v)}
  />
</div>
```

---

## Phase 1: OAuth & Connection Setup

### 1.1 Schema

```sql
-- QBO connections per org
create table if not exists qbo_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  realm_id text not null,                    -- QBO Company ID
  access_token text not null,                -- Encrypted
  refresh_token text not null,               -- Encrypted
  token_expires_at timestamptz not null,
  company_name text,
  connected_by uuid references app_users(id),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'disconnected', 'error')),
  last_sync_at timestamptz,
  last_error text,
  settings jsonb not null default '{}'::jsonb,
  -- Settings: { auto_sync: true, sync_payments: true, default_income_account_id: "...", customer_sync_mode: "create_new" | "match_existing" }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index qbo_connections_org_active_idx on qbo_connections (org_id) where status = 'active';
create index qbo_connections_expires_idx on qbo_connections (token_expires_at) where status = 'active';
alter table qbo_connections enable row level security;
create policy "qbo_connections_access" on qbo_connections for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger qbo_connections_set_updated_at before update on qbo_connections for each row execute function public.tg_set_updated_at();

-- Sync tracking (invoice ↔ QBO entity mapping)
create table if not exists qbo_sync_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  connection_id uuid not null references qbo_connections(id) on delete cascade,
  entity_type text not null check (entity_type in ('invoice', 'payment', 'customer', 'item')),
  entity_id uuid not null,                   -- Strata entity ID
  qbo_id text not null,                      -- QBO entity ID
  qbo_sync_token text,                       -- For optimistic locking
  last_synced_at timestamptz not null default now(),
  sync_direction text not null default 'outbound' check (sync_direction in ('outbound', 'inbound', 'bidirectional')),
  status text not null default 'synced' check (status in ('synced', 'pending', 'error', 'conflict')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index qbo_sync_records_entity_idx on qbo_sync_records (org_id, entity_type, entity_id);
create index qbo_sync_records_qbo_idx on qbo_sync_records (connection_id, qbo_id);
alter table qbo_sync_records enable row level security;
create policy "qbo_sync_records_access" on qbo_sync_records for all using (auth.role() = 'service_role' or is_org_member(org_id));

-- Add QBO reference to invoices (denormalized for fast lookup)
alter table invoices add column if not exists qbo_id text;
alter table invoices add column if not exists qbo_synced_at timestamptz;
alter table invoices add column if not exists qbo_sync_status text check (qbo_sync_status is null or qbo_sync_status in ('pending', 'synced', 'error', 'skipped'));

create index invoices_qbo_sync_idx on invoices (org_id, qbo_sync_status) where qbo_sync_status is not null;
```

### 1.2 OAuth Flow (lib/integrations/accounting/qbo-auth.ts)

```typescript
import { createHmac } from 'crypto'

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID!
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET!
const QBO_REDIRECT_URI = process.env.NEXT_PUBLIC_APP_URL + '/api/integrations/qbo/callback'
const QBO_SCOPES = 'com.intuit.quickbooks.accounting'

interface QBOTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  x_refresh_token_expires_in: number
  realm_id: string
}

export function getQBOAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: 'code',
    scope: QBO_SCOPES,
    redirect_uri: QBO_REDIRECT_URI,
    state,
  })

  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://appcenter.intuit.com/connect/oauth2'
    : 'https://appcenter.intuit.com/connect/oauth2' // Same for sandbox, different realm

  return `${baseUrl}?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string, realmId: string): Promise<QBOTokens> {
  const credentials = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')

  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: QBO_REDIRECT_URI,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`QBO token exchange failed: ${error}`)
  }

  const tokens = await response.json()
  return { ...tokens, realm_id: realmId }
}

export async function refreshAccessToken(refreshToken: string): Promise<QBOTokens> {
  const credentials = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')

  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    throw new Error('QBO token refresh failed')
  }

  return response.json()
}

// Encrypt tokens at rest
export function encryptToken(token: string): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY!
  const cipher = createHmac('sha256', key)
  // In production, use proper AES-256-GCM encryption
  // This is simplified for illustration
  return Buffer.from(token).toString('base64')
}

export function decryptToken(encrypted: string): string {
  return Buffer.from(encrypted, 'base64').toString()
}
```

### 1.3 OAuth Callback Handler (app/api/integrations/qbo/callback/route.ts)

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, encryptToken } from '@/lib/integrations/accounting/qbo-auth'
import { createServiceSupabaseClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const realmId = searchParams.get('realmId')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL('/settings/integrations?error=qbo_denied', request.url))
  }

  if (!code || !realmId || !state) {
    return NextResponse.redirect(new URL('/settings/integrations?error=qbo_invalid', request.url))
  }

  // Validate state (CSRF protection)
  const cookieStore = await cookies()
  const savedState = cookieStore.get('qbo_oauth_state')?.value
  if (state !== savedState) {
    return NextResponse.redirect(new URL('/settings/integrations?error=qbo_state_mismatch', request.url))
  }

  // Extract orgId from state
  const [orgId] = state.split(':')

  try {
    const tokens = await exchangeCodeForTokens(code, realmId)
    const supabase = createServiceSupabaseClient()

    // Fetch company info from QBO
    const companyInfo = await fetchQBOCompanyInfo(tokens.access_token, realmId)

    // Deactivate any existing connections for this org
    await supabase
      .from('qbo_connections')
      .update({ status: 'disconnected', disconnected_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('status', 'active')

    // Create new connection
    const { error: insertError } = await supabase
      .from('qbo_connections')
      .insert({
        org_id: orgId,
        realm_id: realmId,
        access_token: encryptToken(tokens.access_token),
        refresh_token: encryptToken(tokens.refresh_token),
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        company_name: companyInfo?.CompanyName,
        status: 'active',
        settings: {
          auto_sync: true,
          sync_payments: true,
          customer_sync_mode: 'create_new',
        },
      })

    if (insertError) {
      throw new Error(`Failed to save QBO connection: ${insertError.message}`)
    }

    // Clear OAuth state cookie
    cookieStore.delete('qbo_oauth_state')

    return NextResponse.redirect(new URL('/settings/integrations?success=qbo_connected', request.url))
  } catch (err) {
    console.error('QBO OAuth callback error:', err)
    return NextResponse.redirect(new URL('/settings/integrations?error=qbo_failed', request.url))
  }
}

async function fetchQBOCompanyInfo(accessToken: string, realmId: string) {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com'

  const response = await fetch(
    `${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    }
  )

  if (!response.ok) return null
  const data = await response.json()
  return data.CompanyInfo
}
```

### 1.4 Connection Service (lib/services/qbo-connection.ts)

```typescript
import { requireOrgContext } from '@/lib/services/context'
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { decryptToken, refreshAccessToken, encryptToken } from '@/lib/integrations/accounting/qbo-auth'
import { recordEvent } from '@/lib/services/events'

export interface QBOConnection {
  id: string
  org_id: string
  realm_id: string
  company_name?: string
  status: 'active' | 'expired' | 'disconnected' | 'error'
  connected_at: string
  last_sync_at?: string
  settings: {
    auto_sync: boolean
    sync_payments: boolean
    customer_sync_mode: 'create_new' | 'match_existing'
    default_income_account_id?: string
  }
}

export async function getQBOConnection(orgId?: string): Promise<QBOConnection | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from('qbo_connections')
    .select('id, org_id, realm_id, company_name, status, connected_at, last_sync_at, settings')
    .eq('org_id', resolvedOrgId)
    .eq('status', 'active')
    .maybeSingle()

  if (error || !data) return null
  return data as QBOConnection
}

export async function getQBOAccessToken(orgId: string): Promise<{ token: string; realmId: string } | null> {
  const supabase = createServiceSupabaseClient()

  const { data: connection, error } = await supabase
    .from('qbo_connections')
    .select('id, realm_id, access_token, refresh_token, token_expires_at')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .single()

  if (error || !connection) return null

  const expiresAt = new Date(connection.token_expires_at)
  const now = new Date()

  // Refresh if expiring in next 5 minutes
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    try {
      const newTokens = await refreshAccessToken(decryptToken(connection.refresh_token))

      await supabase
        .from('qbo_connections')
        .update({
          access_token: encryptToken(newTokens.access_token),
          refresh_token: encryptToken(newTokens.refresh_token),
          token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
        })
        .eq('id', connection.id)

      return { token: newTokens.access_token, realmId: connection.realm_id }
    } catch (err) {
      // Mark connection as expired
      await supabase
        .from('qbo_connections')
        .update({ status: 'expired', last_error: 'Token refresh failed' })
        .eq('id', connection.id)

      return null
    }
  }

  return { token: decryptToken(connection.access_token), realmId: connection.realm_id }
}

export async function disconnectQBO(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from('qbo_connections')
    .update({
      status: 'disconnected',
      disconnected_at: new Date().toISOString(),
    })
    .eq('org_id', resolvedOrgId)
    .eq('status', 'active')

  if (error) throw new Error(`Failed to disconnect QBO: ${error.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: 'qbo_disconnected',
    entityType: 'integration',
    entityId: resolvedOrgId,
    payload: { disconnected_by: userId },
  })
}

export async function updateQBOSettings(
  settings: Partial<QBOConnection['settings']>,
  orgId?: string
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: current } = await supabase
    .from('qbo_connections')
    .select('settings')
    .eq('org_id', resolvedOrgId)
    .eq('status', 'active')
    .single()

  if (!current) throw new Error('No active QBO connection')

  const { error } = await supabase
    .from('qbo_connections')
    .update({
      settings: { ...current.settings, ...settings },
    })
    .eq('org_id', resolvedOrgId)
    .eq('status', 'active')

  if (error) throw new Error(`Failed to update QBO settings: ${error.message}`)
}
```

---

## Phase 2: Invoice Sync Engine

### 2.1 Sync Strategy Decision

**Recommendation: Immediate Enqueue + Batched Processing**

| Strategy | Pros | Cons |
|----------|------|------|
| Real-time (sync on create) | Instant feedback | API rate limits, slow creates, failures block UX |
| Batched (every N min) | Efficient, resilient | Slight delay |
| Nightly | Simple | Stale data all day |

**Winner: Batched every 5 minutes**
- User creates invoice → immediate success in Strata
- Background job picks up pending syncs every 5 min
- Batches up to 30 invoices per run (QBO rate limit friendly)
- Failures retry with exponential backoff
- Sync status visible in invoice list

### 2.2 QBO API Adapter (lib/integrations/accounting/qbo-api.ts)

```typescript
import { getQBOAccessToken } from '@/lib/services/qbo-connection'

const BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://quickbooks.api.intuit.com/v3/company'
  : 'https://sandbox-quickbooks.api.intuit.com/v3/company'

interface QBOInvoice {
  Id?: string
  SyncToken?: string
  DocNumber: string
  TxnDate: string
  DueDate?: string
  CustomerRef: { value: string; name?: string }
  Line: QBOInvoiceLine[]
  TotalAmt?: number
  Balance?: number
  EmailStatus?: string
  BillEmail?: { Address: string }
  PrivateNote?: string
  CustomerMemo?: { value: string }
}

interface QBOInvoiceLine {
  DetailType: 'SalesItemLineDetail' | 'DescriptionOnly'
  Amount: number
  Description?: string
  SalesItemLineDetail?: {
    ItemRef: { value: string; name?: string }
    Qty?: number
    UnitPrice?: number
  }
}

interface QBOCustomer {
  Id?: string
  SyncToken?: string
  DisplayName: string
  PrimaryEmailAddr?: { Address: string }
  PrimaryPhone?: { FreeFormNumber: string }
  BillAddr?: {
    Line1?: string
    City?: string
    CountrySubDivisionCode?: string
    PostalCode?: string
  }
}

export class QBOClient {
  private token: string
  private realmId: string

  constructor(token: string, realmId: string) {
    this.token = token
    this.realmId = realmId
  }

  static async forOrg(orgId: string): Promise<QBOClient | null> {
    const auth = await getQBOAccessToken(orgId)
    if (!auth) return null
    return new QBOClient(auth.token, auth.realmId)
  }

  private async request<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: any
  ): Promise<T> {
    const url = `${BASE_URL}/${this.realmId}/${endpoint}`

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new QBOError(response.status, error)
    }

    return response.json()
  }

  // ─────────────────────────────────────────────────────────────
  // Customers
  // ─────────────────────────────────────────────────────────────

  async findCustomerByEmail(email: string): Promise<QBOCustomer | null> {
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`
    const result = await this.request<{ QueryResponse: { Customer?: QBOCustomer[] } }>(
      'GET',
      `query?query=${encodeURIComponent(query)}`
    )
    return result.QueryResponse.Customer?.[0] ?? null
  }

  async findCustomerByName(displayName: string): Promise<QBOCustomer | null> {
    const query = `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}'`
    const result = await this.request<{ QueryResponse: { Customer?: QBOCustomer[] } }>(
      'GET',
      `query?query=${encodeURIComponent(query)}`
    )
    return result.QueryResponse.Customer?.[0] ?? null
  }

  async createCustomer(customer: Omit<QBOCustomer, 'Id' | 'SyncToken'>): Promise<QBOCustomer> {
    const result = await this.request<{ Customer: QBOCustomer }>(
      'POST',
      'customer',
      customer
    )
    return result.Customer
  }

  async getOrCreateCustomer(
    displayName: string,
    email?: string,
    phone?: string
  ): Promise<QBOCustomer> {
    // Try email match first (most reliable)
    if (email) {
      const byEmail = await this.findCustomerByEmail(email)
      if (byEmail) return byEmail
    }

    // Try name match
    const byName = await this.findCustomerByName(displayName)
    if (byName) return byName

    // Create new
    return this.createCustomer({
      DisplayName: displayName,
      PrimaryEmailAddr: email ? { Address: email } : undefined,
      PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
    })
  }

  // ─────────────────────────────────────────────────────────────
  // Invoices
  // ─────────────────────────────────────────────────────────────

  async createInvoice(invoice: Omit<QBOInvoice, 'Id' | 'SyncToken'>): Promise<QBOInvoice> {
    const result = await this.request<{ Invoice: QBOInvoice }>(
      'POST',
      'invoice',
      invoice
    )
    return result.Invoice
  }

  async updateInvoice(invoice: QBOInvoice): Promise<QBOInvoice> {
    if (!invoice.Id || !invoice.SyncToken) {
      throw new Error('Invoice Id and SyncToken required for update')
    }
    const result = await this.request<{ Invoice: QBOInvoice }>(
      'POST',
      'invoice',
      invoice
    )
    return result.Invoice
  }

  async getInvoice(id: string): Promise<QBOInvoice> {
    const result = await this.request<{ Invoice: QBOInvoice }>(
      'GET',
      `invoice/${id}`
    )
    return result.Invoice
  }

  async voidInvoice(id: string, syncToken: string): Promise<QBOInvoice> {
    const result = await this.request<{ Invoice: QBOInvoice }>(
      'POST',
      `invoice?operation=void`,
      { Id: id, SyncToken: syncToken }
    )
    return result.Invoice
  }

  // ─────────────────────────────────────────────────────────────
  // Payments
  // ─────────────────────────────────────────────────────────────

  async createPayment(payment: {
    CustomerRef: { value: string }
    TotalAmt: number
    Line: Array<{
      Amount: number
      LinkedTxn: Array<{ TxnId: string; TxnType: 'Invoice' }>
    }>
    PaymentMethodRef?: { value: string }
    DepositToAccountRef?: { value: string }
  }) {
    const result = await this.request<{ Payment: any }>(
      'POST',
      'payment',
      payment
    )
    return result.Payment
  }

  // ─────────────────────────────────────────────────────────────
  // Items (for line items)
  // ─────────────────────────────────────────────────────────────

  async getDefaultServiceItem(): Promise<{ value: string; name: string }> {
    // Find or create a generic "Services" item
    const query = `SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1`
    const result = await this.request<{ QueryResponse: { Item?: any[] } }>(
      'GET',
      `query?query=${encodeURIComponent(query)}`
    )

    if (result.QueryResponse.Item?.[0]) {
      return {
        value: result.QueryResponse.Item[0].Id,
        name: result.QueryResponse.Item[0].Name,
      }
    }

    // Create default item
    const newItem = await this.request<{ Item: any }>(
      'POST',
      'item',
      {
        Name: 'Construction Services',
        Type: 'Service',
        IncomeAccountRef: { value: '1' }, // Default income account
      }
    )

    return { value: newItem.Item.Id, name: newItem.Item.Name }
  }
}

export class QBOError extends Error {
  status: number
  qboError: any

  constructor(status: number, error: any) {
    super(`QBO API Error ${status}: ${JSON.stringify(error)}`)
    this.status = status
    this.qboError = error
  }

  get isRateLimit() {
    return this.status === 429
  }

  get isStaleObject() {
    // QBO returns this when SyncToken is stale
    return this.qboError?.Fault?.Error?.some?.((e: any) => e.code === '5010')
  }

  get isAuthError() {
    return this.status === 401
  }
}
```

### 2.3 Invoice Sync Service (lib/services/qbo-sync.ts)

```typescript
import { createServiceSupabaseClient } from '@/lib/supabase/server'
import { QBOClient, QBOError } from '@/lib/integrations/accounting/qbo-api'
import { recordEvent } from '@/lib/services/events'

interface StrataInvoice {
  id: string
  org_id: string
  project_id?: string
  invoice_number: string
  title?: string
  status: string
  issue_date?: string
  due_date?: string
  total_cents?: number
  balance_due_cents?: number
  lines: Array<{
    description: string
    quantity: number
    unit_cost_cents: number
  }>
  metadata?: {
    tax_rate?: number
  }
}

interface SyncResult {
  success: boolean
  qbo_id?: string
  error?: string
}

export async function syncInvoiceToQBO(invoice: StrataInvoice): Promise<SyncResult> {
  const supabase = createServiceSupabaseClient()

  // Get QBO client
  const client = await QBOClient.forOrg(invoice.org_id)
  if (!client) {
    return { success: false, error: 'No active QBO connection' }
  }

  try {
    // Get or create customer
    const { data: project } = await supabase
      .from('projects')
      .select('name, client:contacts(full_name, email, phone)')
      .eq('id', invoice.project_id)
      .single()

    const customerName = project?.client?.full_name || project?.name || 'Unknown Customer'
    const customer = await client.getOrCreateCustomer(
      customerName,
      project?.client?.email,
      project?.client?.phone
    )

    // Record customer mapping if new
    await upsertSyncRecord(supabase, {
      org_id: invoice.org_id,
      entity_type: 'customer',
      entity_id: project?.client?.id ?? invoice.project_id!,
      qbo_id: customer.Id!,
    })

    // Get default item for line items
    const defaultItem = await client.getDefaultServiceItem()

    // Check if invoice already synced
    const { data: existingSync } = await supabase
      .from('qbo_sync_records')
      .select('qbo_id, qbo_sync_token')
      .eq('org_id', invoice.org_id)
      .eq('entity_type', 'invoice')
      .eq('entity_id', invoice.id)
      .maybeSingle()

    // Build QBO invoice
    const qboInvoice = {
      Id: existingSync?.qbo_id,
      SyncToken: existingSync?.qbo_sync_token,
      DocNumber: invoice.invoice_number,
      TxnDate: invoice.issue_date ?? new Date().toISOString().split('T')[0],
      DueDate: invoice.due_date,
      CustomerRef: { value: customer.Id!, name: customer.DisplayName },
      Line: invoice.lines.map((line) => ({
        DetailType: 'SalesItemLineDetail' as const,
        Amount: (line.quantity * line.unit_cost_cents) / 100,
        Description: line.description,
        SalesItemLineDetail: {
          ItemRef: defaultItem,
          Qty: line.quantity,
          UnitPrice: line.unit_cost_cents / 100,
        },
      })),
      PrivateNote: `Strata Invoice ID: ${invoice.id}`,
    }

    // Create or update
    const result = existingSync?.qbo_id
      ? await client.updateInvoice(qboInvoice as any)
      : await client.createInvoice(qboInvoice)

    // Record sync
    await upsertSyncRecord(supabase, {
      org_id: invoice.org_id,
      entity_type: 'invoice',
      entity_id: invoice.id,
      qbo_id: result.Id!,
      qbo_sync_token: result.SyncToken,
    })

    // Update invoice with QBO reference
    await supabase
      .from('invoices')
      .update({
        qbo_id: result.Id,
        qbo_synced_at: new Date().toISOString(),
        qbo_sync_status: 'synced',
      })
      .eq('id', invoice.id)

    return { success: true, qbo_id: result.Id }
  } catch (err) {
    const error = err instanceof QBOError ? err : new Error(String(err))

    // Handle specific errors
    if (error instanceof QBOError) {
      if (error.isAuthError) {
        // Mark connection as expired
        await supabase
          .from('qbo_connections')
          .update({ status: 'expired' })
          .eq('org_id', invoice.org_id)
          .eq('status', 'active')
      }

      if (error.isStaleObject) {
        // Refetch and retry would go here
        // For now, mark as conflict
        await supabase
          .from('invoices')
          .update({ qbo_sync_status: 'error' })
          .eq('id', invoice.id)
      }
    }

    // Update invoice status
    await supabase
      .from('invoices')
      .update({ qbo_sync_status: 'error' })
      .eq('id', invoice.id)

    return { success: false, error: error.message }
  }
}

export async function syncPaymentToQBO(paymentId: string, orgId: string): Promise<SyncResult> {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    return { success: false, error: 'No active QBO connection' }
  }

  try {
    // Get payment with invoice
    const { data: payment } = await supabase
      .from('payments')
      .select('*, invoice:invoices(id, qbo_id, project:projects(client:contacts(id)))')
      .eq('id', paymentId)
      .single()

    if (!payment?.invoice?.qbo_id) {
      return { success: false, error: 'Invoice not synced to QBO' }
    }

    // Get customer QBO ID
    const { data: customerSync } = await supabase
      .from('qbo_sync_records')
      .select('qbo_id')
      .eq('org_id', orgId)
      .eq('entity_type', 'customer')
      .eq('entity_id', payment.invoice.project?.client?.id)
      .maybeSingle()

    if (!customerSync?.qbo_id) {
      return { success: false, error: 'Customer not synced to QBO' }
    }

    const qboPayment = await client.createPayment({
      CustomerRef: { value: customerSync.qbo_id },
      TotalAmt: payment.amount_cents / 100,
      Line: [{
        Amount: payment.amount_cents / 100,
        LinkedTxn: [{ TxnId: payment.invoice.qbo_id, TxnType: 'Invoice' }],
      }],
    })

    await upsertSyncRecord(supabase, {
      org_id: orgId,
      entity_type: 'payment',
      entity_id: paymentId,
      qbo_id: qboPayment.Id,
    })

    return { success: true, qbo_id: qboPayment.Id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

async function upsertSyncRecord(supabase: any, record: {
  org_id: string
  entity_type: string
  entity_id: string
  qbo_id: string
  qbo_sync_token?: string
}) {
  // Get connection ID
  const { data: connection } = await supabase
    .from('qbo_connections')
    .select('id')
    .eq('org_id', record.org_id)
    .eq('status', 'active')
    .single()

  if (!connection) return

  await supabase
    .from('qbo_sync_records')
    .upsert({
      org_id: record.org_id,
      connection_id: connection.id,
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      qbo_id: record.qbo_id,
      qbo_sync_token: record.qbo_sync_token,
      last_synced_at: new Date().toISOString(),
      status: 'synced',
    }, {
      onConflict: 'org_id,entity_type,entity_id',
    })
}

// Enqueue invoice for sync (called from invoice service)
export async function enqueueInvoiceSync(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  // Check if QBO is enabled for this org
  const { data: connection } = await supabase
    .from('qbo_connections')
    .select('id, settings')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .maybeSingle()

  if (!connection?.settings?.auto_sync) return

  // Mark invoice as pending sync
  await supabase
    .from('invoices')
    .update({ qbo_sync_status: 'pending' })
    .eq('id', invoiceId)

  // Enqueue job
  await supabase.from('outbox').insert({
    org_id: orgId,
    job_type: 'qbo_sync_invoice',
    payload: { invoice_id: invoiceId },
  })
}
```

### 2.4 Batch Sync Edge Function (supabase/functions/process-qbo-sync/index.ts)

```typescript
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BATCH_SIZE = 30
const MAX_RETRIES = 3

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Get pending sync jobs
  const { data: jobs, error: jobsError } = await supabase
    .from('outbox')
    .select('*')
    .eq('job_type', 'qbo_sync_invoice')
    .eq('status', 'pending')
    .lt('retry_count', MAX_RETRIES)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (jobsError || !jobs?.length) {
    return new Response(JSON.stringify({ processed: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Mark as processing
  const jobIds = jobs.map(j => j.id)
  await supabase
    .from('outbox')
    .update({ status: 'processing' })
    .in('id', jobIds)

  // Group by org for efficient API usage
  const byOrg = jobs.reduce((acc, job) => {
    const orgId = job.org_id
    if (!acc[orgId]) acc[orgId] = []
    acc[orgId].push(job)
    return acc
  }, {} as Record<string, typeof jobs>)

  const results = { processed: 0, failed: 0 }

  for (const [orgId, orgJobs] of Object.entries(byOrg)) {
    // Check connection health once per org
    const { data: connection } = await supabase
      .from('qbo_connections')
      .select('status')
      .eq('org_id', orgId)
      .eq('status', 'active')
      .maybeSingle()

    if (!connection) {
      // Skip all jobs for this org, mark as skipped
      await supabase
        .from('outbox')
        .update({
          status: 'failed',
          last_error: 'No active QBO connection',
        })
        .eq('org_id', orgId)
        .in('id', orgJobs.map(j => j.id))
      continue
    }

    for (const job of orgJobs) {
      try {
        // Call sync function via internal API
        const response = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/qbo-sync-invoice`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              invoice_id: job.payload.invoice_id,
              org_id: job.org_id,
            }),
          }
        )

        const result = await response.json()

        if (result.success) {
          await supabase
            .from('outbox')
            .update({ status: 'completed' })
            .eq('id', job.id)
          results.processed++
        } else {
          throw new Error(result.error)
        }
      } catch (err) {
        const newRetryCount = (job.retry_count ?? 0) + 1
        const shouldRetry = newRetryCount < MAX_RETRIES

        await supabase
          .from('outbox')
          .update({
            status: shouldRetry ? 'pending' : 'failed',
            retry_count: newRetryCount,
            last_error: err.message,
            // Exponential backoff: 5min, 20min, 80min
            run_at: shouldRetry
              ? new Date(Date.now() + Math.pow(4, newRetryCount) * 5 * 60 * 1000).toISOString()
              : undefined,
          })
          .eq('id', job.id)

        results.failed++
      }
    }
  }

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

---

## Phase 3: UI & Onboarding

### 3.1 Settings Integrations Page (app/settings/integrations/page.tsx)

```typescript
import { AppShell } from '@/components/layout/app-shell'
import { QBOConnectionCard } from '@/components/integrations/qbo-connection-card'
import { getQBOConnection } from '@/lib/services/qbo-connection'
import { requirePermissionGuard } from '@/lib/auth/guards'
import { getCurrentUserAction } from '@/app/actions/user'

export default async function IntegrationsPage() {
  await requirePermissionGuard('org.admin')
  const currentUser = await getCurrentUserAction()
  const qboConnection = await getQBOConnection()

  return (
    <AppShell title="Integrations" user={currentUser}>
      <div className="p-6 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-muted-foreground mt-1">
            Connect your tools to automate workflows
          </p>
        </div>

        <div className="grid gap-6">
          <QBOConnectionCard connection={qboConnection} />

          {/* Future integrations */}
          <ComingSoonCard
            title="Xero"
            description="Sync invoices and expenses with Xero"
          />
          <ComingSoonCard
            title="Sage"
            description="Enterprise accounting integration"
          />
        </div>
      </div>
    </AppShell>
  )
}

function ComingSoonCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="border rounded-lg p-6 opacity-60">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{title}</h3>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
        <span className="text-xs bg-muted px-2 py-1 rounded">Coming Soon</span>
      </div>
    </div>
  )
}
```

### 3.2 QBO Connection Card (components/integrations/qbo-connection-card.tsx)

```typescript
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { connectQBOAction, disconnectQBOAction, updateQBOSettingsAction } from '@/app/settings/integrations/actions'
import type { QBOConnection } from '@/lib/services/qbo-connection'

interface Props {
  connection: QBOConnection | null
}

export function QBOConnectionCard({ connection }: Props) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [settings, setSettings] = useState(connection?.settings ?? {
    auto_sync: true,
    sync_payments: true,
  })

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const result = await connectQBOAction()
      if (result.authUrl) {
        window.location.href = result.authUrl
      }
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    if (!confirm('Disconnect QuickBooks? Existing synced data will remain in QBO.')) {
      return
    }
    await disconnectQBOAction()
    window.location.reload()
  }

  const handleSettingChange = async (key: string, value: boolean) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    await updateQBOSettingsAction({ [key]: value })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#2CA01C] rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">QB</span>
            </div>
            <div>
              <CardTitle className="text-lg">QuickBooks Online</CardTitle>
              <CardDescription>
                Sync invoices and payments automatically
              </CardDescription>
            </div>
          </div>
          {connection && (
            <Badge variant={connection.status === 'active' ? 'default' : 'destructive'}>
              {connection.status === 'active' ? (
                <><CheckCircle2 className="w-3 h-3 mr-1" /> Connected</>
              ) : (
                <><AlertCircle className="w-3 h-3 mr-1" /> {connection.status}</>
              )}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {!connection ? (
          <div className="space-y-4">
            <div className="bg-muted/50 rounded-lg p-4 space-y-2">
              <h4 className="font-medium">What gets synced:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Invoice numbers follow your QBO sequence</li>
                <li>• Invoices → QBO Invoices (automatic)</li>
                <li>• Payments → QBO Payments (automatic)</li>
                <li>• Customers → QBO Customers (auto-created)</li>
              </ul>
            </div>

            <Button onClick={handleConnect} disabled={isConnecting} className="w-full">
              {isConnecting ? (
                <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Connecting...</>
              ) : (
                <><ExternalLink className="w-4 h-4 mr-2" /> Connect QuickBooks</>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Connection info */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Connected to:</span>
              <span className="font-medium">{connection.company_name}</span>
            </div>

            {connection.last_sync_at && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last sync:</span>
                <span>{new Date(connection.last_sync_at).toLocaleString()}</span>
              </div>
            )}

            {/* Settings */}
            <div className="border-t pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="auto-sync">Auto-sync invoices</Label>
                  <p className="text-xs text-muted-foreground">
                    New invoices sync within 5 minutes
                  </p>
                </div>
                <Switch
                  id="auto-sync"
                  checked={settings.auto_sync}
                  onCheckedChange={(v) => handleSettingChange('auto_sync', v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="sync-payments">Sync payments</Label>
                  <p className="text-xs text-muted-foreground">
                    Record payments in QBO when paid
                  </p>
                </div>
                <Switch
                  id="sync-payments"
                  checked={settings.sync_payments}
                  onCheckedChange={(v) => handleSettingChange('sync_payments', v)}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="border-t pt-4 flex justify-between items-center">
              <Button variant="ghost" size="sm" onClick={handleDisconnect}>
                Disconnect
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={`https://qbo.intuit.com/app/homepage`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open QuickBooks <ExternalLink className="w-3 h-3 ml-1" />
                </a>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

### 3.3 Invoice Sync Status Badge

Add to invoice list and detail views:

```typescript
// components/invoices/qbo-sync-badge.tsx
'use client'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CheckCircle2, Clock, AlertCircle, CloudOff } from 'lucide-react'

interface Props {
  status: 'pending' | 'synced' | 'error' | 'skipped' | null
  syncedAt?: string
  qboId?: string
}

export function QBOSyncBadge({ status, syncedAt, qboId }: Props) {
  if (!status) return null

  const config = {
    pending: {
      icon: Clock,
      label: 'Syncing...',
      variant: 'secondary' as const,
      tooltip: 'Invoice will sync to QuickBooks within 5 minutes',
    },
    synced: {
      icon: CheckCircle2,
      label: 'QBO',
      variant: 'outline' as const,
      tooltip: syncedAt
        ? `Synced to QuickBooks ${new Date(syncedAt).toLocaleString()}`
        : 'Synced to QuickBooks',
    },
    error: {
      icon: AlertCircle,
      label: 'Sync Error',
      variant: 'destructive' as const,
      tooltip: 'Failed to sync to QuickBooks. Will retry automatically.',
    },
    skipped: {
      icon: CloudOff,
      label: 'Not Synced',
      variant: 'secondary' as const,
      tooltip: 'QuickBooks sync disabled or not connected',
    },
  }

  const { icon: Icon, label, variant, tooltip } = config[status]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className="gap-1 cursor-help">
          <Icon className="w-3 h-3" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
        {qboId && status === 'synced' && (
          <p className="text-xs opacity-70 mt-1">QBO ID: {qboId}</p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
```

---

## Phase 4: Modify Invoice Service

Update the existing invoice service to trigger QBO sync:

### 4.1 Update createInvoice (lib/services/invoices.ts)

Add at the end of `createInvoice()`:

```typescript
// After successful invoice creation and email...

// Enqueue QBO sync if connected
await enqueueInvoiceSync(data.id, resolvedOrgId)

return mapInvoiceRow(data as InvoiceRow)
```

### 4.2 Add updateInvoice function

```typescript
export async function updateInvoice({
  invoiceId,
  input,
  orgId,
}: {
  invoiceId: string
  input: Partial<InvoiceInput>
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // ... update logic ...

  // Re-sync to QBO if already synced
  const existing = await getInvoiceWithLines(invoiceId, resolvedOrgId)
  if (existing?.qbo_id) {
    await enqueueInvoiceSync(invoiceId, resolvedOrgId)
  }

  return updated
}
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create QBO OAuth app in Intuit Developer Portal
- [x] Implement schema migration (including `qbo_invoice_reservations` table)
- [x] Build OAuth flow (connect/callback/disconnect)
- [x] Add Settings → Integrations page
- [x] Token encryption/storage
- [x] Detect and store QBO invoice number pattern on connect

### Phase 2: Invoice Number Sync (Week 2)
- [x] Implement `getNextInvoiceNumber()` service
- [x] Add reservation system for invoice numbers
- [x] Update invoice form to fetch/display QBO number
- [x] Handle reservation release on form cancel
- [x] Implement number pattern detection (numeric, prefix, year-based)
- [ ] Add cleanup job for expired reservations (note: add cron/edge task post-deploy)

### Phase 3: Core Invoice Sync (Week 3)
- [x] QBO API adapter (customers, invoices)
- [x] Invoice sync service with DocNumber handling
- [x] Outbox job processing (Next.js cron endpoint)
- [ ] Supabase Edge Function for batch sync
- [x] Error handling and retry logic
- [ ] Duplicate DocNumber conflict resolution

### Phase 4: UI Polish (Week 4)
- [x] QBO sync status badges on invoices
- [x] "From QuickBooks" badge on invoice number field
- [x] Connection health monitoring
- [x] Sync history/logs view
- [x] Manual resync button
- [x] Invoice number change notifications

### Phase 5: Payment Sync (Week 5)
- [x] Payment → QBO Payment recording
- [x] Webhook to trigger payment sync (POST /api/qbo/payment-webhook with x-qbo-webhook-secret + payment_id)
- [ ] Balance reconciliation alerts

---

## Environment Variables

```bash
# QuickBooks OAuth
QBO_CLIENT_ID=your_client_id
QBO_CLIENT_SECRET=your_client_secret

# Token encryption
TOKEN_ENCRYPTION_KEY=32_byte_random_key

# For sandbox testing
QBO_SANDBOX=true
```

---

## Acceptance Criteria

### Connection
- [ ] Admin clicks "Connect QuickBooks" → redirected to Intuit OAuth
- [ ] After approval → returns to Strata with "Connected" badge
- [ ] Company name displays in settings
- [ ] QBO invoice number pattern detected and stored
- [ ] Disconnect works cleanly

### Invoice Number Sync (2-Way)
- [ ] User opens "New Invoice" form → invoice number fetched from QBO sequence
- [ ] Invoice number field shows "From QuickBooks" badge when QBO connected
- [ ] Invoice number is read-only (can't be manually changed when QBO connected)
- [ ] User cancels form → reservation released, number available for next invoice
- [ ] Two users open form simultaneously → each gets unique reserved number
- [ ] QBO has "INV-001" format → Strata follows same format
- [ ] QBO connection down → falls back to local numbering with "S-" prefix
- [ ] Reservation expires after 30 min → number released

### Invoice Sync
- [ ] Create invoice → `qbo_sync_status = 'pending'`
- [ ] Within 5 min → `qbo_sync_status = 'synced'`, `qbo_id` populated
- [ ] Invoice visible in QBO with correct DocNumber matching Strata
- [ ] Update invoice → re-syncs to QBO
- [ ] Void invoice → voids in QBO

### Conflict Resolution
- [ ] DocNumber already taken in QBO → auto-increment, update Strata, notify user
- [ ] Invoice number changed → notification: "Invoice 1048 updated to 1049"
- [ ] Offline invoice synced later → gets QBO number, original number updated

### Payments
- [ ] Payment recorded in Strata → syncs to QBO
- [ ] QBO invoice balance updates correctly

### Error Handling
- [ ] Network error → retries with backoff
- [ ] Auth expired → marks connection as expired, notifies admin
- [ ] Conflict → surfaces in UI, doesn't block

### Performance
- [ ] Invoice form opens in < 1s (number fetch is fast)
- [ ] Invoice create < 500ms (sync is async)
- [ ] Batch job processes 30 invoices < 60s
- [ ] No visible latency in invoice CRUD

---

## Future Enhancements

1. **Bidirectional Sync** — Pull QBO changes back to Strata
2. **Bill Sync** — Sync vendor bills from Strata to QBO
3. **Chart of Accounts Mapping** — Custom account assignment per cost code
4. **Multi-currency** — Support international QBO companies
5. **Xero Support** — Same architecture, different adapter
6. **Desktop Sync** — QBO Desktop via Web Connector (complex, defer)

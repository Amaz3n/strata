# Midday Invoice System Integration Guide

## Overview

This guide explains how to integrate Midday's invoice system into your custom project management and billing application. The system provides beautiful invoice templates (HTML, PDF, and Open Graph), a rich text editor for invoice content, and comprehensive calculation utilities.

## Architecture Overview

The invoice system is organized into several key components:

1. **Templates** - Three rendering templates (HTML, PDF, OG)
2. **Editor** - Rich text editor component for invoice content
3. **Types** - TypeScript type definitions
4. **Utils** - Calculation and formatting utilities

## Key Components Breakdown

### 1. Invoice Templates

#### HTML Template (`packages/invoice/src/templates/html/`)
- **Purpose**: React component for displaying invoices in the browser
- **Usage**: Real-time preview, client-side rendering
- **Key Features**:
  - Responsive design (mobile/desktop)
  - Scrollable container
  - Live preview during editing
  - Uses Tailwind CSS for styling

#### PDF Template (`packages/invoice/src/templates/pdf/`)
- **Purpose**: Generate PDF invoices using `@react-pdf/renderer`
- **Usage**: Server-side PDF generation, email attachments
- **Key Features**:
  - Supports A4 and Letter sizes
  - Custom Inter font family
  - QR code generation (optional)
  - Professional formatting

#### Open Graph Template (`packages/invoice/src/templates/og/`)
- **Purpose**: Generate social media preview images
- **Usage**: Next.js `opengraph-image.tsx` route handlers
- **Key Features**:
  - 1200x630px standard OG image size
  - Uses Tailwind CSS for styling (via `tw` prop)
  - Custom fonts (GeistMono, GeistSans)

### 2. Invoice Editor

The editor system uses **Tiptap** (a headless rich text editor framework) for content editing.

**Location**: `apps/dashboard/src/components/invoice/editor.tsx`

**Key Features**:
- Rich text editing (bold, italic, underline, links)
- JSON-based content storage (Tiptap JSON format)
- Placeholder support
- Real-time content updates
- Used for: customer details, from details, payment details, notes, top/bottom blocks

**Dependencies**:
- `@tiptap/react` - Core editor
- `@tiptap/starter-kit` - Basic formatting
- `@tiptap/extension-link` - Link support
- `@tiptap/extension-underline` - Underline support
- `@tiptap/extension-placeholder` - Placeholder text

### 3. Data Structures

#### Invoice Type (`packages/invoice/src/types.ts`)

```typescript
export type Invoice = {
  id: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  amount: number | null;
  currency: string | null;
  lineItems: LineItem[];
  status: "draft" | "overdue" | "paid" | "unpaid" | "canceled" | "scheduled";
  
  // Rich text content (Tiptap JSON format)
  fromDetails: EditorDoc | null;
  customerDetails: EditorDoc | null;
  paymentDetails: EditorDoc | null;
  noteDetails: EditorDoc | null;
  topBlock: EditorDoc | null;
  bottomBlock: EditorDoc | null;
  
  // Tax/VAT/Discount
  vat: number | null;
  tax: number | null;
  discount: number | null;
  
  // Template configuration
  template: Template;
  
  // Customer info
  customerName: string | null;
  customerId: string | null;
  
  // Security token for public invoice links
  token: string;
  
  // File storage
  filePath: string[] | null;
};
```

#### LineItem Type

```typescript
export type LineItem = {
  name: string;
  quantity?: number;
  price?: number;
  unit?: string;
  productId?: string; // Optional reference for autocomplete
};
```

#### Template Type

```typescript
export type Template = {
  // Labels (customizable)
  title: string;
  customerLabel: string;
  fromLabel: string;
  invoiceNoLabel: string;
  issueDateLabel: string;
  dueDateLabel: string;
  descriptionLabel: string;
  priceLabel: string;
  quantityLabel: string;
  totalLabel: string;
  // ... more labels
  
  // Configuration
  logoUrl: string | null;
  currency: string;
  size: "a4" | "letter";
  dateFormat: "dd/MM/yyyy" | "MM/dd/yyyy" | "yyyy-MM-dd" | "dd.MM.yyyy";
  locale: string;
  timezone: string;
  
  // Feature flags
  includeVat: boolean;
  includeTax: boolean;
  includeDiscount: boolean;
  includeDecimals: boolean;
  includeUnits: boolean;
  includeQr: boolean;
  
  // Rates
  taxRate: number;
  vatRate: number;
  
  // Rich text defaults
  paymentDetails: EditorDoc | null;
  fromDetails: EditorDoc | null;
  noteDetails: EditorDoc | null;
};
```

#### EditorDoc Type (Tiptap JSON Format)

```typescript
export interface EditorDoc {
  type: "doc";
  content: EditorNode[];
}

export interface EditorNode {
  type: string; // "paragraph", etc.
  content?: InlineContent[];
}

interface InlineContent {
  type: string; // "text", "hardBreak"
  text?: string;
  marks?: Mark[]; // bold, italic, link, strike, underline
}
```

### 4. Utility Functions

#### Calculation (`packages/invoice/src/utils/calculate.ts`)

```typescript
// Calculate invoice totals
calculateTotal({
  lineItems,
  taxRate,
  vatRate,
  discount,
  includeVat,
  includeTax
})

// Calculate single line item total
calculateLineItemTotal({ price, quantity })
```

#### Content Transformation (`packages/invoice/src/utils/transform.ts`)

```typescript
// Convert customer data to EditorDoc format
transformCustomerToContent(customer)
```

#### Text Extraction (`packages/invoice/src/utils/extract-text.ts`)

```typescript
// Extract plain text from EditorDoc
extractText(content)
```

## Required Dependencies

### Core Dependencies

```json
{
  "@react-pdf/renderer": "^4.3.1",  // PDF generation
  "@tiptap/react": "^2.12.0",        // Rich text editor
  "@tiptap/starter-kit": "^2.12.0",  // Basic editor features
  "@tiptap/extension-link": "^2.12.0",
  "@tiptap/extension-underline": "^2.12.0",
  "@tiptap/extension-placeholder": "^2.12.0",
  "qrcode": "^1.5.4",                // QR code generation
  "date-fns": "^4.1.0"               // Date formatting
}
```

### UI Dependencies (from Midday UI package)

- ScrollArea component
- Form components (react-hook-form)
- Icons
- Tailwind CSS utilities

## Integration Steps

### Step 1: Copy Core Invoice Package

Copy the following directory structure to your project:

```
packages/invoice/
├── src/
│   ├── templates/
│   │   ├── html/          # React HTML template
│   │   ├── pdf/           # PDF template
│   │   └── og/            # Open Graph template
│   ├── utils/
│   │   ├── calculate.ts   # Calculation utilities
│   │   ├── content.ts     # Content utilities
│   │   ├── extract-text.ts
│   │   ├── transform.ts   # Data transformation
│   │   └── pdf-format.ts   # PDF formatting
│   ├── types.ts           # TypeScript types
│   └── index.tsx          # Package exports
```

### Step 2: Set Up Invoice Editor Component

Copy and adapt the editor component:

```
components/invoice/
├── editor.tsx             # Main editor component
├── form.tsx               # Invoice form wrapper
├── form-context.tsx       # Form state management
├── line-items.tsx         # Line items editor
├── customer-details.tsx   # Customer editor
├── from-details.tsx       # Company details editor
├── payment-details.tsx    # Payment info editor
├── note-details.tsx       # Notes editor
└── summary.tsx            # Totals summary component
```

**Key Implementation Notes**:
- Uses `react-hook-form` for form management
- Uses `zod` for validation
- Auto-saves drafts using debounced updates
- Integrates with your existing customer/project data

### Step 3: Create Invoice Data Model

Create a database schema or data model that matches the `Invoice` type:

**Required Fields**:
- `id` (UUID)
- `invoiceNumber` (string, unique)
- `issueDate` (timestamp)
- `dueDate` (timestamp)
- `amount` (decimal)
- `currency` (string)
- `lineItems` (JSONB array)
- `status` (enum)
- `fromDetails` (JSONB - EditorDoc)
- `customerDetails` (JSONB - EditorDoc)
- `paymentDetails` (JSONB - EditorDoc)
- `noteDetails` (JSONB - EditorDoc)
- `topBlock` (JSONB - EditorDoc, optional)
- `bottomBlock` (JSONB - EditorDoc, optional)
- `template` (JSONB - Template config)
- `vat`, `tax`, `discount` (decimal, nullable)
- `token` (string, for public links)
- `filePath` (string array, for PDF storage)

**Optional Fields**:
- `customerId` (reference to customer)
- `projectId` (reference to your project)
- `createdAt`, `updatedAt`
- `paidAt`, `sentAt`, `viewedAt`

### Step 4: Implement Invoice Creation Flow

1. **Trigger Point**: When a project completes billing workflow approval
2. **Data Mapping**: Map your project/billing data to invoice format:
   ```typescript
   const invoiceData = {
     invoiceNumber: generateInvoiceNumber(),
     issueDate: new Date().toISOString(),
     dueDate: calculateDueDate(issueDate, paymentTerms),
     lineItems: project.lineItems.map(item => ({
       name: item.description,
       quantity: item.hours,
       price: item.rate,
       unit: "hour"
     })),
     amount: approvedAmount,
     currency: project.currency,
     customerDetails: transformCustomerToContent(project.client),
     fromDetails: transformCustomerToContent(yourCompany),
     // ... other fields
   };
   ```

3. **Template Configuration**: Set up default template:
   ```typescript
   const defaultTemplate = {
     title: "Invoice",
     customerLabel: "Bill To",
     fromLabel: "From",
     invoiceNoLabel: "Invoice #",
     issueDateLabel: "Issue Date",
     dueDateLabel: "Due Date",
     currency: "USD",
     size: "letter",
     dateFormat: "MM/dd/yyyy",
     locale: "en-US",
     timezone: "America/New_York",
     includeVat: false,
     includeTax: true,
     includeDiscount: true,
     includeDecimals: true,
     includeUnits: true,
     includeQr: false,
     taxRate: 0,
     vatRate: 0,
     // ... labels
   };
   ```

### Step 5: Generate PDF

```typescript
import { PdfTemplate, renderToBuffer } from '@your-app/invoice';

// Generate PDF buffer
const pdfBuffer = await renderToBuffer(
  await PdfTemplate(invoiceData)
);

// Save to storage (S3, Supabase Storage, etc.)
await saveInvoicePDF(invoiceId, pdfBuffer);
```

### Step 6: Display HTML Preview

```typescript
import { HtmlTemplate } from '@your-app/invoice';

<HtmlTemplate 
  data={invoiceData} 
  width={800} 
  height={1000} 
/>
```

### Step 7: Generate Open Graph Image (Optional)

If using Next.js:

```typescript
// app/invoices/[id]/opengraph-image.tsx
import { OgTemplate } from '@your-app/invoice';
import { ImageResponse } from 'next/og';

export default async function Image({ params }) {
  const invoice = await getInvoice(params.id);
  
  return new ImageResponse(
    <OgTemplate data={invoice} isValidLogo={true} />,
    {
      width: 1200,
      height: 630,
      fonts: [/* load fonts */]
    }
  );
}
```

## QuickBooks Online (QBO) Integration

### Mapping Invoice Data to QBO Format

QBO uses a different data structure. You'll need to map Midday's invoice format to QBO's Invoice object:

```typescript
interface QBOInvoice {
  Line: Array<{
    DetailType: "SalesItemLineDetail" | "SubTotalLineDetail";
    Amount: number;
    Description?: string;
    SalesItemLineDetail?: {
      ItemRef: { value: string };
      UnitPrice: number;
      Qty: number;
    };
  }>;
  CustomerRef: { value: string };
  TxnDate: string; // YYYY-MM-DD
  DueDate: string; // YYYY-MM-DD
  DocNumber: string;
  CurrencyRef?: { value: string };
  PrivateNote?: string;
  EmailStatus?: "NotSet" | "NeedToSend" | "EmailSent";
}
```

### Conversion Function

```typescript
function convertToQBOInvoice(middayInvoice: Invoice, qboCustomerId: string): QBOInvoice {
  // Convert line items
  const qboLines = middayInvoice.lineItems.map(item => ({
    DetailType: "SalesItemLineDetail" as const,
    Amount: (item.price ?? 0) * (item.quantity ?? 0),
    Description: item.name,
    SalesItemLineDetail: {
      ItemRef: { value: item.productId || "default-item-id" },
      UnitPrice: item.price ?? 0,
      Qty: item.quantity ?? 1,
    },
  }));

  // Add subtotal line
  const subtotal = middayInvoice.lineItems.reduce(
    (sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0),
    0
  );
  
  qboLines.push({
    DetailType: "SubTotalLineDetail" as const,
    Amount: subtotal,
  });

  // Add tax line if applicable
  if (middayInvoice.template.includeTax && middayInvoice.tax) {
    qboLines.push({
      DetailType: "SalesItemLineDetail" as const,
      Amount: middayInvoice.tax,
      Description: `${middayInvoice.template.taxLabel} (${middayInvoice.template.taxRate}%)`,
      SalesItemLineDetail: {
        ItemRef: { value: "tax-item-id" },
        UnitPrice: middayInvoice.tax,
        Qty: 1,
      },
    });
  }

  // Add discount if applicable
  if (middayInvoice.template.includeDiscount && middayInvoice.discount) {
    qboLines.push({
      DetailType: "SalesItemLineDetail" as const,
      Amount: -middayInvoice.discount,
      Description: middayInvoice.template.discountLabel,
      SalesItemLineDetail: {
        ItemRef: { value: "discount-item-id" },
        UnitPrice: -middayInvoice.discount,
        Qty: 1,
      },
    });
  }

  return {
    Line: qboLines,
    CustomerRef: { value: qboCustomerId },
    TxnDate: format(middayInvoice.issueDate, "yyyy-MM-dd"),
    DueDate: format(middayInvoice.dueDate, "yyyy-MM-dd"),
    DocNumber: middayInvoice.invoiceNumber || "",
    CurrencyRef: { value: middayInvoice.currency || "USD" },
    PrivateNote: extractText(middayInvoice.noteDetails), // Convert EditorDoc to plain text
    EmailStatus: "NeedToSend",
  };
}
```

### QBO API Integration

Use the QuickBooks Online API (Intuit QuickBooks API v3) to create invoices:

```typescript
import { OAuthClient } from 'intuit-oauth';
import { QuickBooks } from 'node-quickbooks';

async function syncInvoiceToQBO(middayInvoice: Invoice) {
  // 1. Get QBO customer ID (map from your customer data)
  const qboCustomerId = await getQBOCustomerId(middayInvoice.customerId);
  
  // 2. Convert to QBO format
  const qboInvoice = convertToQBOInvoice(middayInvoice, qboCustomerId);
  
  // 3. Create invoice in QBO
  const qbo = new QuickBooks(
    qboClientId,
    qboClientSecret,
    qboAccessToken,
    qboAccessTokenSecret,
    qboCompanyId,
    true, // use sandbox
    true  // enable debug
  );
  
  return new Promise((resolve, reject) => {
    qbo.createInvoice(qboInvoice, (err, invoice) => {
      if (err) {
        reject(err);
      } else {
        resolve(invoice);
      }
    });
  });
}
```

### Recommended Flow

1. **Create Invoice in Your App**
   - User completes billing workflow
   - Invoice is created using Midday templates
   - PDF is generated and stored
   - Invoice is saved to your database

2. **Sync to QBO**
   - After invoice creation, trigger QBO sync
   - Map customer to QBO customer (create if doesn't exist)
   - Convert invoice data to QBO format
   - Create invoice in QBO
   - Store QBO invoice ID in your database for reference

3. **Handle Errors**
   - If QBO sync fails, mark invoice with sync status
   - Allow manual retry
   - Log errors for debugging

4. **Optional: Two-Way Sync**
   - If invoice is updated in QBO, sync back to your app
   - Handle payment status updates
   - Sync invoice number if QBO generates its own

## Key Considerations

### 1. Customer Data Mapping

You'll need to map your customer data to QBO customers:
- Create QBO customer if doesn't exist
- Store QBO customer ID mapping in your database
- Handle customer updates

### 2. Product/Item Mapping

QBO requires Item references for line items:
- Create QBO items for your services/products
- Map your line items to QBO items
- Handle custom items vs. standard items

### 3. Tax Configuration

QBO has complex tax handling:
- Set up tax codes in QBO
- Map your tax rates to QBO tax codes
- Handle different tax jurisdictions

### 4. Currency Handling

- Ensure currency codes match between systems
- Handle multi-currency if applicable

### 5. Invoice Numbering

- Decide: use your numbering or QBO's
- Handle conflicts if both systems generate numbers

## File Structure Recommendation

```
your-app/
├── packages/
│   └── invoice/              # Copied from Midday
│       └── src/
│           ├── templates/
│           ├── utils/
│           └── types.ts
├── components/
│   └── invoice/
│       ├── editor.tsx
│       ├── form.tsx
│       └── ...
├── lib/
│   └── qbo/
│       ├── client.ts         # QBO API client
│       ├── mapping.ts        # Data conversion functions
│       └── sync.ts           # Sync logic
├── app/
│   └── api/
│       └── invoices/
│           ├── route.ts      # Create invoice endpoint
│           └── [id]/
│               └── sync-qbo/ # QBO sync endpoint
└── db/
    └── schema.ts             # Invoice schema
```

## Testing Checklist

- [ ] Invoice creation from project data
- [ ] PDF generation
- [ ] HTML preview rendering
- [ ] Editor component functionality
- [ ] Calculation accuracy (subtotal, tax, total)
- [ ] QBO customer mapping
- [ ] QBO invoice creation
- [ ] Error handling for QBO sync failures
- [ ] Invoice number generation
- [ ] Date formatting
- [ ] Currency formatting
- [ ] Multi-line item handling
- [ ] Discount application
- [ ] Tax/VAT calculation

## Additional Resources

- **Tiptap Documentation**: https://tiptap.dev/
- **React PDF Renderer**: https://react-pdf.org/
- **QuickBooks API**: https://developer.intuit.com/app/developer/qbo/docs
- **QRCode Library**: https://www.npmjs.com/package/qrcode

## Next Steps

1. Copy the invoice package structure
2. Install required dependencies
3. Set up your invoice data model
4. Implement the invoice editor component
5. Create invoice generation flow
6. Implement QBO mapping and sync
7. Test end-to-end workflow
8. Add error handling and retry logic
9. Set up monitoring/logging

## Questions to Consider

1. **Invoice Numbering**: Will you use sequential numbers, or let QBO generate them?
2. **Customer Sync**: One-time sync or continuous sync?
3. **Payment Tracking**: Will payments be tracked in your app, QBO, or both?
4. **Email Sending**: Send from your app or QBO?
5. **PDF Storage**: Where will PDFs be stored? (S3, Supabase Storage, etc.)
6. **Multi-currency**: Do you need multi-currency support?
7. **Tax Complexity**: Simple tax rates or complex tax rules?

---

This guide provides a comprehensive overview of integrating Midday's invoice system. Adapt the components to fit your specific architecture and requirements.




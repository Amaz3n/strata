# Waiver template setup and generation

Settings → Templates → Waivers opens a three-stage workspace within the settings pane: bring a form, review/customize, and choose when to use it. Draft edits autosave; activation requires explicit review. Editing an active form creates a revision rather than rewriting an issued document.

## AI boundary

`waiver-template-extraction.ts` calls Arc's existing `runAiObject` gateway using the centrally configured `document_extraction` feature. It supplies the source PDF and native text, uses the gateway's PDF/vision support, structured validation, usage tracking and timeout behavior. No new provider SDK, model selection or API key is introduced.

The source is stored before extraction. `beginCompanyWaiverImport` schedules extraction with Next.js `after`; the client polls persisted status and can resume after navigation/reload in the same session. The route allows 180 seconds and extraction has a 120-second gateway budget. This is bounded background work, not a durable queue: a terminated invocation produces an interrupted-import message and requires retry. The original remains available.

AI produces a draft with unresolved review issues. It never runs when an invoice/payable waiver is issued. Native-text coverage and page checks help identify incomplete extraction; they do not certify the correctness of arbitrary imported wording. Users must review the result before activation.

## Document contract

`waiver-document.ts` stores versioned paragraphs, headings, tables, page breaks, signature sections, conditional sections, typed custom fields and normalized PDF placements. Tables can repeat covered invoice/payable items. Custom fields can use manual input, constants or approved Arc fields. Covered-item tokens are limited to repeating table rows.

Editable mode renders structured content with React PDF. Original mode preserves the uploaded PDF and overlays mapped values using PDF-lib. Original mode validates page existence, rotation, placement bounds and text fit; it refuses unsupported characters or clipping instead of silently dropping data. Exact source layout can therefore be retained without asking AI to reconstruct it.

`waiver-engine.ts` resolves values deterministically and prevents custom input from replacing Arc facts. It validates required values, currency/date/choice types, unknown tokens, exception coverage and additional signer roles. Template defaults are scoped by direction, jurisdiction, project and customer; equal-priority matches require a choice. Company template listing uses the newest eligible published revision and does not revive an older revision when a newer revision changes scope.

## Shared issuance path

`renderCompanyWaiver` is used by invoice and payable workflows. It validates values/signers, captures resolved values in workflow metadata and renders the approved document. Native signature placements are derived from original-PDF placements or actual rendered signature labels. Additional roles are included in signature envelopes; forms requiring additional signers or initials use signing links rather than inline self-signing.

Preview uses the same document renderers, debounces edits and caches source bytes. Usage-only changes do not regenerate previews. Persisted drafts update metadata with a concurrency check; published revisions remain immutable. Archiving removes the template family from future selection without altering issued PDFs.

Notarial sections and signer roles are document configuration, not an electronic notarization service. Automatic template selection does not establish legal suitability. Editable mode supports the defined block model; arbitrary typography and graphical layouts should use original mode.

## Verification

- Waiver regression suite: `node --test tests/*waiver*.test.js` (87 passing).
- TypeScript: `tsc --noEmit --pretty false` passes.
- Targeted ESLint for the new editor, preview, schemas, rendering, extraction and server actions passes.
- Real PDF tests verify preserved original text, mapped values, clipping/missing-page rejection, multipage covered-item tables and separate signature roles.
- Service tests verify authorization/org scoping, immutable revisions, import source retention, background completion/resume and interruption reporting.
- Live app verification covers the inline editor, preview, usage stage, draft save/reload/reopen and archiving the synthetic QA draft.
- Live AI provider extraction and externally delivered signature envelopes were not exercised in this verification. The extraction tests mock the gateway. No deployment, invoice delivery, signature request or payment was performed.

## Document-first setup

The primary setup screen is now `waiver-setup-workspace.tsx`: click a connected blank in the document, then choose existing Arc information, a constant answer, or an answer requested during preparation. Paragraph/block controls are reserved for Layout & advanced settings. Normal wording edits preserve tokens as non-editable labeled spans. Imported forms with usable page placements show clickable original-PDF blanks; older forms without usable placements fall back to the interactive transcription, with the original available separately.

Only used custom fields become setup questions. Notary-related fields are grouped by explicit section context and labels, without treating a project's state/county as notary information. This grouping does not bypass required-data validation or provide a notarization service. Original import issues are retained and grouped into wording, signing, and original/layout reviews.

Changing a built-in connection creates a template-local alias and rewrites text, tables, conditions, and PDF references together. It never overrides the underlying invoice/project facts. Replacing a PDF retains uniquely matching, type-compatible custom connections and applicability defaults while requiring a fresh review of the new document.

Filled examples support read-only invoice selection by project for outgoing forms, using the existing invoice-waiver preparation service and the same PDF renderer. The selected invoice total is explicitly an example waiver amount, not a determination of payment/check amount. Unknown values remain marked. Incoming forms use illustrative examples. Project-level storage for arbitrary custom answers and notarization completion remain separate capabilities; manual custom fields still ask at preparation.

Verification after this UI change: 93 waiver tests pass, TypeScript and targeted ESLint pass. Live UI checks cover the imported form, direct field selection, grouped setup, and example invoice loading. No template activation or invoice/signature delivery was performed.

Draft save concurrency uses a short `editable_waiver.editToken`, returned to the editor and rotated on each update. Both the client version and atomic database filter are checked. Legacy drafts acquire a token on their next save. The full document must never appear in a PostgREST equality filter: its URL size/content can be rejected by the gateway. Database errors are distinguished from a successful update matching zero rows. Regression verification: 95 waiver tests, TypeScript and targeted lint pass; the previously failing real draft saved successfully through the UI without changing its wording.

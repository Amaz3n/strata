require('../scripts/register-ts-node-test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDocumentSeed, proposalDocumentLabel } = require('../lib/precon/proposal-documents');
const { carryAcceptedBudgetScope, DEFAULT_ESTIMATE_COMMERCIAL } = require('../lib/financials/estimate-commercial');

test('document labels distinguish preliminary proposals and both agreement types', () => {
  assert.equal(proposalDocumentLabel({ purpose: 'budget', maturity: 'conceptual' }), 'Budget');
  assert.equal(proposalDocumentLabel({ purpose: 'budget', maturity: 'construction_ready' }), 'Budget');
  assert.equal(proposalDocumentLabel(DEFAULT_ESTIMATE_COMMERCIAL), 'Proposal & agreement');
  assert.equal(proposalDocumentLabel({ ...DEFAULT_ESTIMATE_COMMERCIAL, purpose: 'preconstruction_agreement' }), 'Preconstruction services agreement');
});

test('a fresh agreement cannot inherit a draft proposal autosave target', () => {
  const proposal = { id: 'original', status: 'draft', version: 3, updated_at: 'revision-token', title: 'Proposal', tax_rate: 7, lines: [{ description: 'Work', quantity: 1, unit: 'ls', unit_cost_cents: 50000, metadata: { notes: 'Keep exclusions' } }] };
  const agreement = freshDocumentSeed(proposal);
  for (const key of ['id', 'status', 'updated_at', 'version']) assert.equal(agreement[key], undefined);
  assert.equal(proposal.id, 'original'); assert.equal(proposal.status, 'draft');
  assert.equal(agreement.tax_rate, 7); assert.deepEqual(agreement.lines, proposal.lines);
});

test('approved proposal carry-forward preserves base scope and only accepted options', () => {
  const source = { id: 'approved', status: 'approved', version: 2, updated_at: 'token', lines: [
    { id: 'base', description: 'Base work', quantity: 1, unit_cost_cents: 10000 },
    { id: 'chosen', description: 'Chosen finish', quantity: 1, unit_cost_cents: 2000, is_optional: true },
    { id: 'unselected', description: 'Other finish', quantity: 1, unit_cost_cents: 3000, is_optional: true },
  ] };
  const agreement = { ...freshDocumentSeed(source), source_budget_estimate_id: source.id, lines: carryAcceptedBudgetScope(source.lines, ['chosen']) };
  assert.deepEqual(agreement.lines.map(line => line.description), ['Base work', 'Chosen finish']);
  assert.ok(agreement.lines.every(line => !line.is_optional));
  assert.equal(agreement.source_budget_estimate_id, 'approved');
  assert.equal(source.lines.length, 3); assert.equal(source.status, 'approved');
});

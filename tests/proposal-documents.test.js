require('../scripts/register-ts-node-test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDocumentSeed, proposalDocumentLabel } = require('../lib/precon/proposal-documents');
const { carryAcceptedBudgetScope, DEFAULT_ESTIMATE_COMMERCIAL } = require('../lib/financials/estimate-commercial');

test('a deal sends one document, the proposal, whether it is signed or approved', () => {
  assert.equal(proposalDocumentLabel({ purpose: 'budget', maturity: 'conceptual' }), 'Proposal');
  assert.equal(proposalDocumentLabel(DEFAULT_ESTIMATE_COMMERCIAL), 'Proposal');
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

const {
  BUILT_IN_PROPOSAL_DEFAULTS,
  EMPTY_DEAL_PROPOSAL,
  exclusionSuggestions,
  paymentAmounts,
  normalizeProposalLayout,
  proposalChanges,
  proposalNeeds,
  proposalPriceLines,
  proposalSectionStates,
  proposalTemplateFromText,
  resolveProposalDocument,
} = require('../lib/precon/proposal-documents');

const NAMES = { client: 'Elena and David', project: 'Ramos kitchen', builder: 'Northline', sender: 'Agustin' };
const LINES = proposalPriceLines([
  { item_type: 'group', description: 'Kitchen', quantity: 1, unit_cost_cents: 0 },
  { description: 'Cabinets', quantity: 1, unit_cost_cents: 3_000_000, notes: 'Painted maple, 28 LF' },
  { description: 'Tile backsplash', quantity: 1, unit_cost_cents: 650_000, is_allowance: true },
  { description: 'Heated floor', quantity: 1, unit_cost_cents: 480_000, is_optional: true },
]);
const resolve = (kind, proposal = EMPTY_DEAL_PROPOSAL) => resolveProposalDocument({
  proposal, defaults: BUILT_IN_PROPOSAL_DEFAULTS, kind, lines: LINES, names: NAMES,
  primarySigner: { name: 'Elena Ramos', email: 'elena@example.com' }, today: new Date('2026-10-18T12:00:00Z'),
});

test('a proposal resolves its sections from the price and the builder defaults', () => {
  const budget = resolve('budget');
  assert.match(budget.cover, /^Dear Elena and David,/);
  assert.deepEqual(budget.scope, [{ section: 'Kitchen', text: 'Painted maple, 28 LF.', lines: ['Cabinets', 'Tile backsplash'] }]);
  assert.deepEqual(budget.allowances.map(item => item.description), ['Tile backsplash']);
  assert.deepEqual([budget.payments, budget.signers], [[], []], 'a budget is approved, not signed or billed');
  assert.equal(budget.valid_until, '2026-11-17');
  const agreement = resolve('agreement', { ...EMPTY_DEAL_PROPOSAL, co_signers: [{ name: 'David Ramos', email: 'david@example.com' }] });
  assert.equal(agreement.payments.length, 4);
  assert.deepEqual(agreement.signers.map(signer => signer.name), ['Elena Ramos', 'David Ramos']);
});

test('saving a letter as the default turns this deal\'s names back into fields', () => {
  const letter = 'Dear Elena and David,\nThanks for choosing Northline for the Ramos kitchen.\nAgustin';
  assert.equal(proposalTemplateFromText(letter, NAMES), 'Dear {client},\nThanks for choosing {builder} for the {project}.\n{sender}');
});

test('payments bill exactly the price, the last absorbing rounding', () => {
  const amounts = paymentAmounts(1_000_001, [{ percent: 33.33 }, { percent: 33.33 }, { percent: 33.34 }]);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 1_000_001);
  assert.deepEqual(paymentAmounts(1_000_000, [{ percent: 10 }, { percent: 30 }]), [100_000, 300_000], 'a partial schedule is not padded');
});

test('a bid\'s exclusions are suggested once, until the builder rules on them', () => {
  const bids = [{ submissionId: 's1', company: 'Volt & Co', exclusions: ['Low-voltage wiring', 'Patching outside work areas'] }];
  const open = exclusionSuggestions(bids, EMPTY_DEAL_PROPOSAL, ['patching outside work areas']);
  assert.deepEqual(open.map(item => [item.text, item.from]), [['Low-voltage wiring', "Volt & Co's bid"]]);
  assert.deepEqual(exclusionSuggestions(bids, { suggestions: { [open[0].key]: 'covered' } }, []).map(item => item.text), ['Patching outside work areas']);
});

const states = (kind, proposal) => proposalSectionStates({
  proposal, defaults: BUILT_IN_PROPOSAL_DEFAULTS, document: resolve(kind, proposal), priceLabel: '$41,300', optionCount: 1,
  openSuggestions: 0, unansweredComments: 1, answered: 0, clientName: 'Elena',
});

test('sections report what needs the builder, and a range leaves the signing sections out', () => {
  const range = states('budget', EMPTY_DEAL_PROPOSAL);
  assert.deepEqual(range.filter(state => state.tone === 'off').map(state => state.key), ['payments', 'signatures']);
  assert.deepEqual(proposalNeeds(range).map(state => state.key), ['questions'], 'a range needs no start window');
  const lopsided = { ...EMPTY_DEAL_PROPOSAL, payments: [{ id: 'a', name: 'Deposit', when: '', percent: 50 }] };
  assert.deepEqual(proposalNeeds(states('agreement', lopsided)).map(state => [state.key, state.label]), [
    ['payments', 'Adds to 50%, needs 100%'], ['schedule', 'Set a start window, or turn this section off'], ['questions', 'Elena asked 1 question'],
  ]);
});

test('the builder turns sections off, renames, reorders and adds their own', () => {
  const layout = normalizeProposalLayout([
    { key: 'scope', title: 'What we will build', on: true, body: '' },
    { key: 'custom:warranty', title: 'Warranty', on: true, body: 'One year on workmanship.' },
    { key: 'schedule', title: null, on: false, body: '' },
    { key: 'inclusions', title: null, on: false, body: '' },
    { key: 'price', title: null, on: false, body: '' },
  ]);
  assert.equal(layout.find(entry => entry.key === 'price').on, true, 'the price cannot be turned off');
  assert.equal(layout.filter(entry => entry.key === 'cover').length, 1, 'every built-in section appears once');

  const proposal = { ...EMPTY_DEAL_PROPOSAL, layout };
  const document = resolve('agreement', proposal);
  const keys = document.sections.map(section => section.key);
  assert.deepEqual(keys.slice(0, 3), ['scope', 'custom:warranty', 'price'], 'the document reads in the builder\'s order');
  assert.ok(!keys.includes('schedule') && !keys.includes('inclusions'));
  assert.equal(document.sections[0].title, 'What we will build');
  assert.equal(document.sections[1].body, 'One year on workmanship.');
  assert.deepEqual([document.start_window, document.inclusions, document.exclusions], ['', [], []], 'an off section says nothing');
  assert.deepEqual(proposalNeeds(states('agreement', proposal)).map(state => state.key), ['questions'], 'an off section needs nothing');

  const blank = { ...EMPTY_DEAL_PROPOSAL, layout: [{ key: 'custom:notes', title: null, on: true, body: '' }] };
  const notes = states('agreement', blank).find(state => state.key === 'custom:notes');
  assert.deepEqual([notes.name, notes.tone], ['Untitled section', 'needs']);
  assert.ok(!resolve('agreement', blank).sections.some(section => section.key === 'custom:notes' && section.body));
});

test('a proposal turns its payment schedule off without breaking the send', () => {
  const layout = normalizeProposalLayout([{ key: 'payments', title: null, on: false, body: '' }]);
  const document = resolve('agreement', { ...EMPTY_DEAL_PROPOSAL, layout });
  assert.deepEqual(document.payments, []);
  assert.ok(document.signers.length > 0, 'it is still signed');
});

test('the client hears what changed since the version they have', () => {
  const previous = { kind: 'budget', version: 1, sent_at: '2026-10-01', total_cents: 4_000_000, range: { low: 3_800_000, high: 4_300_000 }, options: [], exclusions: [], payments: 0, start_window: '', signers: [] };
  const next = { ...previous, kind: 'agreement', version: 2, total_cents: 4_130_000, range: null, options: ['Heated floor'], exclusions: ['Low-voltage wiring'], payments: 4, start_window: 'in January', signers: ['Elena Ramos'] };
  assert.deepEqual(proposalChanges(previous, next).map(change => change.label), ['Price', 'Options', 'Not included', 'New']);
  assert.match(proposalChanges(previous, next)[0].text, /inside the \$38,000–\$43,000 budget range/);
  assert.deepEqual(proposalChanges(null, next), [], 'a first send has nothing to compare');
});

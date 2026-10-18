require('../scripts/register-ts-node-test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dealDocumentSlot } = require('../lib/precon/deal-documents');
const doc = (id, purpose, extra = {}) => ({ id, title: id, org_id: 'org', version: 1, status: 'draft', created_at: '2026-09-22T10:00:00Z', metadata: { precon: { purpose } }, ...extra });

test('deal shows one current proposal, with all earlier records retained in history', () => {
  const documents = [doc('old-family', 'budget'), doc('v1', 'budget', { is_current_version: false }), doc('v2', 'budget', { version: 2, created_at: '2026-09-22T12:00:00Z' })];
  const result = dealDocumentSlot(documents, 'budget');
  assert.equal(result.current.id, 'v2'); assert.equal(result.versions.length, 3);
  assert.equal(documents[0].id, 'old-family');
});
test('services and construction agreements occupy separate slots', () => {
  const documents = [doc('proposal', 'budget'), doc('construction', 'construction_agreement'), doc('services', 'preconstruction_agreement')];
  assert.equal(dealDocumentSlot(documents, 'construction_agreement').current.id, 'construction');
  assert.equal(dealDocumentSlot(documents, 'preconstruction_agreement').current.id, 'services');
});
test('superseded documents remain historical instead of becoming editable current drafts', () => {
  const result = dealDocumentSlot([doc('old', 'budget', { is_current_version: false })], 'budget');
  assert.equal(result.current, undefined); assert.equal(result.versions.length, 1);
});

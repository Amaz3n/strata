require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { EMPTY_PRECON_BRIEF } = require('../lib/precon/workspace')
const { pricingBriefVersion } = require('../lib/precon/brief-revision')
const { pricingBasisChanges } = require('../lib/precon/pricing-basis')

test('documents compare against the pricing marker, not the record version', () => {
  const brief = {...EMPTY_PRECON_BRIEF, scope: 'Kitchen remodel', pricing_revision: 7}
  assert.equal(pricingBriefVersion(brief, 8), 7)
  assert.equal(pricingBriefVersion(EMPTY_PRECON_BRIEF, 8), 8)
  assert.deepEqual(pricingBasisChanges({brief_version:7}, {files:[],drawings:[]}, pricingBriefVersion(brief,8)), [])
})

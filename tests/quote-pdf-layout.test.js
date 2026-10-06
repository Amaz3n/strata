const test = require('node:test')
const assert = require('node:assert/strict')
require('../scripts/register-ts-node-test')
const { renderQuotePdf } = require('../lib/pdfs/quote-document')

async function pages(data) {
  const buffer = await renderQuotePdf(data)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise
  try {
    const result = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      result.push(content.items.filter(item => 'str' in item).map(item => item.str).join(' ').replace(/\s+/g, ' '))
    }
    return result
  } finally { await doc.destroy() }
}
const base = { variant: 'estimate', documentLabel: 'Proposal', title: 'Kitchen renovation', orgName: 'Sample Builder', recipientName: 'Sample Owner', totalCents: 12000, subtotalCents: 10000, taxCents: 1000, contingencyCents: 1000, lines: [{ description: 'Cabinet installation', quantity: 1, unit_cost_cents: 8000, markup_pct: 25 }] }

test('proposal preserves sell pricing and shows a reconciling tax and contingency breakdown', async () => {
  const text = (await pages(base)).join(' ')
  assert.match(text, /Tax.*\$10\.00/)
  assert.match(text, /Contingency.*\$10\.00/)
  assert.match(text, /Subtotal.*\$100\.00/)
  assert.match(text, /Total.*\$120\.00 USD/)
  assert.doesNotMatch(text, /\$80\.00/)
  assert.doesNotMatch(text, /Acceptance & Signatures/)
})
test('accepted options reconcile the subtotal and hide rejected work on agreements', async () => {
  const text = (await pages({ ...base, variant: 'proposal', documentLabel: 'Construction agreement', totalCents: 14500, taxCents: 1000, hideUnacceptedOptionals: true, acceptedOptionalIds: ['lighting'], lines: [...base.lines, {id:'lighting', description:'Selected lighting', unit_cost_cents:2500, metadata:{is_optional:true}}, {id:'extra', description:'Rejected extra',unit_cost_cents:9000,metadata:{is_optional:true}}], signers:[{name:'Sample Owner',role:'Owner'},{name:'Sample Builder',role:'Builder'}] })).join(' ')
  assert.match(text, /Selected lighting/)
  assert.doesNotMatch(text, /Rejected extra/)
  assert.match(text, /Subtotal.*\$125\.00/)
  assert.match(text, /Acceptance & Signatures/)
  assert.match(text, /Signature.*Owner/)
  assert.match(text, /Signature.*Builder/)
})
test('long terms flow across pages without dropping their ending or signatures', async () => {
  const textPages = await pages({ ...base, variant:'proposal', terms: Array.from({length:70},(_,i)=>`Condition ${i+1}: Written approval is required before changes to the agreed scope.`).join('\n\n'), signers:[{name:'Final signer',role:'Owner'}] })
  assert.ok(textPages.length > 2)
  assert.match(textPages.join(' '), /Condition 70:/)
  assert.match(textPages.at(-1), /Final signer/)
  assert.match(textPages.at(-1), new RegExp(`Page ${textPages.length} of ${textPages.length}`))
})
test('lump sum documents do not expose unit or line pricing', async () => {
  const text = (await pages({...base, pricingDisplay:'lump_sum'})).join(' ')
  assert.match(text, /Cabinet installation/)
  assert.doesNotMatch(text, /\$100\.00/)
  assert.match(text, /\$120\.00 USD/)
})

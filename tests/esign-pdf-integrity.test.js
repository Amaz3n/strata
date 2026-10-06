const test = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync } = require('node:crypto')
const sharp = require('sharp')
const { PDFDocument, degrees } = require('pdf-lib')
require('../scripts/register-ts-node-test')
const { generateExecutedPdf, signingPageGeometry, formatSigningDate } = require('../lib/pdfs/esign')
const { parseSignerFieldValues, validateSignaturePng } = require('../lib/esign/field-values')
const { createESignEvidenceManifest, verifyESignEvidenceManifest } = require('../lib/esign/evidence')
const { assertElectronicSignatureConsent, ELECTRONIC_SIGNATURE_CONSENT_TEXT } = require('../lib/esign/consent')

async function source(rotation = 0) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([640, 840])
  page.setCropBox(20, 30, 600, 780)
  page.setRotation(degrees(rotation))
  return pdf.save()
}
const field = { id: 'owner-name', field_type: 'name', signer_role: 'owner', required: true, page_index: 0, x: .1, y: .15, w: .55, h: .08 }
async function textContent(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
  try {
    const result = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      result.push({ viewport: page.getViewport({ scale: 1 }), text: (await page.getTextContent()).items.filter(i => 'str' in i) })
    }
    return result
  } finally { await pdf.destroy() }
}

 test('signed PDF embeds Latin and CJK names and a readable evidence appendix', async () => {
  const bytes = await generateExecutedPdf({ pdfBytes: await source(), fields: [field], values: { [field.id]: 'José 张伟' }, auditTrail: [{ label: 'Signer', value: 'José 张伟' }] })
  const pages = await textContent(bytes)
  assert.equal(pages.length, 2)
  for (const page of pages) assert.match(page.text.map(item => item.str).join(''), /José 张伟/)
})

for (const rotation of [0, 90, 180, 270]) {
  test(`signing fields match the displayed cropped page at ${rotation} degrees`, async () => {
    const bytes = await generateExecutedPdf({ pdfBytes: await source(rotation), fields: [field], values: { [field.id]: 'Position' } })
    const [page] = await textContent(bytes)
    const item = page.text.find(item => item.str === 'Position')
    assert.ok(item)
    const [a, b, c, d, e, f] = page.viewport.transform
    const [, , , , tx, ty] = item.transform
    const screenX = a * tx + c * ty + e
    const screenY = b * tx + d * ty + f
    const width = page.viewport.width, height = page.viewport.height
    assert.ok(screenX >= field.x * width && screenX < (field.x + field.w) * width, `x ${screenX}`)
    assert.ok(screenY > field.y * height && screenY <= (field.y + field.h) * height, `y ${screenY}`)
  })
}

test('renderer rejects nonexistent pages, overflow, unsupported glyphs, and out-of-page rectangles', async () => {
  const pdfBytes = await source()
  await assert.rejects(generateExecutedPdf({ pdfBytes, fields: [{ ...field, page_index: 3 }], values: {} }), /outside/)
  await assert.rejects(generateExecutedPdf({ pdfBytes, fields: [{ ...field, x: .95 }], values: {} }), /outside/)
  await assert.rejects(generateExecutedPdf({ pdfBytes, fields: [field], values: { [field.id]: 'Too much content '.repeat(300) } }), /does not fit/)
  await assert.rejects(generateExecutedPdf({ pdfBytes, fields: [field], values: { [field.id]: '\u{1f680}' } }), /characters not supported/)
})

test('font-size and date-format metadata survive into the executed PDF', async () => {
  const dateField = { ...field, id: 'date', y: .3, field_type: 'date', metadata: { dateFormat: 'DD/MM/YYYY', fontSize: '10', fontFamily: 'mono' } }
  const bytes = await generateExecutedPdf({ pdfBytes: await source(), fields: [dateField], values: { date: '2026-10-03' } })
  const [page] = await textContent(bytes)
  assert.ok(page.text.some(item => item.str === '03/10/2026'))
  assert.equal(formatSigningDate('2026-10-03', 'MMM D, YYYY'), 'Oct 3, 2026')
})

test('required values are scoped to the recipient and foreign values cannot overwrite another signer', async () => {
  const fields = [field, { ...field, id: 'builder-name', signer_role: 'builder' }]
  const values = await parseSignerFieldValues({ fields, signerRole: 'owner', values: { [field.id]: 'Owner' } })
  assert.deepEqual(Object.keys(values), [field.id])
  await assert.rejects(parseSignerFieldValues({ fields, signerRole: 'owner', values: { [field.id]: 'Owner', 'builder-name': 'Changed' } }), /not assigned/)
  await assert.rejects(parseSignerFieldValues({ fields, signerRole: 'owner', values: {} }), /required/)
  await assert.rejects(parseSignerFieldValues({ fields, signerRole: 'owner', values: { [field.id]: { text: 'bad' } } }), /must be text/)
  await assert.rejects(parseSignerFieldValues({ fields, signerRole: 'owner', values: { [field.id]: 'a'.repeat(4001) } }), /too long/)
})

test('legacy unassigned fields belong only to the client and typed fields reject invalid data', async () => {
  await assert.rejects(parseSignerFieldValues({ fields: [{ ...field, signer_role: null }], signerRole: 'builder', values: { [field.id]: 'Other signer' } }), /not assigned/)
  const date = { ...field, field_type: 'date' }
  await assert.rejects(parseSignerFieldValues({ fields: [date], signerRole: 'owner', values: { [field.id]: '2026-02-30' } }), /valid date/)
  await assert.rejects(parseSignerFieldValues({ fields: [{ ...field, field_type: 'checkbox' }], signerRole: 'owner', values: { [field.id]: 'true' } }), /true or false/)
  for (const [validation, good, bad] of [['email', 'person@example.test', 'not an email'], ['number', '-12.50', '1e5']]) {
    const validatedField = { ...field, field_type: 'text', metadata: { validation } }
    assert.equal((await parseSignerFieldValues({ fields: [validatedField], signerRole: 'owner', values: { [field.id]: good } }))[field.id], good)
    await assert.rejects(parseSignerFieldValues({ fields: [validatedField], signerRole: 'owner', values: { [field.id]: bad } }), /valid/)
  }
})

test('PNG validation decodes pixels and rejects invalid, oversized and blank signatures before acceptance', async () => {
  const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#000000' } }).png().toBuffer()
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  assert.match(await validateSignaturePng(dataUrl), /^data:image\/png;base64,/)
  await assert.rejects(validateSignaturePng('not-a-signature'), /PNG image/)
  await assert.rejects(validateSignaturePng(`data:image/png;base64,${png.subarray(0, 40).toString('base64')}`), /cannot be decoded/)
  await assert.rejects(validateSignaturePng(`data:image/png;base64,${'A'.repeat(800000)}`), /512 KB/)
  const blank = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#ffffff' } }).png().toBuffer()
  await assert.rejects(validateSignaturePng(`data:image/png;base64,${blank.toString('base64')}`), /cannot be decoded/)
  const bytes = await generateExecutedPdf({ pdfBytes: await source(), fields: [{ ...field, field_type: 'signature' }], values: { [field.id]: dataUrl } })
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1)
})

test('evidence manifest detects changes and requires a separately trusted issuer key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const trustedPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const payload = { document_id: 'doc', source_sha256: 'source', executed_sha256: 'executed', signers: [{ name: 'José 张伟' }] }
  const manifest = createESignEvidenceManifest(payload, privatePem)
  assert.equal(verifyESignEvidenceManifest(JSON.parse(JSON.stringify(manifest)), trustedPem), true)
  assert.equal(verifyESignEvidenceManifest({ ...manifest, payload: { ...payload, executed_sha256: 'changed' } }, trustedPem), false)
  const otherPem = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
  assert.equal(verifyESignEvidenceManifest(manifest, otherPem), false)
  assert.equal(verifyESignEvidenceManifest({ ...manifest, public_key_pem: otherPem }, trustedPem), false)
  assert.equal(createESignEvidenceManifest(payload, ''), null)
})

test('consent must match the versioned server-owned text', () => {
  assert.doesNotThrow(() => assertElectronicSignatureConsent(ELECTRONIC_SIGNATURE_CONSENT_TEXT))
  assert.throws(() => assertElectronicSignatureConsent('I accepted different terms'), /current electronic signature consent/)
})

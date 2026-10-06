require('../scripts/register-ts-node-test')
require.extensions['.css'] = () => {}
const test = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { PdfFieldViewer } = require('../app/d/[token]/components/pdf-field-viewer')
const { ReviewStep } = require('../app/d/[token]/components/review-step')
const noop = () => {}
const field = (id, role, type='text') => ({id,signer_role:role,field_type:type,label:`Field ${id}`,page_index:0,x:.1,y:.1,w:.2,h:.05})

test('signer sees previous and current completed values rather than placeholder labels', () => {
  const html=renderToStaticMarkup(React.createElement(PdfFieldViewer, {
    PDFComponents:{Document:({children})=>React.createElement('div',null,children),Page:()=>React.createElement('div',null,'PDF')},fileUrl:'/test',
    fieldsByPage:{0:[field('prior','first'),field('own','second'),field('check','second','checkbox')]}, signerRole:'second',
    values:{prior:'Previously agreed price',own:'Corrected scope',check:false},activeFieldId:null,currentPageIndex:0,pageCount:1,
    onFieldSelect:noop,onPageChange:noop,onPageCountChange:noop,onApplyFieldValue:noop,onSignatureRequested:noop,
  }))
  assert.match(html,/Previously agreed price/)
  assert.match(html,/Corrected scope/)
  assert.match(html,/role="checkbox"/)
  assert.match(html,/aria-checked="false"/)
  assert.match(html,/aria-label="Field check"/)
})

test('review presents actual answers and signature preview before consent', () => {
  const html=renderToStaticMarkup(React.createElement(ReviewStep, {
    documentTitle:'Agreement',signerName:'Jane',signerEmail:'jane@example.com',values:{own:'Scope accepted',sig:'data:image/png;base64,test'},
    visibleFields:[field('own','second'),field('sig','second','signature')],consentChecked:false,isSubmitting:false,
    onSignerNameChange:noop,onSignerEmailChange:noop,onConsentChange:noop,onBack:noop,onSubmit:noop,
  }))
  assert.match(html,/Scope accepted/)
  assert.match(html,/Field sig preview/)
  assert.match(html,/disabled=""/)
})

test('an optional invalid email blocks review submission until corrected or cleared', () => {
  const html=renderToStaticMarkup(React.createElement(ReviewStep, {
    documentTitle:'Agreement',signerName:'Jane',signerEmail:'jane@example.com',values:{own:'invalid'},
    visibleFields:[{...field('own','second'),required:false,metadata:{validation:'email'}}],consentChecked:true,isSubmitting:false,
    onSignerNameChange:noop,onSignerEmailChange:noop,onConsentChange:noop,onBack:noop,onSubmit:noop,
  }))
  assert.match(html,/correct invalid values/)
  assert.match(html,/disabled=""/)
})

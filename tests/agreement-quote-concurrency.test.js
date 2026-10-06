require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const test = require("node:test")

// Runs the actual form with deterministic hook/effect scheduling and action promises.
// This proves state/race behavior, not browser layout or authenticated integration.
function form() {
  const slots = [], effects = [], timers = new Map(), quotes = [], creates = [], toasts = [], closes = [], refreshes = []
  let cursor = 0, timerId = 0, createResult = { success: true, data: { signing: { documentId: "document", envelopeId: "envelope", reason: null } } }, transitionPending = false
  const equal = (a,b) => a && b && a.length === b.length && a.every((x,i) => Object.is(x,b[i]))
  const hooks = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }] },
    useRef(value) { const i = cursor++; slots[i] ??= { current: value }; return slots[i] },
    useMemo(fn,deps) { const i = cursor++; if (!equal(slots[i]?.deps,deps)) slots[i] = { deps, value: fn() }; return slots[i].value },
    useEffect(fn,deps) { const i = cursor++; if (!equal(slots[i]?.deps,deps)) { effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() } }); } },
    useLayoutEffect(fn,deps) { hooks.useEffect(fn,deps) },
    useTransition() { return [transitionPending, fn => { transitionPending = true; Promise.resolve(fn()).finally(() => { transitionPending = false }) }] },
  }
  const context = { reservationId: 'reservation', lotId: 'lot', buyerEmail: 'buyer@example.test', versions: [{ id: 'version' }], elevations: [], swing: 'either', structuralOptions: [], designSelections: [], packages: [], incentives: [] }
  const compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../components/sales/purchase-agreement-sheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText + "\nexports.CatalogSection = CatalogSection;", {
    exports: compiled.exports,
    setTimeout(fn) { const id = ++timerId; timers.set(id,fn); return id }, clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name === '@/lib/sales/agreement-catalog') return require('../lib/sales/agreement-catalog')
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx: (type,props) => ({ type,props }), jsxs: (type,props) => ({ type,props }) }
      if (name === 'next/navigation') return { useRouter: () => ({ refresh() { refreshes.push(true) } }) }
      if (name === '@/hooks/use-toast') return { useToast: () => ({ toast(value) { toasts.push(value) } }) }
      if (name === '@/lib/action-result') return { unwrapAction: result => { if (!result.success) throw new Error(result.error); return result.data } }
      if (name === '@/lib/utils') return { cn: () => '', formatMoneyCents: String }
      if (name.endsWith('/sales/actions')) return {
        getAgreementDraftContextAction: async reservationId => ({ success: true, data: { ...context, reservationId } }),
        priceAgreementDraftAction: input => new Promise(resolve => quotes.push({ input, resolve })),
        createPurchaseAgreementAction: async input => { creates.push(input); return createResult },
      }
      return new Proxy({}, { get: (_,key) => String(key) })
    },
  })
  const props = { reservationId: 'reservation', open: true, onOpenChange(value) { closes.push(value) } }
  function render(commit = true) {
    cursor = 0
    const tree = compiled.exports.PurchaseAgreementSheet(props)
    if (commit) { const pending = effects.splice(0); for (const effect of pending) effect() }
    return tree
  }
  function nodes(tree, predicate) {
    if (!tree || typeof tree !== 'object') return []
    if (Array.isArray(tree)) return tree.flatMap(item => nodes(item,predicate))
    return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children,predicate)]
  }
  const submit = tree => nodes(tree,node => node.type === 'Button' && ['Write & send for signature','Sending…'].includes(node.props.children))[0]
  const swing = tree => nodes(tree,node => node.type === 'Picker' && node.props.placeholder === 'Choose left or right')[0]
  async function flush() { for(let i=0;i<10;i++) await Promise.resolve() }
  async function fire() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) timer(); await flush() }
  return { render, submit, swing, props, context, quotes, creates, toasts, closes, refreshes, flush, fire, nodes, unmount: () => { for(const slot of slots) slot?.cleanup?.() }, setCreateResult: value => { createResult = value }, renderCatalog: props => { cursor = 0; return compiled.exports.CatalogSection(props) } }
}

test('older quote responses cannot enable submission after a swing change', async () => {
  const f = form()
  f.render(); await f.flush()
  let tree = f.render(); await f.fire()
  f.swing(tree).props.onChange('left'); tree = f.render(); await f.fire()
  const left = f.quotes.at(-1)
  left.resolve({ success: true, data: { quoteHash:"a".repeat(64), totalCents: 100 } }); await f.flush(); tree = f.render()
  assert.equal(f.submit(tree).props.disabled, false)
  f.swing(tree).props.onChange('right')
  // Even before the effect clears pricing, the configuration key blocks the old quote.
  tree = f.render(false)
  assert.equal(f.submit(tree).props.disabled, true)
  assert.equal(f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'PriceSummary').length,0)
  f.render(); await f.fire()
  const right = f.quotes.at(-1)
  f.quotes[0].resolve({ success: true, data: { quoteHash:"a".repeat(64), totalCents: 1 } }); await f.flush(); tree = f.render()
  assert.equal(f.submit(tree).props.disabled, true)
  right.resolve({ success: true, data: { quoteHash:"a".repeat(64), totalCents: 200 } }); await f.flush(); tree = f.render()
  assert.equal(f.submit(tree).props.disabled, false)
  f.submit(tree).props.onClick(); await f.flush()
  assert.equal(f.creates[0].swing, 'right')
  assert.equal(f.creates[0].elevationId, null)
  f.swing(tree).props.onChange('')
  assert.equal(f.submit(f.render(false)).props.disabled, true)
})

test('closing or switching the reservation blocks submission of the prior context', async () => {
  const f = form()
  f.render(); await f.flush(); let tree = f.render()
  f.swing(tree).props.onChange('left'); f.render(); await f.fire()
  f.quotes.at(-1).resolve({ success: true, data: { quoteHash:"a".repeat(64), totalCents: 100 } }); await f.flush()
  assert.equal(f.submit(f.render()).props.disabled,false)
  f.props.reservationId = 'another'
  tree = f.render(false)
  assert.equal(f.submit(tree).props.disabled,true)
  f.submit(tree).props.onClick()
  assert.equal(f.creates.length,0)
  f.props.open = false
  assert.equal(f.submit(f.render(false)).props.disabled,true)
})

test('the actual catalog section pages/searches a large set without dropping selected items', () => {
  const f = form(), picks = [{ optionId: 'option-99' }], changes = []
  const props = { title: 'Structural options', hint: '', items: Array.from({ length: 100 },(_,i) => ({ optionId: `option-${i}`, label: `Option ${i}`, category: 'Structure',priceCents: i*100 })), picks, onToggle: item => changes.push(item) }
  const rows = tree => f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'Row')
  const button = (tree,label) => f.nodes(tree,node => node.type === 'Button' && node.props['aria-label'] === label)[0]
  let tree = f.renderCatalog(props)
  assert.equal(rows(tree).length,40)
  button(tree,'Next structural options page').props.onClick(); tree = f.renderCatalog(props)
  assert.equal(rows(tree)[0].props.label,'Option 40')
  button(tree,'Show selected structural options').props.onClick(); tree = f.renderCatalog(props)
  assert.equal(rows(tree).length,1)
  assert.equal(rows(tree)[0].props.label,'Option 99')
  assert.equal(rows(tree)[0].props.selected,true)
  const search = f.nodes(tree,node => node.type === 'Input')[0]
  search.props.onChange({ target: { value: 'missing' } }); tree = f.renderCatalog(props)
  assert.equal(rows(tree).length,0)
  assert.equal(picks.length,1)
  f.nodes(tree,node => node.type === 'Input')[0].props.onChange({ target: { value: '' } }); tree = f.renderCatalog(props)
  rows(tree)[0].props.onToggle()
  assert.equal(changes[0].optionId,'option-99')
})

test('selected catalog prices use the current quote and never the base catalog amount', () => {
  const f = form()
  const props = { title: 'Design selections',hint:'',items:[{optionId:'finish',label:'Finish',category:'Kitchen',priceCents:100}],picks:[{optionId:'finish'}],onToggle() {},quotedPrices:[{optionId:'finish',priceCents:2200}] }
  const row = tree => f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'Row')[0]
  assert.equal(row(f.renderCatalog(props)).props.meta,'Kitchen · Quoted 2200')
  props.quotedPrices = null
  assert.equal(row(f.renderCatalog(props)).props.meta,'Kitchen · Pricing…')
  props.quoteFailed = true
  assert.equal(row(f.renderCatalog(props)).props.meta,'Kitchen · Not priced')
  props.picks = []
  assert.equal(row(f.renderCatalog(props)).props.meta,'Kitchen · Catalog 100')
})

test('the form hides selected line quotes immediately when the configuration changes', async () => {
  const f = form()
  f.context.designSelections = [{ optionId: 'finish', label: 'Finish', category: 'Kitchen', priceCents: 100 }]
  f.context.swing = 'left'
  const section = tree => f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'CatalogSection' && node.props.title === 'Design selections')[0]
  f.render(); await f.flush()
  let tree = f.render()
  section(tree).props.onToggle({ optionId: 'finish' }); f.render(); await f.fire()
  f.quotes.at(-1).resolve({ success:true,data:{ quoteHash:"a".repeat(64), totalCents:2200,choicePrices:[{optionId:'finish',priceCents:2200}] } })
  await f.flush(); tree = f.render()
  assert.equal(section(tree).props.quotedPrices[0].priceCents,2200)
  section(tree).props.onToggle({ optionId: 'finish' })
  tree = f.render(false)
  assert.equal(section(tree).props.quotedPrices,null)
})

test('a changed-quote rejection refreshes prices and requires an explicit second submission', async () => {
  const f = form(); f.context.swing = 'left'
  f.render(); await f.flush(); f.render(); await f.fire()
  f.quotes.at(-1).resolve({ success:true,data:{quoteHash:'a'.repeat(64),totalCents:100} }); await f.flush()
  let tree = f.render(); f.setCreateResult({ success:false,code:'AGREEMENT_QUOTE_CHANGED',error:'Prices changed' })
  f.submit(tree).props.onClick(); await f.flush(); tree = f.render()
  assert.equal(f.creates[0].expectedQuoteHash,'a'.repeat(64))
  assert.equal(f.submit(tree).props.disabled,true)
  await f.fire()
  assert.equal(f.quotes.length,2)
  f.quotes.at(-1).resolve({ success:true,data:{quoteHash:'b'.repeat(64),totalCents:200} }); await f.flush(); tree = f.render()
  assert.equal(f.submit(tree).props.disabled,false)
  assert.equal(f.creates.length,1)
})

async function readyForm() {
  const f = form(); f.context.swing = 'left'
  f.render(); await f.flush(); f.render(); await f.fire()
  f.quotes.at(-1).resolve({ success:true,data:{quoteHash:'a'.repeat(64),totalCents:100} }); await f.flush()
  return f
}

test('agreement save and accepted delivery have distinct truthful outcomes', async () => {
  for (const [signing,title] of [[{documentId:null,envelopeId:null,reason:'Signing is not configured'},'Agreement saved'],[{documentId:'document',envelopeId:'envelope',reason:'Buyer invitations are queued for delivery'},'Agreement saved'],[{documentId:'document',envelopeId:'envelope',reason:null},'Agreement sent for signature']]) {
    const f = await readyForm(); f.setCreateResult({success:true,data:{signing}})
    f.submit(f.render()).props.onClick(); await f.flush()
    assert.equal(f.toasts[0].title,title)
    assert.ok(!f.toasts[0].description.includes('has it by email'))
    assert.deepEqual(f.closes,[false])
    assert.equal(f.refreshes.length,1)
  }
})

test('a late submission result cannot mutate or close a switched or reopened view', async () => {
  for (const change of ['reservation','close-reopen','unmount']) {
    const f = await readyForm(); let resolve
    f.setCreateResult(new Promise(done => { resolve = done }))
    const submit = f.submit(f.render())
    submit.props.onClick(); submit.props.onClick()
    assert.equal(f.creates.length,1,'synchronous duplicate submission is coalesced')
    assert.equal(f.nodes(f.render(),node => node.type === 'fieldset')[0].props.disabled,true)
    if (change === 'reservation') { f.props.reservationId = 'another'; f.render() }
    else if (change === 'unmount') f.unmount()
    else { f.props.open = false; f.render(); if (change === 'close-reopen') { f.props.open = true; f.render() } }
    resolve({success:true,data:{signing:{documentId:'document',envelopeId:'envelope',reason:null}}}); await f.flush()
    assert.equal(f.closes.length,0)
    assert.equal(f.toasts.length,0)
    assert.equal(f.refreshes.length,0)
  }
})

test('late rejection from another reservation cannot clear its quote or display an error', async () => {
  const f = await readyForm(); let resolve
  f.setCreateResult(new Promise(done => { resolve = done }))
  f.submit(f.render()).props.onClick()
  f.props.reservationId = 'another'; f.render()
  resolve({success:false,code:'AGREEMENT_QUOTE_CHANGED',error:'Old quote changed'}); await f.flush()
  assert.equal(f.toasts.length,0)
  assert.equal(f.closes.length,0)
})

test('switching reservations clears prior picks and terms before quoting the next buyer', async () => {
  const f = await readyForm()
  let tree = f.render()
  const section = f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'CatalogSection')[0]
  section.props.onToggle({optionId:'old-finish'})
  f.nodes(tree,node => node.type === 'Textarea')[0].props.onChange({target:{value:'Old buyer terms'}})
  f.props.reservationId = 'next-reservation'
  tree = f.render()
  assert.equal(f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'CatalogSection').length,0)
  assert.equal(f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'PriceSummary').length,0)
  await f.flush(); f.render(); await f.fire()
  assert.equal(f.quotes.at(-1).input.optionItems.length,0)
  assert.equal(f.quotes.at(-1).input.incentiveIds.length,0)
  tree = f.render()
  assert.equal(f.nodes(tree,node => node.type === 'Textarea')[0].props.value,'')
})

test('an obsolete submit handler cannot create after another reservation is committed', async () => {
  const f = await readyForm(), oldSubmit = f.submit(f.render())
  f.props.reservationId = 'another'; f.render()
  oldSubmit.props.onClick(); await f.flush()
  assert.equal(f.creates.length,0)
})

test('reopening the same reservation hides its previous context before effects run', async () => {
  const f = await readyForm()
  f.props.open = false; f.render(false)
  f.props.open = true
  const tree = f.render(false)
  assert.equal(f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'CatalogSection').length,0)
  assert.equal(f.nodes(tree,node => typeof node.type === 'function' && node.type.name === 'PriceSummary').length,0)
  assert.equal(f.submit(tree).props.disabled,true)
})
test('failed quote can be explicitly refreshed without changing selections or automatically creating an agreement', async () => {
  const f = form(); f.context.swing = 'left'
  f.render(); await f.flush(); f.render(); await f.fire()
  f.quotes[0].resolve({success:false,error:'Catalog changed; review a fresh quote',code:'AGREEMENT_QUOTE_CHANGED'}); await f.flush()
  let tree=f.render()
  const retry=f.nodes(tree,node=>node.type==='Button'&&node.props.children==='Refresh quote')[0]
  assert.equal(f.submit(tree).props.disabled,true)
  retry.props.onClick();retry.props.onClick();f.render();await f.fire()
  assert.equal(f.quotes.length,2);assert.equal(f.creates.length,0)
  assert.equal(f.quotes[1].input.swing,'left')
  f.quotes[1].resolve({success:true,data:{quoteHash:'b'.repeat(64),totalCents:200}});await f.flush();tree=f.render()
  assert.equal(f.submit(tree).props.disabled,false)
  retry.props.onClick();f.render();await f.fire()
  assert.equal(f.quotes.length,2,'obsolete error handler cannot refresh a newer quote')
  f.submit(f.render()).props.onClick();await f.flush()
  assert.equal(f.creates.length,1);assert.equal(f.creates[0].expectedQuoteHash,'b'.repeat(64))
})

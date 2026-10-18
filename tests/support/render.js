"use strict"

/**
 * A client component, driven like a user drives it: render, read what is on
 * screen, press a control, render again.
 *
 *   const { stubLeaves, mount, find, findAll, text, button } = require("./support/render")
 *   stubLeaves(["@/components/ui/button", "@/components/ui/checkbox"])   // <Button> → { type: "Button" }
 *   const { PackageMemberPicker } = freshRequire("components/design-studio/package-member-picker.tsx")
 *
 *   const view = mount(PackageMemberPicker, { categories, selectedIds: [], onToggle })
 *   button(view.render(), "Next members").props.onClick()
 *   assert.match(text(view.render()), /Showing 21–40/)
 *
 * React's hooks are replaced by a deterministic single-component runtime:
 * `useState`/`useRef` keep slots in call order, `useEffect` runs after each
 * render when its dependencies change (cleaning up the previous run first),
 * `useMemo`/`useCallback` recompute when their dependencies change, `useTransition` runs work immediately.
 * A state update never re-renders by itself — call `render()` again, which is
 * what a test wants anyway: one explicit frame per step.
 *
 * Every function component in the tree is rendered too and stays in the tree
 * as its own node, with what it rendered as its children (find it by `type`); library leaves you pass to `stubLeaves` stay as named tags whose
 * props (onClick, disabled, value…) the test reads and calls.
 *
 * Require this module BEFORE `freshRequire`-ing the component under test.
 */

const React = require("react")
const { stubModule } = require("./modules")

let active = null

function slot(initial) {
  const index = active.cursor++
  if (!(index in active.slots)) active.slots[index] = initial()
  return active.slots[index]
}

const hooks = {
  useState(initial) {
    const state = slot(() => ({ value: typeof initial === "function" ? initial() : initial }))
    const set = (next) => {
      state.value = typeof next === "function" ? next(state.value) : next
    }
    return [state.value, set]
  },
  useRef(initial) {
    return slot(() => ({ current: initial }))
  },
  useMemo(compute, deps) {
    const memo = slot(() => ({ deps: undefined, value: undefined }))
    if (!deps || !memo.deps || deps.some((dep, index) => !Object.is(dep, memo.deps[index]))) {
      memo.deps = deps
      memo.value = compute()
    }
    return memo.value
  },
  useCallback(callback, deps) {
    return hooks.useMemo(() => callback, deps)
  },
  useTransition: () => [false, (work) => work()],
  useId: () => "id",
  useEffect(effect, deps) {
    const owner = active
    const state = slot(() => ({ deps: undefined, cleanup: undefined }))
    const changed = !deps || !state.deps || deps.some((dep, index) => !Object.is(dep, state.deps[index]))
    if (!changed) return
    state.deps = deps
    owner.pending.push(() => {
      if (typeof state.cleanup === "function") state.cleanup()
      state.cleanup = effect()
    })
  },
}
hooks.useLayoutEffect = hooks.useEffect

stubModule("react", { ...React, ...hooks })

/** Replace each module with an object whose every export is a tag named after it. */
function stubLeaves(requests) {
  for (const request of requests) {
    stubModule(request, new Proxy({ __esModule: true }, { get: (target, key) => (key in target ? target[key] : String(key)) }))
  }
}

function expand(node) {
  if (Array.isArray(node)) return node.map(expand)
  if (!React.isValidElement(node)) return node
  if (typeof node.type === "function") {
    // The component stays in the tree, holding what it rendered as children.
    return { ...node, props: { ...node.props, children: expand(node.type(node.props)) } }
  }
  if (node.props && "children" in node.props) {
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  return node
}

/** Mount `Component`; `view.props` may be changed between renders. */
function mount(Component, props) {
  const view = {
    props,
    slots: [],
    cursor: 0,
    pending: [],
    render() {
      active = view
      view.cursor = 0
      const tree = expand(React.createElement(Component, view.props))
      active = null
      for (const effect of view.pending.splice(0)) effect()
      return tree
    },
  }
  return view
}

function findAll(tree, predicate, found = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) findAll(child, predicate, found)
    return found
  }
  if (!React.isValidElement(tree)) return found
  if (predicate(tree)) found.push(tree)
  return findAll(tree.props.children, predicate, found)
}

const find = (tree, predicate) => findAll(tree, predicate)[0]

/** Everything a user would read, joined with spaces. */
function text(tree) {
  if (tree === null || tree === undefined || typeof tree === "boolean") return ""
  if (typeof tree === "string" || typeof tree === "number") return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join("")
  return React.isValidElement(tree) ? text(tree.props.children) : ""
}

/** The `Button` whose label is exactly `label`. */
const button = (tree, label) => find(tree, (node) => node.type === "Button" && text(node.props.children) === label)

/** Let resolved promises and their continuations run. */
async function settle() {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

module.exports = { stubLeaves, mount, find, findAll, text, button, settle }

"use strict"

/**
 * Module seams for service and action tests.
 *
 * Load the real module under test with `freshRequire`, after replacing only the
 * dependencies that would reach the network or the request scope with
 * `stubModule`. Stubs live in the require cache, so the real module's own
 * `import` statements pick them up — no source reading, no loader override.
 */

require("../../scripts/register-ts-node-test")

const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "../..")

/** An `@/` alias, a package name, or a path relative to the repository root. */
function resolve(request) {
  const repoPath = path.resolve(root, request)
  return require.resolve(fs.existsSync(repoPath) ? repoPath : request)
}

/** Replace `request` with `exports` for every module loaded after this call. */
function stubModule(request, exports) {
  const filename = resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] }
  return exports
}

/** Require the real module, discarding any copy loaded before the stubs were set. */
function freshRequire(request) {
  delete require.cache[resolve(request)]
  return require(resolve(request))
}

module.exports = { stubModule, freshRequire }

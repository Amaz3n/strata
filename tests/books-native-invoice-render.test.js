require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
test("invoice accounting renders without server calls or Node financial dependencies in the client graph", () => {
  const target =
      require.resolve("../components/books/native-invoice-accounting"),
    old = Module._load,
    loaded = [];
  let Component;
  try {
    Module._load = function (name, ...args) {
      loaded.push(name);
      if (name === "@/app/(app)/books/actions")
        return new Proxy(
          {},
          {
            get: () => () => {
              throw Error("Server action executed during render");
            },
          },
        );
      return old.call(this, name, ...args);
    };
    delete require.cache[target];
    Component = require(target).NativeInvoiceAccounting;
  } finally {
    Module._load = old;
  }
  const html = renderToStaticMarkup(
    React.createElement(Component, {
      invoiceId: "88200000-0000-4000-8000-000000000100",
    }),
  );
  assert.match(html, /Entity invoice accounting/);
  assert.match(html, /Checking entity accounting/);
  assert.match(html, /Company ledger activation is still pending/);
  assert.ok(
    !loaded.some((n) =>
      [
        "node:crypto",
        "node:fs",
        "./native-invoice-economics",
        "./native-invoice-posting-receipt",
      ].includes(n),
    ),
  );
});

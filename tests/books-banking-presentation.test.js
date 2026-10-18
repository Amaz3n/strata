const test = require("node:test");
const assert = require("node:assert/strict");

const presentation = import("../lib/services/books/banking-presentation.ts");

test("Plaid merchant branding reads the verified raw logo field", async () => {
  const { plaidMerchantLogoUrl } = await presentation;
  assert.equal(
    plaidMerchantLogoUrl({
      logo_url: "https://plaid-merchant-logos.plaid.com/starbucks.png",
    }),
    "https://plaid-merchant-logos.plaid.com/starbucks.png",
  );
});

test("Plaid merchant branding rejects unsafe and unrelated URLs", async () => {
  const { plaidMerchantLogoUrl } = await presentation;
  assert.equal(
    plaidMerchantLogoUrl({ logo_url: "http://example.com/logo.png" }),
    null,
  );
  assert.equal(
    plaidMerchantLogoUrl({
      logo_url: "https://user:secret@example.com/logo.png",
    }),
    null,
  );
  assert.equal(
    plaidMerchantLogoUrl({ website: "https://example.com" }),
    null,
  );
  assert.equal(plaidMerchantLogoUrl(null), null);
});

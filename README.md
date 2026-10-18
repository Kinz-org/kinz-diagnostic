# kinz-diagnostic

Small Vercel function that adds a personalised explanation, written by Claude Fable 5.1, to the
routine diagnostic on kinzoils.com (/pages/diagnostic).

- `POST /api/diagnostic` with `{ lang, profile: [answers], steps: [{ handle, name, moment, how? }] }` (`how`: the product's usage text, so the advice never contradicts it)
- Returns `{ intro, steps: [{ handle, why }], tip }`
- The quiz picks the products; the model only explains them and can't add a product.
- The owner's claims rule is in the prompt and also checked on the output: a field naming retinol, hyaluronic acid, a certification, Kasserine, "pressée à froid" or a percentage is dropped. Text is cut at a sentence end.
- Only kinzoils.com, the myshopify domain and Shopify theme previews (`https://<id>.shopifypreview.com`) may call it; 6 requests per IP per 10 minutes.
- The answer uses structured output (JSON schema), low effort and `fallbacks: "default"` (a safety decline is re-run on Anthropic's recommended fallback model).

## Environment variables (Vercel)

- `ANTHROPIC_API_KEY` (required, shared team variable, Sensitive) - key from the KINZ Claude Console, workspace "Boutique Kinz"
- `KINZ_MODEL` (optional) - defaults to `claude-fable-5-1`
- `ALLOWED_ORIGINS` (optional) - comma-separated list, defaults to the store domains
- `ALLOW_PREVIEW_ORIGINS` (optional) - `0` refuses `*.shopifypreview.com` origins (every Shopify store's previews share that domain); on by default

## Tests

`npm test` (Node 20+). The Anthropic API is mocked; no key needed.

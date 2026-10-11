# Vayal

**Vayal (வயல்) · farm to kitchen** — a clickable web + mobile prototype of an organic farm-to-kitchen grocery store for Chennai.

## Live site

| Where | Link | AI features |
|---|---|---|
| GitHub Pages | https://prabugandhi1977.github.io/Vayal/ | Offline product guide |
| Render | https://vayal.onrender.com *(once the Render Blueprint is deployed; Render may assign a different name)* | Full AI, via this repo's backend (`server.js`) |
| claude.ai | https://claude.ai/artifact/8XiBMeyJ4v1YGdNKysW4t5 | Full AI (Vayal Mitra, photo list, AI meal plan) |

GitHub Pages and Render redeploy automatically when `main` changes.

## AI backend (Render)

`server.js` is a small Node server that serves `index.html` and forwards the AI features to Claude (`claude-opus-5-5`) with an API key kept on the server. The browser runs the cart tools itself; the server only relays messages.

- `GET /api/health`: says whether AI is switched on
- `POST /api/chat`: one streamed Vayal Mitra turn
- `POST /api/json`: one JSON answer, optionally about a photo (shopping list, AI meal plan)

Deploy: on Render choose **New → Blueprint**, pick this repo, and paste your Anthropic API key when asked for `ANTHROPIC_API_KEY`. Without a key the site still works and Mitra answers from the built-in product guide.

Settings (Render environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Required for AI |
| `AI_REQUESTS_PER_IP_PER_HOUR` | 60 | Per-visitor limit |
| `AI_REQUESTS_PER_DAY` | 2000 | Site-wide daily cap |
| `VAYAL_CLAUDE_MODEL` | `claude-opus-5-5` | Model |
| `VAYAL_CLAUDE_EFFORT` | `low` | Effort level (`low`, `medium`, `high`) |

Limits are kept in memory and reset when the service restarts.

## Run locally

With AI: `npm install`, then `ANTHROPIC_API_KEY=... npm start` and open http://localhost:3000.

Without AI: open `index.html` in a browser. On a wide screen it works as the storefront; the **App preview** button shows the same app in a phone frame.

## What's in the prototype

- **Shop** — 35 products across 8 categories, Tamil/Tanglish search ("thakkali", "keerai"), health-goal filters, pack sizes.
- **Product pages** — health benefits, nutrition, usage, storage, recipes and farm traceability.
- **Cart & checkout** — delivery slots, coupons, reward points, returnable crate, farmer-fund option, UPI/card/wallet/COD, sample GST invoice (no real payment).
- **Orders** — tracking with handover OTP, freshness rating, quality-issue refunds, reorder, "running low? buy again".
- **Subscriptions** — daily milk/greens, skip days, vacation mode, wallet.
- **Health profile** — diet, goals and allergies drive product badges and warnings.
- **Meal planner** — 7-day breakfast and lunch/dinner plan; add a week's ingredients scaled to household size.
- **Shop from a photo** — AI reads a handwritten list and fills the cart (sample Tanglish list included).
- **Vayal Mitra** — AI chat assistant for products, health, recipes and storage; can add items to the cart. Falls back to a built-in product guide when AI isn't available.

## Limitations

- Prototype only: no payments, delivery, accounts or real farms (farm names are placeholders). The only backend is the AI relay.
- Cart, profile and orders are stored in the browser's `localStorage`.
- Voice search is not wired up in the web preview.
- Nutrition figures are rough estimates and health text needs expert review before launch.

On claude.ai the AI features use the artifact runtime (`window.claude`); on Render they use `server.js`. Anywhere else (GitHub Pages, opening the file directly) the app falls back to offline answers.

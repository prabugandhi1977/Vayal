# Vayal

**Vayal (வயல்) · farm to kitchen** — a clickable web + mobile prototype of an organic farm-to-kitchen grocery store for Chennai.

Open `index.html` in a browser. On a wide screen it works as the storefront; the **App preview** button shows the same app in a phone frame.

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

- Prototype only: no backend, payments, delivery or real farms (farm names are placeholders).
- Cart, profile and orders are stored in the browser's `localStorage`.
- Voice search is not wired up in the web preview.
- Nutrition figures are rough estimates and health text needs expert review before launch.

The AI features use the claude.ai artifact runtime (`window.claude`); outside it, the app falls back to offline answers.

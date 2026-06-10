# NIT-IN — Platform Audit Report

**Prepared:** June 10, 2026  
**Repo:** `NIT-IN` (Node.js Express + WebSocket, ~65 routes)  
**Production URL:** `https://nit-in.conversationmine.ai`  
**Railway Service:** `5cbcbe36` | **Project:** `f83a787f`  
**Pentagon Frequency:** Birth Rights Protocol — hardware identity layer, Arduino Uno Q mesh

---

## 1. Platform Identity

NIT-IN is the **Pentagon's physical hardware identity node** — the only platform in the chain that interfaces directly with real physical hardware (Arduino Uno Q microcontrollers via USB serial at 9600 baud). It implements:

- **Birth Rights Protocol** — each Arduino generates a unique `nit_fingerprint` from SRAM entropy + hardware signature at first boot, creating an unforgeable identity tied to physical silicon
- **Resonance network** — nodes build trust edges via behavioral similarity scoring (≥0.60 threshold). A node must have established resonance to post signals to the feed
- **ZK compliance batch prover** — `circuits/compliance_batch.circom` circom circuit for zero-knowledge batch proofs of node compliance without revealing individual node data
- **Cross-platform token** — HMAC-SHA256 tokens (`nit_id:fingerprint:expiry`) for authenticated federation across the Pentagon mesh (post-audit fix: fallback removed, uses `HUB_SECRET`)
- **Simulator** — 20 virtual NIT nodes that exercise the full pipeline without physical hardware (`npm run sim`)
- **Manifest enforcement** — every signal and DM is checked against TWIN's CAI judiciary (`POST /api/cai/enforce`) before routing, fail-open on network error

---

## 2. ✅ FULLY WIRED (Route + Logic + Integration)

| Feature | Route / File | Notes |
|---|---|---|
| Node registration (hardware) | `POST /api/nit/register` + serial-bridge.js | USB auto-discovery at 9600 baud, lazy SerialPort load |
| Node registration (simulator) | `npm run sim` → hub/simulator.js | 20 virtual nodes with SRAM entropy generation |
| Genesis handshake | `POST /api/nit/genesis` | Hardware SRAM fingerprint capture, node birth record |
| Capability pulse | `POST /api/nit/heartbeat` | Node uptime, sensor list, firmware version |
| Network graph | `GET /api/network` | All nodes + edges, live from SQLite |
| Feed signal post | `POST /api/signal` | `requireAuth` + `requireResonance` + manifest enforcement |
| Feed load | `GET /api/feed` | Last N signals, SQLite-backed |
| Direct message | `POST/GET /api/dm` | Signed, `requireAuth`, rate-limited 20 DM/min |
| Resonance evaluation | hub/resonance.js | SRAM/uptime/sensor similarity scoring, edge creation at ≥0.60 |
| Cross-platform token issue | `POST /api/xp-token` | HMAC-SHA256(HUB_SECRET), 1-hour expiry |
| Cross-platform token verify | `POST /api/xp-token/verify` | Constant-time HMAC comparison |
| Token validate (external) | `POST /api/validate-token` | Used by TWIN for inter-platform auth |
| Fleet heartbeat | `POST /api/fleet/heartbeat` | Hardware health: CPU, temp, RAM, DMS status |
| Fleet nodes | `GET /api/fleet/nodes` | Full fleet snapshot, optional SQLite persistence |
| ZK commit | `POST /api/zk/commit` | Commitment stored in `zk_commitments` table |
| ZK verify | `POST /api/zk/verify` | Verifies against stored commitment |
| Waitlist signup | `POST /api/waitlist` | Email + plan, deduplicated, SQLite |
| Waitlist admin view | `GET /api/waitlist` | `requireAuth` protected |
| Community wellness | Per signal/DM | Harassment vs technical debate classifier (keyword-based) |
| Manifest enforcement | Per signal/DM | `POST /api/cai/enforce` on TWIN, 3s timeout, fail-open |
| Billing checkout create | `POST /api/billing/create-checkout` | Lazy Stripe init, 4 plan tiers |
| WebSocket live events | `wss://nit-in.conversationmine.ai` | Node updates, feed events, fleet health broadcast |
| Rate limiting | Per-node, per-action | signal=10/min, DM=20/min, in-memory bucket cleanup |
| Health check | `GET /health` | Railway ping |
| Static dashboard | `public/index.html` | Network graph, feed, DM panel |
| Pricing page | `public/pricing.html` | 4-tier pricing with Stripe checkout buttons |

---

## 3. ⚠️ ROUTE EXISTS — INCOMPLETE OR DEGRADED

| Feature | Route | Gap |
|---|---|---|
| **Billing — no Stripe webhook endpoint** | `POST /api/billing/create-checkout` | Checkout session is created and user is redirected to Stripe. On payment success, Stripe fires a webhook — but **no webhook endpoint exists** in `hub/server.js`. Successful payments never fulfill plan upgrades. Users pay and stay on the free plan indefinitely. |
| **Stripe price IDs not set on Railway** | `POST /api/billing/create-checkout` | `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_HUB`, `STRIPE_PRICE_SIGNAL`, `STRIPE_PRICE_ENTERPRISE` all `undefined` on Railway. Every checkout attempt returns `400 invalid_plan`. Revenue fully blocked. |
| **ZK prover — circuit not compiled** | `circuits/compliance_batch.circom` | Circom source file exists. No `.r1cs`, no `.wasm`, no `.zkey` artifacts in `circuits/build/`. The `POST /api/zk/commit` and `POST /api/zk/verify` routes store/check raw data against a hash but do not run actual zero-knowledge proofs. ZK is hash commitment only. |
| **SQLite on Railway ephemeral filesystem** | `hub/db.js` — `nit.db` | Same issue as KIRO. `path.join(DATA_DIR, 'nit.db')` on Railway = ephemeral. All nodes, edges, feed, DMs, waitlist, ZK commitments wiped on every deploy. Needs persistent volume. |
| **`NIT_IN_HUB_PERSISTENCE`** | Fleet health only | `FLEET_PERSIST=true` env var persists fleet health to SQLite. Does not apply to nodes, edges, feed, or DMs. Critical data still ephemeral even with flag set. |
| **Resonance gate — simulator inflates scores** | `requireResonance` | Real hardware resonance requires behavioral similarity over time. In `--simulate` mode, virtual nodes immediately generate similar SRAM/sensor profiles → edges form within seconds. If Railway runs with `SIMULATE=true` (no physical hardware attached), the resonance gate is trivially bypassed — any simulated node gets through. |
| **Community wellness — keyword-only classifier** | Per signal | Harassment detection uses a hardcoded keyword list. No ML model, no embedding similarity, no context window. A targeted harassment message written to avoid the exact keywords passes through undetected. Adequate for v1 but insufficient for scale. |

---

## 4. ❌ ADVERTISED — NOT IMPLEMENTED AT ALL

| Promised Feature | Where Advertised | Reality |
|---|---|---|
| **Full ZK batch proof** | `circuits/compliance_batch.circom` title | `.circom` source is written. No compiled artifacts. No `snarkjs` in `package.json`. ZK proofs are not generated or verified. |
| **Birth Rights NFT / on-chain anchoring** | `nit-registry.js` comment: "Birth_Rights Protocol v1.0 — No token is revocable by a third party" | No blockchain calls, no NFT minting, no on-chain anchoring. Registry is pure SQLite. The philosophical claim is not backed by code. |
| **Subscription plan enforcement** | 4 tiers: Starter / Hub / Signal / Enterprise | No `user` table, no `plan` column in SQLite schema. After a successful checkout (if it ever worked), there is no code that reads a user's plan to gate features. All tier features are currently equally inaccessible. |
| **`@Reviewer (7777Hz)` integration** | `TWIN_ENFORCE_URL` references reviewer frequency | No reviewer node at 7777Hz exists. The enforcement call goes to TWIN's CAI judiciary which returns verdicts — the frequency-branded reviewer persona is aspirational. |

---

## 5. 🔴 SYSTEM-BREAKING RISKS

| Risk | Severity | Detail |
|---|---|---|
| **No Stripe webhook → payments never fulfill** | CRITICAL | The single most important missing piece. Users who complete checkout get no plan upgrade. Add `POST /api/billing/webhook` with `stripe.webhooks.constructEvent()` immediately. |
| **All Stripe price IDs undefined** | CRITICAL | Revenue fully blocked. Set `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_HUB`, `STRIPE_PRICE_SIGNAL`, `STRIPE_PRICE_ENTERPRISE` on Railway. |
| **SQLite data loss on deploy** | HIGH | Every Railway redeploy wipes all registered nodes, edges, feed history, DMs, waitlist, ZK commitments. Add Railway persistent volume at `/data`. |
| **No user/plan DB table** | HIGH | Even if billing is fixed, there is nowhere to store which plan a user is on. The plan enforcement system cannot be completed without a `users` table. |
| **`SIMULATE=true` bypasses resonance gate** | MEDIUM | If Railway env has `SIMULATE=true` (set during testing and never cleared), virtual nodes auto-form resonance edges and bypass the gate that was designed to require real hardware behavior. |

---

## 6. Pricing Model Analysis

### Current Structure
| Plan | Price | Features | Status |
|---|---|---|---|
| Starter | **$5/mo** | 1 NIT node, basic feed | ❌ Price ID not set, no webhook |
| Hub | **$19/mo** | 5 NIT nodes, DMs, fleet | ❌ Price ID not set, no webhook |
| Signal | **$49/mo** | 20 nodes, ZK proofs, federation | ❌ Price ID not set, no webhook |
| Enterprise | **$199/mo** | Unlimited, dedicated support | ❌ Price ID not set, no webhook |

**100% of paid revenue is blocked** — both by missing price IDs and missing webhook.

### Revenue opportunity: ZK Proof-as-a-Service

Once the circom circuit is compiled and snarkjs integrated, ZK batch proofs become a distinct API product:

- `POST /api/zk/batch-prove` — prove compliance for N nodes without revealing individual data
- Pricing: **$0.05 per node** in the batch (10-node batch = $0.50, 100-node = $5.00)
- Target: IoT compliance auditors, supply chain verification, hardware certification

At 1,000 nodes/month: **$50/month** low-end. At 50,000 nodes (industrial scale): **$2,500/month** from a single API endpoint.

---

## 7. Priority Fix Order

| Priority | Task | Effort | Impact |
|---|---|---|---|
| 1 | **Add `POST /api/billing/webhook`** with Stripe signature verification | 2 hours | Unlocks all payment fulfillment |
| 2 | **Set Stripe price IDs on Railway** (4 env vars) | 10 min | Unblocks all checkout |
| 3 | **Add `users` table to SQLite schema** + plan column | 1 hour | Plan enforcement becomes possible |
| 4 | **Add Railway persistent volume** at `/data` | 30 min | Stop data loss on deploy |
| 5 | **Compile `compliance_batch.circom`** + add `snarkjs` dep | 1 day | ZK proofs become real |
| 6 | **Clear `SIMULATE=true`** from Railway if set | 5 min | Resonance gate integrity restored |
| 7 | **ZK Proof-as-a-Service metered billing** | 3 days | New revenue stream, unique market position |

---

## 8. Stripe Webhook — Minimum Viable Fix

```javascript
// hub/server.js — add after /api/billing/create-checkout

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'not_configured' });
    let event;
    try {
      const Stripe = require('stripe');
      event = Stripe(STRIPE_SECRET_KEY).webhooks.constructEvent(
        req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }
    if (event.type === 'checkout.session.completed') {
      const { customer_email, metadata } = event.data.object;
      const plan = metadata?.plan || 'starter';
      // Upsert user plan in SQLite
      db.prepare(`INSERT OR REPLACE INTO users (email, plan, updated_at)
                  VALUES (?, ?, unixepoch())`).run(customer_email, plan);
    }
    res.json({ received: true });
  }
);
```

---

*Next platform: #7 IOT-MAKER*

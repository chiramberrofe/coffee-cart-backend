const express    = require("express");
const cors       = require("cors");
const https      = require("https");
const { randomUUID } = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── Square API helper (no SDK needed) ─────────────────────────────
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV   = process.env.SQUARE_ENV || "sandbox";
const BASE_URL     = SQUARE_ENV === "production"
  ? "connect.squareup.com"
  : "connect.squareupsandbox.com";

function squareRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body, (_, v) =>
      typeof v === "bigint" ? v.toString() : v
    ) : null;

    const options = {
      hostname: BASE_URL,
      path,
      method,
      headers: {
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Content-Type":  "application/json",
        "Square-Version": "2024-01-18",
      },
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", env: SQUARE_ENV, token_set: !!SQUARE_TOKEN });
});

// ── List devices ──────────────────────────────────────────────────
app.get("/devices", async (req, res) => {
  try {
    const r = await squareRequest("GET", "/v2/devices");
    if (r.status !== 200) return res.status(r.status).json(r.body);
    const devices = (r.body.devices || []).map(d => ({
      id:     d.id,
      name:   d.attributes?.name || "Unnamed",
      model:  d.attributes?.model,
      status: d.status?.category,
    }));
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create Terminal checkout ──────────────────────────────────────
app.post("/checkout", async (req, res) => {
  const { amountCents, orderId, note, deviceId } = req.body;
  if (!amountCents || !deviceId)
    return res.status(400).json({ error: "amountCents and deviceId are required" });

  try {
    const r = await squareRequest("POST", "/v2/terminals/checkouts", {
      idempotency_key: randomUUID(),
      checkout: {
        amount_money:   { amount: amountCents, currency: "AUD" },
        device_options: {
          device_id:          deviceId,
          skip_receipt_screen: false,
          collect_signature:   false,
          tip_settings:       { allow_tipping: false },
        },
        reference_id: orderId || randomUUID(),
        note:         note || "Coffee Cart",
        payment_type: "CARD_PRESENT",
      },
    });
    if (r.status !== 200) return res.status(r.status).json(r.body);
    const checkout = r.body.checkout;
    res.json({ checkoutId: checkout.id, status: checkout.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Poll checkout status ──────────────────────────────────────────
app.get("/checkout/:id", async (req, res) => {
  try {
    const r = await squareRequest("GET", `/v2/terminals/checkouts/${req.params.id}`);
    if (r.status !== 200) return res.status(r.status).json(r.body);
    const c = r.body.checkout;
    res.json({ checkoutId: c.id, status: c.status, paymentId: c.payment_ids?.[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cancel checkout ───────────────────────────────────────────────
app.post("/checkout/:id/cancel", async (req, res) => {
  try {
    const r = await squareRequest("POST", `/v2/terminals/checkouts/${req.params.id}/cancel`);
    res.json({ cancelled: r.status === 200 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get payment details ───────────────────────────────────────────
app.get("/payment/:id", async (req, res) => {
  try {
    const r = await squareRequest("GET", `/v2/payments/${req.params.id}`);
    if (r.status !== 200) return res.status(r.status).json(r.body);
    const p = r.body.payment;
    res.json({
      id:          p.id,
      status:      p.status,
      amountCents: p.amount_money?.amount,
      cardBrand:   p.card_details?.card?.card_brand,
      last4:       p.card_details?.card?.last_4,
      entryMethod: p.card_details?.entry_method,
      receiptUrl:  p.receipt_url,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config (exposes public app settings) ─────────────────────────
app.get("/config", (req, res) => {
  res.json({
    squareAppId: process.env.SQUARE_APP_ID || "",
    env: process.env.SQUARE_ENV || "sandbox",
  });
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Coffee Cart backend on port ${PORT} [${SQUARE_ENV}]`));

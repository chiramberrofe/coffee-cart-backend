// ─────────────────────────────────────────────────────────────────
// Coffee Cart POS — Square Backend Server
// Deploy this on Railway.app (free tier)
// ─────────────────────────────────────────────────────────────────

const express  = require("express");
const cors     = require("cors");
const { ApiError, Client, Environment } = require("square");
const { randomUUID } = require("crypto");
const app = express();
app.use(cors());
app.use(express.json());

// ── Square client ─────────────────────────────────────────────────
// Set these as environment variables in Railway — never hardcode!
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,  // your sandbox token
  environment: process.env.SQUARE_ENV === "production"
    ? Environment.Production
    : Environment.Sandbox,
});

const { terminalApi, paymentsApi, ordersApi } = client;

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", env: process.env.SQUARE_ENV || "sandbox" }));

// ── Create Terminal checkout ──────────────────────────────────────
// Called when staff hits "Charge" in the POS app.
// Square sends the payment request to the physical reader.
app.post("/checkout", async (req, res) => {
  const { amountCents, orderId, note, deviceId } = req.body;

  if (!amountCents || !deviceId) {
    return res.status(400).json({ error: "amountCents and deviceId are required" });
  }

  try {
    const response = await terminalApi.createTerminalCheckout({
      idempotencyKey: randomUUID(),
      checkout: {
        amountMoney: {
          amount: BigInt(amountCents),
          currency: "AUD",
        },
        deviceOptions: {
          deviceId,           // your Square Terminal / Reader device ID
          skipReceiptScreen: false,
          collectSignature:  false,
          tipSettings: {
            allowTipping: false,
          },
        },
        referenceId: orderId || randomUUID(),
        note: note || "Coffee Cart",
        paymentType: "CARD_PRESENT",
      },
    });

    const checkout = response.result.checkout;
    res.json({
      checkoutId: checkout.id,
      status:     checkout.status,
      deviceId:   checkout.deviceOptions?.deviceId,
    });
  } catch (err) {
    console.error("Square checkout error:", err);
    const msg = err instanceof ApiError
      ? err.errors?.map(e => e.detail).join(", ")
      : err.message;
    res.status(500).json({ error: msg });
  }
});

// ── Poll checkout status ──────────────────────────────────────────
// POS polls this every 2s to know when payment is complete.
app.get("/checkout/:checkoutId", async (req, res) => {
  try {
    const response = await terminalApi.getTerminalCheckout(req.params.checkoutId);
    const checkout  = response.result.checkout;
    res.json({
      checkoutId: checkout.id,
      status:     checkout.status,      // PENDING | IN_PROGRESS | CANCEL_REQUESTED | CANCELLED | COMPLETED
      paymentId:  checkout.paymentIds?.[0] || null,
    });
  } catch (err) {
    console.error("Poll error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Cancel checkout ───────────────────────────────────────────────
app.post("/checkout/:checkoutId/cancel", async (req, res) => {
  try {
    await terminalApi.cancelTerminalCheckout(req.params.checkoutId);
    res.json({ cancelled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List devices (so you can get your deviceId) ───────────────────
app.get("/devices", async (req, res) => {
  try {
    const response = await client.devicesApi.listDevices();
    const devices  = (response.result.devices || []).map(d => ({
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

// ── Get payment details (for receipt) ────────────────────────────
app.get("/payment/:paymentId", async (req, res) => {
  try {
    const response = await paymentsApi.getPayment(req.params.paymentId);
    const p        = response.result.payment;
    res.json({
      id:          p.id,
      status:      p.status,
      amountCents: Number(p.amountMoney?.amount),
      cardBrand:   p.cardDetails?.card?.cardBrand,
      last4:       p.cardDetails?.card?.last4,
      entryMethod: p.cardDetails?.entryMethod,   // TAP, CHIP, SWIPE
      receiptUrl:  p.receiptUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Coffee Cart backend running on port ${PORT}`));

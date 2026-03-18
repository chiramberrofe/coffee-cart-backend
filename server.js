const express  = require("express");
const cors     = require("cors");
const { Client } = require("square");
const { randomUUID } = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── Square client ─────────────────────────────────────────────────
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENV === "production" ? "production" : "sandbox",
});

const { terminalApi, paymentsApi, devicesApi } = client;

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", env: process.env.SQUARE_ENV || "sandbox" });
});

// ── List devices ──────────────────────────────────────────────────
app.get("/devices", async (req, res) => {
  try {
    const response = await devicesApi.listDevices();
    const devices  = (response.result.devices || []).map(d => ({
      id:     d.id,
      name:   d.attributes?.name || "Unnamed",
      model:  d.attributes?.model,
      status: d.status?.category,
    }));
    res.json({ devices });
  } catch (err) {
    console.error("Devices error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Create Terminal checkout ──────────────────────────────────────
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
          deviceId,
          skipReceiptScreen: false,
          collectSignature:  false,
          tipSettings: { allowTipping: false },
        },
        referenceId: orderId || randomUUID(),
        note:        note || "Coffee Cart",
        paymentType: "CARD_PRESENT",
      },
    });

    const checkout = response.result.checkout;
    res.json({
      checkoutId: checkout.id,
      status:     checkout.status,
    });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Poll checkout status ──────────────────────────────────────────
app.get("/checkout/:checkoutId", async (req, res) => {
  try {
    const response = await terminalApi.getTerminalCheckout(req.params.checkoutId);
    const checkout  = response.result.checkout;
    res.json({
      checkoutId: checkout.id,
      status:     checkout.status,
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

// ── Get payment details ───────────────────────────────────────────
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
      entryMethod: p.cardDetails?.entryMethod,
      receiptUrl:  p.receiptUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Coffee Cart backend running on port ${PORT}`));

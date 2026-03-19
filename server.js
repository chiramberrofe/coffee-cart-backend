const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const https   = require("https");

const app = express();
app.use(cors());

// Raw body needed for webhook signature verification
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const SQUARE_TOKEN      = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_SIG_KEY    = process.env.SQUARE_WEBHOOK_SIG_KEY;
const SQUARE_ENV        = process.env.SQUARE_ENV || "production";
const FIREBASE_URL      = process.env.FIREBASE_URL; // your Firebase DB REST URL

// ── Square API helper ─────────────────────────────────────────────
function squareRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "connect.squareup.com",
      path, method,
      headers: {
        "Authorization":  "Bearer " + SQUARE_TOKEN,
        "Content-Type":   "application/json",
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

// ── Firebase REST helper ──────────────────────────────────────────
function firebasePost(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const url     = new URL(FIREBASE_URL + path + ".json");
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = https.request(options, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function firebasePatch(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const url     = new URL(FIREBASE_URL + path + ".json");
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "PATCH",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = https.request(options, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", env: SQUARE_ENV });
});

// ── Square Webhook ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Verify signature
  if (SQUARE_SIG_KEY) {
    const sig  = req.headers["x-square-hmacsha256-signature"];
    const body = req.body.toString("utf8");
    const url  = process.env.RAILWAY_PUBLIC_DOMAIN
      ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN + "/webhook"
      : "https://coffee-cart-backend-production.up.railway.app/webhook";
    const hmac = crypto.createHmac("sha256", SQUARE_SIG_KEY)
      .update(url + body).digest("base64");
    if (hmac !== sig) {
      console.log("Invalid webhook signature");
      return res.status(403).json({ error: "Invalid signature" });
    }
  }

  let event;
  try { event = JSON.parse(req.body.toString("utf8")); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  res.status(200).json({ received: true });

  // Only process completed payments
  if (event.type !== "payment.completed") return;

  const payment = event.data?.object?.payment;
  if (!payment) return;

  try {
    // Get order details from Square
    const amountCents = payment.amount_money?.amount || 0;
    const amountAUD   = (amountCents / 100).toFixed(2);
    const paymentId   = payment.id;
    const orderId     = payment.order_id;
    const createdAt   = payment.created_at;
    const cardBrand   = payment.card_details?.card?.card_brand || "";
    const last4       = payment.card_details?.card?.last_4 || "";
    const entryMethod = payment.card_details?.entry_method || "";

    // Try to get note/customer from order
    let note = "", customerName = "Guest", items = [];
    if (orderId) {
      try {
        const orderRes = await squareRequest("GET", "/v2/orders/" + orderId);
        if (orderRes.status === 200) {
          const order = orderRes.body.order;
          note         = order.reference_id || "";
          customerName = order.fulfillments?.[0]?.pickup_details?.recipient?.display_name || "Guest";
          items        = (order.line_items || []).map(i => ({
            name: i.name || "Item",
            qty:  parseInt(i.quantity) || 1,
            price: ((parseInt(i.base_price_money?.amount) || 0) / 100).toFixed(2),
          }));
        }
      } catch(e) { console.log("Could not fetch order:", e.message); }
    }

    // Build ticket for bump screen
    const ticket = {
      squarePaymentId: paymentId,
      total:           parseFloat(amountAUD),
      customer:        customerName,
      note,
      items:           items.length ? items : [{ name: "Payment", qty: 1, price: amountAUD }],
      payMethod:       entryMethod === "CONTACTLESS" ? "tap" : "card",
      cardBrand,
      last4,
      sentAt:          Date.now(),
      time:            new Date(createdAt).toLocaleTimeString("en-AU", { hour:"2-digit", minute:"2-digit" }),
      date:            new Date(createdAt).toLocaleDateString("en-AU"),
      status:          "pending",
    };

    // Save to Firebase queue (bump screen picks this up)
    if (FIREBASE_URL) {
      await firebasePost("/queue", ticket);
      console.log("Ticket saved to Firebase:", paymentId);
    } else {
      console.log("No FIREBASE_URL set — ticket not saved");
    }

  } catch(err) {
    console.error("Webhook processing error:", err);
  }
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Backend running on port " + PORT));

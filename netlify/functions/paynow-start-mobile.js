const { Paynow } = require("paynow");

const DEFAULT_INTEGRATION_ID = "24223";
const DEFAULT_INTEGRATION_KEY = "2336dda5-d3d2-4a1a-81a7-f6da364aedec";
const DEFAULT_EMAIL = "royaltyzw.tech@gmail.com";
const TEST_MODE_INTEGRATION_IDS = new Set([DEFAULT_INTEGRATION_ID]);

function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sendJson(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(payload, null, 2),
  };
}

function toNumber(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid item amount: ${value}`);
  }
  return amount;
}

function normalizeItems(inputItems) {
  if (!Array.isArray(inputItems) || inputItems.length === 0) {
    throw new Error("At least one payment item is required");
  }
  return inputItems.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Item ${index + 1} must be an object`);
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) {
      throw new Error(`Item ${index + 1} is missing a name`);
    }
    return {
      name,
      amount: toNumber(item.amount),
    };
  });
}

function getDefaultItems() {
  const envItems = getEnv("PAYMENT_ITEMS_JSON");
  if (!envItems) {
    return [
      { name: "Bananas", amount: 2.5 },
      { name: "Apples", amount: 3.4 },
    ];
  }
  const parsedItems = safeJsonParse(envItems);
  return normalizeItems(parsedItems);
}

function buildRuntimeConfig() {
  const baseUrl = normalizeBaseUrl(getEnv("URL", "https://your-netlify-site.netlify.app"));
  return {
    baseUrl,
    integrationId: getEnv("PAYNOW_INTEGRATION_ID", DEFAULT_INTEGRATION_ID),
    integrationKey: getEnv("PAYNOW_INTEGRATION_KEY", DEFAULT_INTEGRATION_KEY),
    defaultReference: getEnv("PAYMENT_REFERENCE", "Invoice 35"),
    defaultAuthEmail: getEnv("PAYMENT_AUTH_EMAIL", DEFAULT_EMAIL),
    defaultPhone: getEnv("PAYMENT_PHONE", ""),
    defaultMethod: getEnv("PAYMENT_METHOD", "web").toLowerCase(),
    defaultItems: getDefaultItems(),
    returnUrl: getEnv("PAYNOW_RETURN_URL", "https://royaltyfuneral.com/paymentSuccess"),
  };
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

const config = buildRuntimeConfig();

const paynow = new Paynow(config.integrationId, config.integrationKey);

function buildPayment(payload = {}) {
  const reference = typeof payload.reference === "string" && payload.reference.trim()
    ? payload.reference.trim()
    : config.defaultReference;

  const requestedAuthEmail = typeof payload.authEmail === "string" && payload.authEmail.trim()
    ? payload.authEmail.trim()
    : config.defaultAuthEmail;
  const authEmail = TEST_MODE_INTEGRATION_IDS.has(config.integrationId)
    ? config.defaultAuthEmail
    : requestedAuthEmail;

  const items = normalizeItems(payload.items || config.defaultItems);
  const payment = paynow.createPayment(reference, authEmail || undefined);

  for (const item of items) {
    payment.add(item.name, item.amount);
  }

  return {
    payment,
    reference,
    authEmail,
    items,
  };
}

function buildRequestPayload(body) {
  return body && typeof body === "object" ? body : {};
}

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return sendJson(405, { success: false, error: "Method not allowed" });
  }

  try {
    const payload = buildRequestPayload(safeJsonParse(event.body, {}));
    const phone = typeof payload.phone === "string" && payload.phone.trim()
      ? payload.phone.trim()
      : config.defaultPhone;
    const method = typeof payload.method === "string" && payload.method.trim()
      ? payload.method.trim().toLowerCase()
      : config.defaultMethod;

    if (!phone) {
      throw new Error("A phone number is required for mobile payments");
    }

    if (!["ecocash", "onemoney", "innbucks"].includes(method)) {
      throw new Error("Mobile payment method must be ecocash, onemoney, or innbucks");
    }

    const { payment, reference, authEmail, items } = buildPayment(payload);

    if (!authEmail) {
      throw new Error("A valid authEmail is required for mobile payments");
    }

    const response = await paynow.sendMobile(payment, phone, method);

    if (!response) {
      throw new Error("Paynow did not return a response. Check your network or proxy settings.");
    }

    if (!response.success) {
      throw new Error(response.error || "Paynow rejected the mobile payment request");
    }

    return sendJson(200, {
      success: true,
      reference,
      authEmail,
      phone,
      method,
      items,
      instructions: response.instructions || null,
      pollUrl: response.pollUrl,
      innbucks: response.innbucks_info || null,
    });
  } catch (error) {
    console.error("Paynow mobile integration error:", error.message);
    return sendJson(500, {
      success: false,
      error: error.message,
    });
  }
};
const { Paynow } = require("paynow");

const DEFAULT_INTEGRATION_ID = "24223";
const DEFAULT_INTEGRATION_KEY = "2336dda5-d3d2-4a1a-81a7-f6da364aedec";
const DEFAULT_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const DEFAULT_EMAIL = "royaltyzw.tech@gmail.com";

function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
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
    return [];
  }
  const parsedItems = safeJsonParse(envItems);
  return normalizeItems(parsedItems);
}

function buildRuntimeConfig() {
  const port = Number.isFinite(DEFAULT_PORT) ? DEFAULT_PORT : 3000;
  const baseUrl = normalizeBaseUrl(getEnv("URL", `http://localhost:${port}`));
  return {
    port,
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

const config = buildRuntimeConfig();

const paynow = new Paynow(config.integrationId, config.integrationKey);
paynow.resultUrl = `${config.baseUrl}/.netlify/functions/paynow-update`;
paynow.returnUrl = config.returnUrl;

function buildPayment(payload = {}) {
  const reference = typeof payload.reference === "string" && payload.reference.trim()
    ? payload.reference.trim()
    : config.defaultReference;

  const authEmail = typeof payload.authEmail === "string" && payload.authEmail.trim()
    ? payload.authEmail.trim()
    : config.defaultAuthEmail;

  if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("At least one payment item is required");
  }
  const items = normalizeItems(payload.items);
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

function buildRequestPayload(body, queryParams) {
  const payload = body && typeof body === "object" ? { ...body } : {};

  // Merge URL query parameters, with body taking precedence
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (!(key in payload) && value) {
        payload[key] = value;
      }
    }
  }

  return payload;
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

  if (event.httpMethod === "GET") {
    return sendJson(200, {
      service: "Paynow integration server",
      baseUrl: config.baseUrl,
      resultUrl: paynow.resultUrl,
      returnUrl: paynow.returnUrl,
      endpoints: {
        startWeb: "POST /.netlify/functions/paynow-start",
        startMobile: "POST /.netlify/functions/paynow-start-mobile",
        poll: "POST /.netlify/functions/paynow-poll",
        update: "GET|POST /.netlify/functions/paynow-update",
        return: "GET /.netlify/functions/paynow-return",
      },
      sampleWebBody: {
        reference: config.defaultReference,
        items: config.defaultItems,
      },
      sampleMobileBody: {
        reference: config.defaultReference,
        authEmail: "buyer@example.com",
        phone: "0777000000",
        method: "ecocash",
        items: config.defaultItems,
      },
      note: "This is a serverless Paynow integration hosted on Netlify.",
    });
  }

  if (event.httpMethod === "POST") {
    try {
      const queryParams = {};
      if (event.rawQuery) {
        const searchParams = new URLSearchParams(event.rawQuery);
        for (const [key, value] of searchParams.entries()) {
          queryParams[key] = value;
        }
      }

      const payload = buildRequestPayload(safeJsonParse(event.body, {}), queryParams);
      const { payment, reference, items } = buildPayment(payload);
      const response = await paynow.send(payment);

      if (!response) {
        throw new Error("Paynow did not return a response. Check your network or proxy settings.");
      }

      if (!response.success) {
        throw new Error(response.error || "Paynow rejected the payment request");
      }

      return sendJson(200, {
        success: true,
        reference,
        items,
        redirectUrl: response.redirectUrl,
        pollUrl: response.pollUrl,
        hasRedirect: response.hasRedirect,
      });
    } catch (error) {
      console.error("Paynow integration error:", error.message);
      return sendJson(500, {
        success: false,
        error: error.message,
      });
    }
  }

  return sendJson(404, {
    success: false,
    error: "Route not found",
  });
};
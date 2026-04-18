const http = require("http");
const { URL } = require("url");
const { Paynow } = require("paynow");

const DEFAULT_INTEGRATION_ID = "24223";
const DEFAULT_INTEGRATION_KEY = "2336dda5-d3d2-4a1a-81a7-f6da364aedec";
const DEFAULT_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const TEST_MODE_INTEGRATION_IDS = new Set([DEFAULT_INTEGRATION_ID]);


function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function ensureNoProxy(hosts) {
  const envKeys = ["NO_PROXY", "no_proxy"];

  for (const envKey of envKeys) {
    const existingEntries = (process.env[envKey] || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    const mergedEntries = [...new Set([...existingEntries, ...hosts])];
    process.env[envKey] = mergedEntries.join(",");
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk.toString("utf8");

      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
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
  const port = Number.isFinite(DEFAULT_PORT) ? DEFAULT_PORT : 3000;
  const baseUrl = normalizeBaseUrl(getEnv("PUBLIC_BASE_URL", `http://localhost:${port}`));

  return {
    port,
    baseUrl,
    integrationId: getEnv("PAYNOW_INTEGRATION_ID", DEFAULT_INTEGRATION_ID),
    integrationKey: getEnv("PAYNOW_INTEGRATION_KEY", DEFAULT_INTEGRATION_KEY),
    defaultReference: getEnv("PAYMENT_REFERENCE", "Invoice 35"),
    defaultAuthEmail: getEnv("PAYMENT_AUTH_EMAIL", ""),
    defaultPhone: getEnv("PAYMENT_PHONE", ""),
    defaultMethod: getEnv("PAYMENT_METHOD", "web").toLowerCase(),
    defaultItems: getDefaultItems(),
    returnUrl: getEnv("PAYNOW_RETURN_URL", "https://royaltyfuneral.com/paymentSuccess"),
  };
}

const config = buildRuntimeConfig();

ensureNoProxy([
  "paynow.co.zw",
  ".paynow.co.zw",
  "www.paynow.co.zw",
]);

const paynow = new Paynow(config.integrationId, config.integrationKey);
paynow.resultUrl = `${config.baseUrl}/paynow/update`;
paynow.returnUrl = config.returnUrl;

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

function buildRequestPayload(body, requestUrl) {
  const urlItems = requestUrl.searchParams.get("items");
  const queryPayload = {
    reference: requestUrl.searchParams.get("reference") || undefined,
    authEmail: requestUrl.searchParams.get("authEmail") || requestUrl.searchParams.get("email") || undefined,
    phone: requestUrl.searchParams.get("phone") || undefined,
    method: requestUrl.searchParams.get("method") || undefined,
    pollUrl: requestUrl.searchParams.get("pollUrl") || undefined,
    items: urlItems ? safeJsonParse(urlItems, undefined) : undefined,
  };

  return {
    ...queryPayload,
    ...(body && typeof body === "object" ? body : {}),
  };
}

async function sendWebPayment(payload) {
  const { payment, reference, items } = buildPayment(payload);
  const response = await paynow.send(payment);

  if (!response) {
    throw new Error("Paynow did not return a response. Check your network or proxy settings.");
  }

  if (!response.success) {
    throw new Error(response.error || "Paynow rejected the payment request");
  }

  return {
    success: true,
    reference,
    items,
    redirectUrl: response.redirectUrl,
    pollUrl: response.pollUrl,
    hasRedirect: response.hasRedirect,
  };
}

async function sendMobilePayment(payload) {
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

  return {
    success: true,
    reference,
    authEmail,
    phone,
    method,
    items,
    instructions: response.instructions || null,
    pollUrl: response.pollUrl,
    innbucks: response.innbucks_info || null,
  };
}

async function pollPayment(pollUrl) {
  if (!pollUrl) {
    throw new Error("pollUrl is required");
  }

  const response = await paynow.pollTransaction(pollUrl);

  if (!response) {
    throw new Error("Paynow did not return a poll response. Check your network or proxy settings.");
  }

  return {
    success: true,
    pollUrl,
    reference: response.reference || null,
    amount: response.amount || null,
    paynowReference: response.paynowReference || null,
    status: response.status ? String(response.status).toLowerCase() : null,
    paid: typeof response.paid === "function" ? response.paid() : String(response.status || "").toLowerCase() === "paid",
    raw: response,
  };
}

function parseStatusUpdatePayload(body, requestUrl) {
  const rawPayload = body && body.trim().length > 0
    ? body.trim()
    : requestUrl.searchParams.toString();

  if (!rawPayload) {
    throw new Error("No Paynow callback payload was received");
  }

  return paynow.parseStatusUpdate(rawPayload);
}

async function routeRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const contentType = request.headers["content-type"] || "";
  const rawBody = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : "";

  let parsedBody = null;
  if (rawBody && contentType.includes("application/json")) {
    parsedBody = safeJsonParse(rawBody, null);
    if (parsedBody === null) {
      throw new Error("Invalid JSON body");
    }
  }

  const payload = buildRequestPayload(parsedBody, requestUrl);

  if (request.method === "GET" && requestUrl.pathname === "/") {
    return sendJson(response, 200, {
      service: "Paynow integration server",
      baseUrl: config.baseUrl,
      resultUrl: paynow.resultUrl,
      returnUrl: paynow.returnUrl,
      endpoints: {
        startWeb: "POST /paynow/start",
        startMobile: "POST /paynow/start-mobile",
        poll: "POST /paynow/poll",
        update: "GET|POST /paynow/update",
        return: "GET /paynow/return",
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
      note: config.baseUrl.includes("localhost")
        ? "localhost works for your browser return URL, but Paynow cannot call your result URL unless you expose this server publicly."
        : "Ensure this base URL is reachable by Paynow for result callbacks.",
    });
  }

  if (request.method === "POST" && requestUrl.pathname === "/paynow/start") {
    const result = await sendWebPayment(payload);
    return sendJson(response, 200, result);
  }

  if (request.method === "POST" && requestUrl.pathname === "/paynow/start-mobile") {
    const result = await sendMobilePayment(payload);
    return sendJson(response, 200, result);
  }

  if (request.method === "POST" && requestUrl.pathname === "/paynow/poll") {
    const result = await pollPayment(payload.pollUrl);
    return sendJson(response, 200, result);
  }

  if (["GET", "POST"].includes(request.method) && requestUrl.pathname === "/paynow/update") {
    const update = parseStatusUpdatePayload(rawBody, requestUrl);

    return sendJson(response, 200, {
      success: true,
      message: "Paynow update received",
      update,
    });
  }

  if (request.method === "GET" && requestUrl.pathname === "/paynow/return") {
    return sendJson(response, 200, {
      success: true,
      message: "Customer returned from Paynow",
      params: Object.fromEntries(requestUrl.searchParams.entries()),
    });
  }

  return sendJson(response, 404, {
    success: false,
    error: "Route not found",
  });
}

function startServer() {
  const server = http.createServer((request, response) => {
    routeRequest(request, response).catch((error) => {
      console.error("Paynow integration error:", error.message);

      sendJson(response, 500, {
        success: false,
        error: error.message,
      });
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${config.port} is already in use. Set PORT to another value and try again.`);
      return;
    }

    console.error("Server failed to start:", error.message);
  });

  server.listen(config.port, () => {
    console.log(`Paynow server listening on ${config.baseUrl}`);
    console.log(`Web payments: POST ${config.baseUrl}/paynow/start`);
    console.log(`Mobile payments: POST ${config.baseUrl}/paynow/start-mobile`);
    console.log(`Result URL: ${paynow.resultUrl}`);
    console.log(`Return URL: ${paynow.returnUrl}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  config,
  paynow,
  buildPayment,
  sendWebPayment,
  sendMobilePayment,
  pollPayment,
  parseStatusUpdatePayload,
  startServer,
};

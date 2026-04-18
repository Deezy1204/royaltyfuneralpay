const { Paynow } = require("paynow");

const DEFAULT_INTEGRATION_ID = "24223";
const DEFAULT_INTEGRATION_KEY = "2336dda5-d3d2-4a1a-81a7-f6da364aedec";

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

function buildRuntimeConfig() {
  const baseUrl = getEnv("URL", "https://your-netlify-site.netlify.app");
  return {
    baseUrl,
    integrationId: getEnv("PAYNOW_INTEGRATION_ID", DEFAULT_INTEGRATION_ID),
    integrationKey: getEnv("PAYNOW_INTEGRATION_KEY", DEFAULT_INTEGRATION_KEY),
  };
}

const config = buildRuntimeConfig();
const paynow = new Paynow(config.integrationId, config.integrationKey);

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
    const pollUrl = payload.pollUrl;

    if (!pollUrl) {
      throw new Error("pollUrl is required");
    }

    const response = await paynow.pollTransaction(pollUrl);

    if (!response) {
      throw new Error("Paynow did not return a poll response. Check your network or proxy settings.");
    }

    return sendJson(200, {
      success: true,
      pollUrl,
      reference: response.reference || null,
      amount: response.amount || null,
      paynowReference: response.paynowReference || null,
      status: response.status ? String(response.status).toLowerCase() : null,
      paid: typeof response.paid === "function" ? response.paid() : String(response.status || "").toLowerCase() === "paid",
      raw: response,
    });
  } catch (error) {
    console.error("Paynow poll error:", error.message);
    return sendJson(500, {
      success: false,
      error: error.message,
    });
  }
};
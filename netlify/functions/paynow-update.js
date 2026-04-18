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

function parseStatusUpdatePayload(body, queryString) {
  const rawPayload = body && body.trim().length > 0
    ? body.trim()
    : queryString;

  if (!rawPayload) {
    throw new Error("No Paynow callback payload was received");
  }

  const paynow = new Paynow(DEFAULT_INTEGRATION_ID, DEFAULT_INTEGRATION_KEY);
  return paynow.parseStatusUpdate(rawPayload);
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

  if (!["GET", "POST"].includes(event.httpMethod)) {
    return sendJson(405, { success: false, error: "Method not allowed" });
  }

  try {
    const update = parseStatusUpdatePayload(event.body, event.rawQuery);

    return sendJson(200, {
      success: true,
      message: "Paynow update received",
      update,
    });
  } catch (error) {
    console.error("Paynow update error:", error.message);
    return sendJson(500, {
      success: false,
      error: error.message,
    });
  }
};
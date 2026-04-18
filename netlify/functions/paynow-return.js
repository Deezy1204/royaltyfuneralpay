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

  if (event.httpMethod !== "GET") {
    return sendJson(405, { success: false, error: "Method not allowed" });
  }

  try {
    const params = {};
    if (event.rawQuery) {
      const searchParams = new URLSearchParams(event.rawQuery);
      for (const [key, value] of searchParams.entries()) {
        params[key] = value;
      }
    }

    return sendJson(200, {
      success: true,
      message: "Customer returned from Paynow",
      params,
    });
  } catch (error) {
    console.error("Paynow return error:", error.message);
    return sendJson(500, {
      success: false,
      error: error.message,
    });
  }
};
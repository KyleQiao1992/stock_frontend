import { fetchFactorDim, factorLabel } from "./factorDim.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

// GET /api/factors?status=product|preliminary
// Returns the factor list from factor_dim, optionally filtered by status.
export function createFactorsHandler() {
  return async function factorsHandler(req, res) {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const statusParam = url.searchParams.get("status") || "";
      const status =
        statusParam === "production" || statusParam === "preliminary" ? statusParam : "";

      const factors = await fetchFactorDim(status);
      const data = factors.map((f) => ({
        name: f.name,
        status: f.status,
        label: factorLabel(f.name),
      }));
      return sendJson(res, 200, { ok: true, data });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}

import { fetchFactorDim, updateFactorDim, factorLabel } from "./factorDim.js";
import { clearFactorReturnsCache } from "./macdFactorHandler.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

// Factor management API, mounted at /api/admin/factors (so req.url is "/" for
// the list and "/<factor_name>" for a single factor — works identically under
// express app.use and the vite connect middleware, neither of which gives us
// route params here).
//   GET   /                -> list every factor (including disabled)
//   PATCH /:name { status?, enabled? } -> update a factor
export function createFactorAdminHandler() {
  return async function factorAdminHandler(req, res, next) {
    try {
      const method = String(req.method || "").toUpperCase();
      const url = new URL(req.url || "/", "http://localhost");
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, "").trim());

      if (method === "GET" && !name) {
        const factors = await fetchFactorDim("", true);
        const data = factors.map((f) => ({
          name: f.name,
          label: factorLabel(f.name),
          displayName: f.displayName,
          summary: f.summary,
          status: f.status,
          enabled: f.enabled,
          updatedAt: f.updatedAt,
          updatedBy: f.updatedBy,
        }));
        return sendJson(res, 200, { ok: true, data });
      }

      if (method === "PATCH" && name) {
        const body = await readRequestBody(req);
        const patch = {};
        if (body.status !== undefined) patch.status = body.status;
        if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.summary !== undefined) patch.summary = body.summary;
        if (Object.keys(patch).length === 0) {
          return sendJson(res, 400, { ok: false, error: "没有可更新的字段。" });
        }

        const updatedBy = req.user?.username || null;
        const affected = await updateFactorDim(name, patch, updatedBy);
        if (affected === 0) {
          return sendJson(res, 404, { ok: false, error: "因子不存在。" });
        }
        // status / enabled changes alter the factor universe of the cached
        // performance cards; bust the cache so they refresh immediately.
        if (patch.status !== undefined || patch.enabled !== undefined) {
          await clearFactorReturnsCache();
        }
        return sendJson(res, 200, { ok: true });
      }

      // Not a route we handle: fall through (express) or 404.
      if (typeof next === "function") return next();
      return sendJson(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  };
}

import { getMysqlPool } from "./mysqlClient.js";

// Derive a display label from the factor name, e.g. "factor7" -> "因子7".
// Falls back to the raw name for anything that doesn't match the pattern.
export function factorLabel(name) {
  const m = /^factor(\d+)$/.exec(String(name));
  return m ? `因子${m[1]}` : String(name);
}

function sortKey(name) {
  const m = /(\d+)/.exec(String(name));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Read the factor dimension table. Pass status ("production" | "preliminary")
// to filter; omit to get every factor. By default only enabled factors are
// returned (disabled ones are hidden from the whole app); pass
// includeDisabled = true for the management view. Returns
// [{ name, factorAttribute, status, enabled, updatedAt, updatedBy }] sorted by
// the numeric suffix of the factor name.
export async function fetchFactorDim(status, includeDisabled = false) {
  const pool = getMysqlPool();
  let sql =
    "SELECT factor_name, display_name, summary, factor_attribute, status, enabled, updated_at, updated_by FROM factor_dim";
  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (!includeDisabled) {
    where.push("enabled = 1");
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  const [rows] = await pool.query(sql, params);
  return rows
    .map((r) => ({
      name: r.factor_name,
      displayName: r.display_name,
      summary: r.summary,
      factorAttribute: r.factor_attribute,
      status: r.status,
      enabled: r.enabled === 1 || r.enabled === true,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }))
    .sort((a, b) => sortKey(a.name) - sortKey(b.name));
}

// Update a factor's management fields. Only `status` and `enabled` are
// writable. Returns the number of affected rows (0 if the factor is unknown).
export async function updateFactorDim(name, { status, enabled, displayName, summary }, updatedBy) {
  const pool = getMysqlPool();
  const sets = [];
  const params = [];
  if (status !== undefined) {
    if (status !== "production" && status !== "preliminary") {
      throw new Error("status 只能是 production 或 preliminary。");
    }
    sets.push("status = ?");
    params.push(status);
  }
  if (enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(enabled ? 1 : 0);
  }
  if (displayName !== undefined) {
    const v = String(displayName).trim();
    if (!v) throw new Error("显示名不能为空。");
    if (v.length > 64) throw new Error("显示名最长 64 个字符。");
    sets.push("display_name = ?");
    params.push(v);
  }
  if (summary !== undefined) {
    const v = String(summary).trim();
    if (v.length > 255) throw new Error("简介最长 255 个字符。");
    sets.push("summary = ?");
    params.push(v || null);
  }
  if (!sets.length) throw new Error("没有可更新的字段。");

  sets.push("updated_at = NOW()");
  sets.push("updated_by = ?");
  params.push(updatedBy || null);

  params.push(name);
  const [result] = await pool.query(
    `UPDATE factor_dim SET ${sets.join(", ")} WHERE factor_name = ?`,
    params
  );
  return result.affectedRows;
}

// Idempotent migration: add management columns to factor_dim.
// Run with: node server/migrations/001_factor_dim_enabled.mjs
import { getMysqlPool } from "../mysqlClient.js";

const COLUMNS = [
  { name: "enabled", ddl: "ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1" },
  { name: "updated_at", ddl: "ADD COLUMN updated_at DATETIME NULL" },
  { name: "updated_by", ddl: "ADD COLUMN updated_by VARCHAR(32) NULL" },
];

async function main() {
  const pool = getMysqlPool();
  const [existing] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factor_dim'`
  );
  const have = new Set(existing.map((r) => String(r.COLUMN_NAME).toLowerCase()));

  for (const col of COLUMNS) {
    if (have.has(col.name)) {
      console.log(`= factor_dim.${col.name} already exists, skipping`);
      continue;
    }
    await pool.query(`ALTER TABLE factor_dim ${col.ddl}`);
    console.log(`+ added factor_dim.${col.name}`);
  }

  await pool.end();
  console.log("done");
}

main().catch((e) => {
  console.error("migration failed:", e?.message || e);
  process.exit(1);
});

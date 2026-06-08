import mysql from "mysql2/promise";
import { loadServerEnv } from "./env.js";

loadServerEnv();

let pool = null;

export function getMysqlPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || "stock_db",
      ssl: false,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
    });
  }
  return pool;
}

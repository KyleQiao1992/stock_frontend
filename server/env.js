import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

let loaded = false;

export function loadServerEnv() {
  if (loaded) return;
  loaded = true;

  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const localEnvPath = path.join(rootDir, ".env.local");
  const envPath = path.join(rootDir, ".env");

  if (fs.existsSync(localEnvPath)) {
    loadDotenv({ path: localEnvPath, quiet: true });
  }

  if (fs.existsSync(envPath)) {
    loadDotenv({ path: envPath, quiet: true });
  }
}

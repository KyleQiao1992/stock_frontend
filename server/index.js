import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { loadServerEnv } from "./env.js";
import { createAshareFinanceHandler } from "./ashareFinance.js";
import { createAshareProfileHandler } from "./ashareProfile.js";
import { createAshareSearchHandler } from "./ashareSearch.js";
import { createFavoritesHandler } from "./favoritesHandlers.js";
import { createRedisRecommendationsHandler } from "./redisHandlers.js";
import { createUsKlineHandler } from "./usKline.js";
import { createMacdFactorReturnsHandler } from "./macdFactorHandler.js";
import { createMacdFactorDetailHandler } from "./macdFactorDetailHandler.js";
import { createFactorsHandler } from "./factorsHandler.js";
import { createFactorAdminHandler } from "./factorAdminHandler.js";
import { createAuthHandler } from "./authHandlers.js";
import { authMiddleware } from "./authMiddleware.js";

loadServerEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "../dist");

const app = express();
const port = Number(process.env.PORT) || 80;

// Public: auth routes (must be before authMiddleware)
app.use("/api/auth", createAuthHandler());

// All routes below require a valid JWT
app.use("/api", authMiddleware);

app.get("/api/us-kline", createUsKlineHandler());
app.get("/api/factors", createFactorsHandler());
app.use("/api/admin/factors", createFactorAdminHandler());
app.get("/api/factor-returns", createMacdFactorReturnsHandler());
app.get("/api/factor-detail", createMacdFactorDetailHandler());
app.get("/api/ashare-finance", createAshareFinanceHandler());
app.get("/api/ashare-profile", createAshareProfileHandler());
app.get("/api/ashare-search", createAshareSearchHandler());
app.get("/api/recommendations", createRedisRecommendationsHandler());
app.use("/api/favorites", createFavoritesHandler());

app.use(
  express.static(distDir, {
    maxAge: "1y",
    immutable: true,
    index: false,
  }),
);

app.use((_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});

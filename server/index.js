import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { loadServerEnv } from "./env.js";
import { createAshareFinanceHandler } from "./ashareFinance.js";
import { createAshareProfileHandler } from "./ashareProfile.js";
import { createFavoritesHandler } from "./favoritesHandlers.js";
import { createRedisRecommendationsHandler } from "./redisHandlers.js";
import { createUsKlineHandler } from "./usKline.js";

loadServerEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "../dist");

const app = express();
const port = Number(process.env.PORT) || 80;

app.get("/api/us-kline", createUsKlineHandler());
app.get("/api/ashare-finance", createAshareFinanceHandler());
app.get("/api/ashare-profile", createAshareProfileHandler());
app.get("/api/recommendations", createRedisRecommendationsHandler());
app.use("/api/favorites", createFavoritesHandler());

app.use(
  express.static(distDir, {
    maxAge: "1y",
    immutable: true,
    index: false,
  }),
);

app.use((req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});

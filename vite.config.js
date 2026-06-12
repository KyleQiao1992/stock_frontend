import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadServerEnv } from "./server/env.js";
import { createAshareFinanceHandler } from "./server/ashareFinance.js";
import { createAshareProfileHandler } from "./server/ashareProfile.js";
import { createAshareSearchHandler } from "./server/ashareSearch.js";
import { createFavoritesHandler } from "./server/favoritesHandlers.js";
import { createRedisRecommendationsHandler } from "./server/redisHandlers.js";
import { createUsKlineHandler } from "./server/usKline.js";
import { createMacdFactorReturnsHandler } from "./server/macdFactorHandler.js";
import { createMacdFactorDetailHandler } from "./server/macdFactorDetailHandler.js";
import { createFactorsHandler } from "./server/factorsHandler.js";
import { createFactorAdminHandler } from "./server/factorAdminHandler.js";
import { createAuthHandler } from "./server/authHandlers.js";
import { authMiddleware } from "./server/authMiddleware.js";

function usKlinePlugin() {
  loadServerEnv();
  const handler = createUsKlineHandler();
  const ashareFinanceHandler = createAshareFinanceHandler();
  const ashareProfileHandler = createAshareProfileHandler();
  const ashareSearchHandler = createAshareSearchHandler();
  const redisRecommendationsHandler = createRedisRecommendationsHandler();
  const favoritesHandler = createFavoritesHandler();
  const factorReturnsHandler = createMacdFactorReturnsHandler();
  const factorDetailHandler = createMacdFactorDetailHandler();
  const factorsHandler = createFactorsHandler();
  const factorAdminHandler = createFactorAdminHandler();
  const authHandler = createAuthHandler();

  function register(middlewares) {
    middlewares.use("/api/auth", authHandler);
    middlewares.use("/api", authMiddleware);
    middlewares.use("/api/us-kline", handler);
    middlewares.use("/api/ashare-finance", ashareFinanceHandler);
    middlewares.use("/api/ashare-profile", ashareProfileHandler);
    middlewares.use("/api/ashare-search", ashareSearchHandler);
    middlewares.use("/api/recommendations", redisRecommendationsHandler);
    middlewares.use("/api/favorites", favoritesHandler);
    middlewares.use("/api/admin/factors", factorAdminHandler);
    middlewares.use("/api/factors", factorsHandler);
    middlewares.use("/api/factor-returns", factorReturnsHandler);
    middlewares.use("/api/factor-detail", factorDetailHandler);
  }

  return {
    name: "local-us-kline-api",
    configureServer(server) {
      register(server.middlewares);
    },
    configurePreviewServer(server) {
      register(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), usKlinePlugin()],
  resolve: {
    alias: {
      "@": path.resolve(new URL(".", import.meta.url).pathname, "./src"),
    },
  },
});

import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadServerEnv } from "./server/env.js";
import { createAshareFinanceHandler } from "./server/ashareFinance.js";
import { createAshareProfileHandler } from "./server/ashareProfile.js";
import { createFavoritesHandler } from "./server/favoritesHandlers.js";
import { createRedisRecommendationsHandler } from "./server/redisHandlers.js";
import { createUsKlineHandler } from "./server/usKline.js";

function usKlinePlugin() {
  loadServerEnv();
  const handler = createUsKlineHandler();
  const ashareFinanceHandler = createAshareFinanceHandler();
  const ashareProfileHandler = createAshareProfileHandler();
  const redisRecommendationsHandler = createRedisRecommendationsHandler();
  const favoritesHandler = createFavoritesHandler();

  function register(middlewares) {
    middlewares.use("/api/us-kline", handler);
    middlewares.use("/api/ashare-finance", ashareFinanceHandler);
    middlewares.use("/api/ashare-profile", ashareProfileHandler);
    middlewares.use("/api/recommendations", redisRecommendationsHandler);
    middlewares.use("/api/favorites", favoritesHandler);
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

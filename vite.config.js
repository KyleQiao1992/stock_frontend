import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createAshareFinanceHandler } from "./server/ashareFinance.js";
import { createUsKlineHandler } from "./server/usKline.js";

function usKlinePlugin() {
  const handler = createUsKlineHandler();
  const ashareFinanceHandler = createAshareFinanceHandler();

  function register(middlewares) {
    middlewares.use("/api/us-kline", handler);
    middlewares.use("/api/ashare-finance", ashareFinanceHandler);
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

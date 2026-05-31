import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { createAshareFinanceHandler } from "./ashareFinance.js";
import { createUsKlineHandler } from "./usKline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "../dist");

const app = express();
const port = Number(process.env.PORT) || 80;

app.get("/api/us-kline", createUsKlineHandler());
app.get("/api/ashare-finance", createAshareFinanceHandler());

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

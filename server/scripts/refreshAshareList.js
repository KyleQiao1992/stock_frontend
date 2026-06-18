// 重新生成打包进仓库的 A 股静态快照（server/data/ashare-list.json）。
// 用法：node server/scripts/refreshAshareList.js
// 运行时后台也会每 12h 刷新内存索引，这个脚本只用来更新提交到 git 的快照文件。
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "../data/ashare-list.json");
const PAGE_SIZE = 100;
const MAX_PAGES = 80;

async function fetchPage(page) {
  const url =
    "http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
    `?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=hs_a`;
  const res = await fetch(url, {
    headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Sina HTTP ${res.status} (page ${page})`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function main() {
  const map = new Map();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await fetchPage(page);
    if (!rows.length) break;
    for (const x of rows) {
      const code = String(x?.code || "").trim();
      const name = String(x?.name || "").trim();
      if (/^\d{6}$/.test(code) && name) map.set(code, name);
    }
    process.stdout.write(`\rpage ${page} · total ${map.size}`);
    if (rows.length < PAGE_SIZE) break;
  }
  const arr = Array.from(map, ([code, name]) => ({ code, name })).sort((a, b) =>
    a.code.localeCompare(b.code),
  );
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(arr), "utf-8");
  process.stdout.write(`\nwrote ${arr.length} stocks to ${OUT_PATH}\n`);
}

main().catch((error) => {
  console.error("refresh failed:", error?.message || error);
  process.exit(1);
});

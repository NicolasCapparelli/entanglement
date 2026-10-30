// Builds browser-check/main.ts with esbuild, serves it, and runs it in each Playwright browser.
// Usage: node browser-check/run.mjs [chromium|webkit|firefox ...]   (default: chromium webkit)
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(here, "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: "inline",
  logLevel: "warning",
});
await copyFile(join(here, "index.html"), join(out, "index.html"));
await copyFile(join(here, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"), join(out, "sql-wasm.wasm"));

const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  try {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const body = await readFile(join(out, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const engines = { chromium, webkit, firefox };
const wanted = process.argv.slice(2);
let failed = false;
for (const name of wanted.length ? wanted : ["chromium", "webkit"]) {
  const browser = await engines[name].launch();
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [${name}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(url);
  try {
    await page.waitForFunction(() => window.__result, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.__result);
    if (result.ok) console.log(`PASS ${name}: ${JSON.stringify(result.details)}`);
    else {
      failed = true;
      console.log(`FAIL ${name}: ${result.error}`);
    }
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}: no result (${error.message})`);
  }
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);

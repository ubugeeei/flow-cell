const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const root = __dirname;
  const flowTypes = path.join(root, "dist", "FlowCell.js.flow");
  const clientTypes = path.join(root, "dist", "Client.js.flow");
  const serverTypes = path.join(root, "dist", "Server.js.flow");

  for (const typeFile of [flowTypes, clientTypes, serverTypes]) {
    if (!fs.existsSync(typeFile)) {
      throw new Error(`Missing ${path.relative(root, typeFile)}`);
    }
  }

  const cjs = require(path.join(root, "dist", "FlowCell.js"));
  const cjsCell = cjs.cell(1, { key: "smoke.cjs" });
  cjsCell.update(value => value + 1);

  if (cjsCell.get() !== 2) {
    throw new Error("CJS smoke failed");
  }

  const esm = await import(pathToFileURL(path.join(root, "dist", "FlowCell.mjs")).href);
  const esmCell = esm.cell("a", { key: "smoke.esm" });
  const scope = esm.createScope();
  scope.set(esmCell, "b");

  if (esmCell.get() !== "a" || scope.get(esmCell) !== "b") {
    throw new Error("ESM smoke failed");
  }

  const server = await import(pathToFileURL(path.join(root, "dist", "Server.mjs")).href);
  if (typeof server.cell !== "function" || Object.hasOwn(server, "useCell")) {
    throw new Error("RSC server entry smoke failed");
  }

  const clientSource = fs.readFileSync(path.join(root, "dist", "Client.mjs"), "utf8");
  if (!clientSource.includes("\"use client\"") || !clientSource.includes("useCell")) {
    throw new Error("RSC client entry smoke failed");
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

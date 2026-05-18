const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const root = __dirname;
  const flowTypes = path.join(root, "dist", "FlowCell.js.flow");

  if (!fs.existsSync(flowTypes)) {
    throw new Error("Missing dist/FlowCell.js.flow");
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
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

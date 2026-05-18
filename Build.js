const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");

const root = __dirname;
const src = path.join(root, "src", "Flowcell.js");
const flowSrc = path.join(root, "src", "Flowcell.js.flow");

const flowPreset = [require.resolve("@babel/preset-flow"), { all: true }];

function compile({ outFile, plugins = [] }) {
  const result = babel.transformFileSync(src, {
    babelrc: false,
    comments: true,
    configFile: false,
    filename: src,
    plugins,
    presets: [flowPreset],
    sourceType: "module",
  });

  if (result == null || result.code == null) {
    throw new Error(`Failed to compile ${outFile}`);
  }

  fs.writeFileSync(path.join(root, outFile), `${result.code}\n`);
}

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });

compile({
  outFile: "Flowcell.js",
  plugins: [
    [
      require.resolve("@babel/plugin-transform-modules-commonjs"),
      { strictMode: false },
    ],
  ],
});
compile({ outFile: "Flowcell.mjs" });

fs.copyFileSync(flowSrc, path.join(root, "Flowcell.js.flow"));

const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");

const root = __dirname;
const srcDir = path.join(root, "src");
const dist = path.join(root, "dist");

const flowPreset = [
  require.resolve("@babel/preset-flow"),
  {
    all: true,
    experimental_useHermesParser: true,
  },
];

function rewriteEsmImports(code) {
  return code.replace(
    /(from\s+["']\.\/[^"']*?)(["'])/g,
    (match, specifier, quote) => (
      specifier.endsWith(".mjs") || specifier.endsWith(".js")
        ? match
        : `${specifier}.mjs${quote}`
    )
  );
}

function compile({ src, outFile, plugins = [], esm = false }) {
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

  const code = esm ? rewriteEsmImports(result.code) : result.code;
  fs.writeFileSync(path.join(dist, outFile), `${code}\n`);
}

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const fileName of fs.readdirSync(srcDir)) {
  if (
    !/^[A-Z]/.test(fileName) ||
    !fileName.endsWith(".js") ||
    fileName.endsWith(".test.js") ||
    fileName.endsWith(".flowtest.js")
  ) {
    continue;
  }

  const src = path.join(srcDir, fileName);
  const baseName = fileName.slice(0, -3);

  compile({
    src,
    outFile: `${baseName}.js`,
    plugins: [
      [
        require.resolve("@babel/plugin-transform-modules-commonjs"),
        { strictMode: false },
      ],
    ],
  });
  compile({
    src,
    outFile: `${baseName}.mjs`,
    esm: true,
  });
}

for (const fileName of fs.readdirSync(srcDir)) {
  if (/^[A-Z]/.test(fileName) && fileName.endsWith(".js.flow")) {
    fs.copyFileSync(path.join(srcDir, fileName), path.join(dist, fileName));
  }
}

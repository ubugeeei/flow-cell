const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const test = require("node:test");
const util = require("node:util");
const babel = require("@babel/core");

const root = __dirname;
const srcDir = path.join(root, "src");
const buildDir = path.join(root, ".test-build");

const flowPreset = [
  require.resolve("@babel/preset-flow"),
  {
    all: true,
    experimental_useHermesParser: true,
  },
];

function installDom(Window) {
  const window = new Window({ url: "http://localhost/" });

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;

  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) {
      continue;
    }

    Object.defineProperty(globalThis, key, Object.getOwnPropertyDescriptor(window, key));
  }
}

function createMockFunction(implementation = () => undefined) {
  function mockFunction(...args) {
    mockFunction.mock.calls.push(args);
    return implementation.apply(this, args);
  }

  mockFunction.mock = { calls: [] };
  mockFunction.mockClear = () => {
    mockFunction.mock.calls = [];
  };

  return mockFunction;
}

function assertMock(actual) {
  assert.equal(typeof actual, "function");
  assert.ok(actual.mock && Array.isArray(actual.mock.calls));
}

function assertToThrow(actual, expected) {
  assert.equal(typeof actual, "function");

  try {
    actual();
  } catch (error) {
    if (expected == null) {
      return;
    }

    if (typeof expected === "string") {
      assert.ok(String(error && error.message ? error.message : error).includes(expected));
      return;
    }

    if (expected instanceof RegExp) {
      assert.match(String(error && error.message ? error.message : error), expected);
      return;
    }

    if (typeof expected === "function") {
      assert.ok(error instanceof expected);
      return;
    }

    assert.deepStrictEqual(error, expected);
    return;
  }

  assert.fail("Expected function to throw");
}

function expect(actual) {
  const matchers = {
    toBe(expected) {
      assert.ok(Object.is(actual, expected), `Expected ${util.inspect(actual)} to be ${util.inspect(expected)}`);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toContain(expected) {
      assert.ok(actual.includes(expected));
    },
    toContainEqual(expected) {
      assert.ok(actual.some(value => util.isDeepStrictEqual(value, expected)));
    },
    toBeTruthy() {
      assert.ok(actual);
    },
    toThrow(expected) {
      assertToThrow(actual, expected);
    },
    toHaveBeenCalled() {
      assertMock(actual);
      assert.notEqual(actual.mock.calls.length, 0);
    },
    toHaveBeenCalledTimes(expected) {
      assertMock(actual);
      assert.equal(actual.mock.calls.length, expected);
    },
  };

  matchers.not = {
    toBe(expected) {
      assert.ok(!Object.is(actual, expected), `Expected ${util.inspect(actual)} not to be ${util.inspect(expected)}`);
    },
    toHaveBeenCalled() {
      assertMock(actual);
      assert.equal(actual.mock.calls.length, 0);
    },
  };

  if (actual && typeof actual.then === "function") {
    matchers.resolves = {
      async toBe(expected) {
        const value = await actual;
        assert.ok(Object.is(value, expected), `Expected ${util.inspect(value)} to be ${util.inspect(expected)}`);
      },
      async toEqual(expected) {
        assert.deepStrictEqual(await actual, expected);
      },
    };
    matchers.rejects = {
      async toThrow(expected) {
        try {
          await actual;
        } catch (error) {
          assertToThrow(() => {
            throw error;
          }, expected);
          return;
        }

        assert.fail("Expected promise to reject");
      },
    };
  }

  return matchers;
}

function compileTestSources() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  for (const fileName of fs.readdirSync(srcDir)) {
    if (!fileName.endsWith(".js")) {
      continue;
    }

    const src = path.join(srcDir, fileName);
    const result = babel.transformFileSync(src, {
      babelrc: false,
      comments: true,
      configFile: false,
      filename: src,
      plugins: [
        [
          require.resolve("@babel/plugin-transform-modules-commonjs"),
          { strictMode: false },
        ],
      ],
      presets: [flowPreset],
      sourceType: "module",
    });

    if (result == null || result.code == null) {
      throw new Error(`Failed to compile ${fileName}`);
    }

    fs.writeFileSync(path.join(buildDir, fileName), `${result.code}\n`);
  }
}

async function main() {
  const { Window } = await import("happy-dom");

  installDom(Window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.jest = { fn: createMockFunction };
  globalThis.expect = expect;
  globalThis.test = test;

  compileTestSources();
  require(path.join(buildDir, "FlowCell.test.js"));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

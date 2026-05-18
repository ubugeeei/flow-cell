module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/src/*.test.js"],
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        presets: [
          [
            "@babel/preset-flow",
            {
              all: true,
              experimental_useHermesParser: true
            }
          ]
        ],
        plugins: [
          [
            "@babel/plugin-transform-modules-commonjs",
            { strictMode: false }
          ]
        ]
      }
    ]
  }
};

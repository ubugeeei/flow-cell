module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/*.test.js"],
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        presets: [["@babel/preset-flow", { all: true }]],
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

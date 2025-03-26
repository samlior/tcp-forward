const json = require("@rollup/plugin-json");
const commonjs = require("@rollup/plugin-commonjs");
const terser = require("@rollup/plugin-terser");
const { nodeResolve } = require("@rollup/plugin-node-resolve");

module.exports = ["client", "forward", "server", "helper"].map((key) => {
  return {
    input: `dist/${key}.js`,
    output: {
      dir: `dist/${key}`,
      format: "commonjs",
      entryFileNames: `${key}.min.js`,
      chunkFileNames: `chunks/[name]-[hash].js`,
    },
    plugins: [nodeResolve({ browser: false }), commonjs(), json(), terser()],
  };
});

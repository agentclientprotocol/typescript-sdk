import { gzipSync } from "node:zlib";
import { build } from "esbuild";

// Bundle public package imports, including dependencies, as a browser app would.
// Re-export the symbol so minification cannot discard the consumer itself.
for (const [entry, schema] of [
  ["@agentclientprotocol/sdk", "dist/v1/schema"],
  ["@agentclientprotocol/sdk/unstable", "dist/v1/unstable/schema"],
  ["@agentclientprotocol/sdk/experimental/v2", "dist/v2/schema"],
  [
    "@agentclientprotocol/sdk/experimental/v2/unstable",
    "dist/v2/unstable/schema",
  ],
]) {
  for (const name of [
    "PROTOCOL_VERSION",
    "methods",
    "ndJsonStream",
    "client",
  ]) {
    const { outputFiles, metafile } = await build({
      stdin: {
        contents: `export { ${name} } from "${entry}";`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      minify: true,
      write: false,
      metafile: true,
    });
    const { contents } = outputFiles[0];
    console.log(
      `${entry} ${name}: ${contents.length} bytes minified, ${gzipSync(contents).length} gzip`,
    );

    // Count modules that contributed bytes, not everything esbuild parsed
    // while resolving re-exports. A client needs its own validators, not the
    // other protocol versions reached via the optional v2 router.
    const inputs = Object.values(metafile.outputs)[0].inputs;
    const unexpected = Object.entries(inputs)
      .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
      .map(([path]) => path)
      .filter((path) =>
        name === "client"
          ? path.endsWith("/zod.gen.js") && path !== `${schema}/zod.gen.js`
          : path.endsWith("/zod.gen.js") || path.includes("node_modules/zod/"),
      );
    if (unexpected.length) {
      throw new Error(`${entry} ${name} pulled in ${unexpected.join(", ")}`);
    }
    // Leave room for the helpers to grow without silently bundling the SDK.
    const budget = name === "PROTOCOL_VERSION" ? 256 : 8 * 1024;
    if (name !== "client" && contents.length > budget) {
      throw new Error(`${entry} ${name} exceeded its ${budget}-byte budget`);
    }
  }
}

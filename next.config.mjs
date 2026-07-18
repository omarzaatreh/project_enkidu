/**
 * Next.js config for the cockpit — deliberately minimal. The app is localhost
 * only (`npm run ui` binds 127.0.0.1); API keys stay server-side.
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // The engine keeps root tsconfig.json (NodeNext). The cockpit typechecks
  // under its own bundler-resolution config so `npm run typecheck` stays green.
  typescript: {
    tsconfigPath: "app/tsconfig.json",
  },
  // The API routes (app/api/**) call into lib/ui, which uses NodeNext relative
  // imports WITH .js extensions (e.g. `import "../runner.js"`). Teach the
  // bundlers to resolve those .js specifiers to the .ts source so the thin
  // route wrappers can reuse the engine directly. Covers both webpack and
  // Turbopack.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};

export default nextConfig;

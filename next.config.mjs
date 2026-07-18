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
  // imports WITH .js extensions (e.g. `import "../runner.js"`). webpack resolves
  // those .js specifiers to the .ts source via extensionAlias below.
  //
  // Turbopack (Next 16's default dev bundler) has no equivalent extension-remap
  // for explicit `.js`→`.ts` imports — `turbopack.resolveExtensions` only
  // affects EXTENSIONLESS specifiers, so every route importing lib/ui 500s with
  // "Can't resolve '../runner.js'". Hence `npm run ui` pins `--webpack`
  // (see package.json). Revisit if Turbopack gains an extensionAlias option.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;

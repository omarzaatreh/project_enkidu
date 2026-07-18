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
};

export default nextConfig;

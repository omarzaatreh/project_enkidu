/**
 * Ambient module declarations for CSS side-effect imports (e.g.
 * `import "./globals.css"`). Next.js generates equivalent typings when it runs,
 * but a bare `tsc -p app/tsconfig.json` needs this to resolve the import.
 */
declare module "*.css";

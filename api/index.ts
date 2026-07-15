// Vercel's zero-config Node.js runtime only discovers Serverless Functions
// inside the top-level `api/` directory. Our actual Express app lives in
// `src/api.ts` (used for local dev via `npm run dev`), so this file simply
// re-exports it as the entry point Vercel will invoke in production.
export { default } from "../src/api";

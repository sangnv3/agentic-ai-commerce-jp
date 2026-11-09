/** CLI: npm run migrate (production build) / npm run dev:migrate (local). */
import { runMigrations } from "./migrations.js";

await runMigrations();

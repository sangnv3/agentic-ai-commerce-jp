import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { agentRouter } from "./routes/agent.js";
import { checkoutRouter } from "./routes/checkout.js";
import { authRouter } from "./routes/auth.js";
import { accountRouter } from "./routes/account.js";
import { resumePendingPostOrderJobs } from "./jobs/postOrder.js";
import { config } from "./config.js";
import { csrfCookie, securityHeaders } from "./http/security.js";
import { redis } from "./checkout/confirmation.js";
import { db } from "./db/pool.js";
import { runMigrations } from "./db/migrations.js";
import { seedSampleData } from "./db/sampleSeed.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Railway's / Azure's proxy: req.ip = client IP, req.secure from X-Forwarded-Proto
app.use(securityHeaders);
app.use(express.json({ limit: "32kb" }));
app.use(csrfCookie);

app.use("/api/auth", authRouter);
app.use("/api/agent", agentRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api", accountRouter);
app.use("/api", (_req, res) => res.status(404).json({ code: "NOT_FOUND" }));

/** Liveness + dependencies (used by Railway's healthcheck). */
app.get("/healthz", async (_req, res) => {
  try {
    await Promise.all([redis.ping(), db.query("select 1")]);
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e) });
  }
});

// The SPA (web/dist) is served from the same origin as the API: no CORS, SameSite cookies work.
const webDist = config.webDistDir ? path.resolve(config.webDistDir) : "";
if (webDist && existsSync(path.join(webDist, "index.html"))) {
  app.use(express.static(webDist, { index: false, maxAge: "1h", setHeaders: (res, file) => {
    if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
  } }));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

// Last-resort error handler: log, answer with a generic error, never crash the process or leak internals.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[backend] unhandled route error:", err);
  if (res.headersSent) return res.end();
  const code = (err as { code?: string })?.code;
  res.status(code && /^[A-Z_]+$/.test(code) ? 409 : 500).json({ code: code ?? "INTERNAL_ERROR" });
});
process.on("unhandledRejection", (reason) => console.error("[backend] unhandled rejection:", reason));

// Schema (and sample data when enabled) are applied before accepting traffic — safe with several instances
// (advisory lock) and independent of the hosting platform's pre-deploy hooks.
await runMigrations((m) => console.log(m));
if (process.env.SEED_SAMPLE_DATA === "true") await seedSampleData();

const server = app.listen(config.port, () => {
  console.log(`backend listening on :${config.port} (auth: ${config.authMode}${config.devMode ? ", DEV_MODE" : ""}, web: ${webDist || "not served"})`);
  resumePendingPostOrderJobs().catch((e) => console.error("[post-order] resume failed", e));
});

// Graceful shutdown on redeploy: stop accepting, let in-flight chat turns finish (up to the turn timeout).
function shutdown(signal: string) {
  console.log(`[backend] ${signal} received, shutting down`);
  server.close(async () => {
    await Promise.allSettled([redis.quit(), db.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), config.llm.turnTimeoutMs + 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

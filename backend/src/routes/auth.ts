import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { rateLimit } from "../http/security.js";
import { checkDemoPassword, issueDemoToken } from "../auth/demo.js";

export const authRouter = Router();

/** Public: tells the SPA how to sign in. Contains no secrets. */
authRouter.get("/config", (_req, res) => {
  res.json({
    mode: config.authMode,
    entra: config.authMode === "entra" ? { clientId: config.entra.spaClientId, tenantId: config.entra.tenantId, scope: config.entra.apiScope } : null,
  });
});

/** Demo deployments only: shared password → a fresh sample customer. */
authRouter.post(
  "/demo-login",
  rateLimit("demo-login", 10, 60),
  asyncHandler(async (req, res) => {
    if (config.authMode !== "demo") return res.status(404).json({ code: "NOT_FOUND" });
    const body = z.object({ password: z.string().max(200) }).strict().safeParse(req.body);
    if (!body.success || !checkDemoPassword(body.data.password)) return res.status(401).json({ code: "INVALID_PASSWORD" });
    res.json(await issueDemoToken());
  }),
);

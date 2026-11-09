/**
 * Generate the ES256 key pair that signs confirmation tokens.
 *   npm run dev:keys            → writes dev/keys/*.pem for local development (git-ignored)
 *   npm run dev:keys -- --print → prints a NEW private key as one line, ready to paste into the
 *                                 CONFIRMATION_SIGNING_KEY_PEM variable on Railway (never commit it)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const pkcs8 = await exportPKCS8(privateKey);

if (process.argv.includes("--print")) {
  console.log(pkcs8.trim().replace(/\n/g, "\\n"));
} else {
  const dir = new URL("./keys/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const priv = new URL("confirmation-private.pem", dir);
  if (existsSync(priv)) {
    console.log("dev/keys already exist — keeping them.");
  } else {
    writeFileSync(priv, pkcs8, { mode: 0o600 });
    writeFileSync(new URL("confirmation-public.pem", dir), await exportSPKI(publicKey));
    console.log("Generated dev/keys/confirmation-private.pem");
  }
}

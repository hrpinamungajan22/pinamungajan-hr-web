import fs from "node:fs";

/** Strip accidental surrounding quotes sometimes present in `.env` files */
export function normalizeEnvPath(s: string) {
  return String(s || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

export function assertServiceAccountJsonFileExists(absPath: string, label = "Credential file"): void {
  const p = normalizeEnvPath(absPath);
  if (!p) return;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) {
      throw new Error(`${label}: not a regular file (${p})`);
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if ((err as { code?: string })?.code === "ENOENT") {
      throw new Error(
        `${label} missing (${p})\n\n` +
          `That path was set for GOOGLE_APPLICATION_CREDENTIALS (or typo GOOGLE_APPLICATION_CREDENTIALIALS) ` +
          `but the file does not exist on this computer (often copied from another machine).\n\n` +
          `Fix one of:\n` +
          `  • Put your own JSON key somewhere local and set GOOGLE_APPLICATION_CREDENTIALS=C:\\absolute\\path\\key.json\n` +
          `  • Or set GCP_SERVICE_ACCOUNT_JSON to the full JSON (best for teams / servers without a fixed path)\n` +
          `  • Then restart "npm run dev"`
      );
    }
    throw e;
  }
}

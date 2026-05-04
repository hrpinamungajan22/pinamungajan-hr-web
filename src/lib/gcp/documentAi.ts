import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { assertServiceAccountJsonFileExists, normalizeEnvPath } from "@/lib/gcp/credentialsEnv";

function readEnv(...keys: string[]) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

function parseServiceAccountJson(raw: string) {
  const v = String(raw || "").trim();
  if (!v) return null;
  
  // Try parsing as-is first
  try {
    const parsed = JSON.parse(v);
    // Fix private_key newlines if needed
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch {
    // Try removing outer quotes if present (Vercel sometimes adds them)
    try {
      const unquoted = v.replace(/^"/, "").replace(/"$/, "");
      const parsed = JSON.parse(unquoted);
      if (parsed.private_key && typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    } catch {
      // Try with unescaping
      try {
        const unescaped = v.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const parsed = JSON.parse(unescaped);
        if (parsed.private_key && typeof parsed.private_key === 'string') {
          parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
        }
        return parsed;
      } catch {
        return null;
      }
    }
  }
}

export function getDocumentAiConfig() {
  const credentialsJsonRaw = readEnv("GCP_SERVICE_ACCOUNT_JSON", "GOOGLE_CLOUD_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON");
  
  // DEBUG: Log what we received (hide sensitive parts)
  console.log("[DEBUG DOC-AI] GCP_SERVICE_ACCOUNT_JSON length:", credentialsJsonRaw?.length || 0);
  console.log("[DEBUG DOC-AI] First 100 chars:", credentialsJsonRaw?.substring(0, 100) || "EMPTY");
  console.log("[DEBUG DOC-AI] Last 50 chars:", credentialsJsonRaw?.substring(credentialsJsonRaw.length - 50) || "EMPTY");
  
  const credentials = credentialsJsonRaw ? parseServiceAccountJson(credentialsJsonRaw) : null;
  
  // DEBUG: Check if credentials parsed correctly
  console.log("[DEBUG DOC-AI] Credentials parsed:", !!credentials);
  if (credentials) {
    console.log("[DEBUG DOC-AI] Project ID from creds:", credentials.project_id);
    console.log("[DEBUG DOC-AI] Client email:", credentials.client_email);
    console.log("[DEBUG DOC-AI] Has private_key:", !!credentials.private_key);
    if (credentials.private_key) {
      const pk = credentials.private_key;
      console.log("[DEBUG DOC-AI] Private key starts with:", pk.substring(0, 30));
      console.log("[DEBUG DOC-AI] Private key contains newlines:", pk.includes("\n"));
      console.log("[DEBUG DOC-AI] Private key length:", pk.length);
    }
  }

  // Local dev can use ADC via a file path, e.g. GOOGLE_APPLICATION_CREDENTIALS=C:\path\key.json
  // Note: Vercel cannot rely on local files, so production should use GCP_SERVICE_ACCOUNT_JSON.
  const adcPathRaw = readEnv("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALIALS");
  const adcPath = adcPathRaw ? normalizeEnvPath(adcPathRaw) : "";
  if (!credentials && adcPath) assertServiceAccountJsonFileExists(adcPath, "GOOGLE_APPLICATION_CREDENTIALS");

  const projectIdFromEnv = readEnv("GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT");
  const projectId = projectIdFromEnv || String(credentials?.project_id || "").trim();
  const location = readEnv("DOCUMENT_AI_LOCATION", "GCP_DOCUMENT_AI_LOCATION");
  const processorId = readEnv("DOCUMENT_AI_PROCESSOR_ID", "GCP_DOCUMENT_AI_PROCESSOR_ID");

  console.log("[DEBUG DOC-AI] Final projectId:", projectId);
  console.log("[DEBUG DOC-AI] Final location:", location);
  console.log("[DEBUG DOC-AI] Final processorId:", processorId?.substring(0, 10) + "...");

  const missing: string[] = [];
  if (!projectId) missing.push("GCP_PROJECT_ID");
  if (!location) missing.push("DOCUMENT_AI_LOCATION");
  if (!processorId) missing.push("DOCUMENT_AI_PROCESSOR_ID");
  if (!credentials && !adcPath) missing.push("GCP_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS file path)");
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}`);
  }

  return { projectId, location, processorId, credentials, adcPath };
}

export function createDocumentAiClient() {
  const cfg = getDocumentAiConfig();
  if (cfg.credentials) {
    console.log("[DEBUG DOC-AI] Creating client with credentials");
    return new DocumentProcessorServiceClient({ projectId: cfg.projectId, credentials: cfg.credentials });
  }
  // Use ADC (GOOGLE_APPLICATION_CREDENTIALS) if provided.
  if (cfg.adcPath && !String(process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim()) {
    // If the user set the common misspelling GOOGLE_APPLICATION_CREDENTIALIALS,
    // mirror it into the correct env var so Google auth can discover it (normalized path).
    process.env.GOOGLE_APPLICATION_CREDENTIALS = normalizeEnvPath(cfg.adcPath);
  }
  console.log("[DEBUG DOC-AI] Creating client with ADC");
  return new DocumentProcessorServiceClient({ projectId: cfg.projectId });
}

export function getProcessorName() {
  const { projectId, location, processorId } = getDocumentAiConfig();
  const fullName = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  console.log("[DEBUG DOC-AI] Full processor name:", fullName);
  return fullName;
}

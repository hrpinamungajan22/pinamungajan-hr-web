import vision from "@google-cloud/vision";
import { assertServiceAccountJsonFileExists } from "@/lib/gcp/credentialsEnv";
import type { DocToken } from "../pds/documentAiTokens";

let cachedVisionCredentials: any | null | undefined;
let cachedVisionClient: any = null;

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

  try {
    const parsed = JSON.parse(v);
    if (parsed.private_key && typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch {
    try {
      const unquoted = v.replace(/^"/, "").replace(/"$/, "");
      const parsed = JSON.parse(unquoted);
      if (parsed.private_key && typeof parsed.private_key === "string") {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    } catch {
      try {
        const unescaped = v.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const parsed = JSON.parse(unescaped);
        if (parsed.private_key && typeof parsed.private_key === "string") {
          parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
        }
        return parsed;
      } catch {
        return null;
      }
    }
  }
}

/**
 * OCR using Google Cloud Vision API as fallback when Document AI fails
 */
export async function performCloudVisionOcr(
  imageBuffer: Buffer,
  pageIndex: number = 0
): Promise<{
  text: string;
  tokens: DocToken[];
  confidence: number;
}> {
  if (cachedVisionCredentials === undefined) {
    const credentialsJsonRaw = readEnv("GCP_SERVICE_ACCOUNT_JSON", "GOOGLE_CLOUD_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON");
    cachedVisionCredentials = credentialsJsonRaw ? parseServiceAccountJson(credentialsJsonRaw) : null;
  }
  const credentials = cachedVisionCredentials;

  if (credentials) {
    const hasEmail = typeof (credentials as any).client_email === "string" && String((credentials as any).client_email).trim();
    const hasKey = typeof (credentials as any).private_key === "string" && String((credentials as any).private_key).trim();
    if (!hasEmail || !hasKey) {
      throw new Error(
        "Invalid GCP_SERVICE_ACCOUNT_JSON: missing client_email/private_key (check quoting/escaping in env var)"
      );
    }
  }

  if (!credentials) {
    const adc = readEnv("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALIALS");
    if (adc) assertServiceAccountJsonFileExists(adc, "GOOGLE_APPLICATION_CREDENTIALS");
  }

  if (!cachedVisionClient) {
    cachedVisionClient = credentials
      ? new vision.ImageAnnotatorClient({ credentials })
      : new vision.ImageAnnotatorClient();
  }
  const client = cachedVisionClient;

  const [result] = await client.textDetection({
    image: { content: imageBuffer },
  });

  const fullText = result.fullTextAnnotation?.text || "";
  const pages = result.fullTextAnnotation?.pages || [];
  const tokens: DocToken[] = [];

  // Convert Vision API blocks to tokens.
  // IMPORTANT: Vision returns pixel coordinates; the caller normalizes these.
  for (const page of pages) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = word.symbols?.map((s: any) => s.text).join("") || "";
          if (!text.trim()) continue;

          const vertices = word.boundingBox?.vertices || [];
          if (vertices.length < 4) continue;

          const minX = Math.min(...vertices.map((v: any) => v.x || 0));
          const maxX = Math.max(...vertices.map((v: any) => v.x || 0));
          const minY = Math.min(...vertices.map((v: any) => v.y || 0));
          const maxY = Math.max(...vertices.map((v: any) => v.y || 0));

          // Get confidence from word property
          const confidence = typeof word.confidence === "number" ? word.confidence : 0.9;

          tokens.push({
            pageIndex,
            text,
            confidence,
            box: {
              minX,
              maxX,
              minY,
              maxY,
              midX: (minX + maxX) / 2,
              midY: (minY + maxY) / 2,
            },
          });
        }
      }
    }
  }

  // Calculate overall confidence
  const avgConfidence = tokens.length > 0 
    ? tokens.reduce((sum, t) => sum + (t.confidence || 0), 0) / tokens.length 
    : 0;

  return {
    text: fullText,
    tokens,
    confidence: avgConfidence,
  };
}

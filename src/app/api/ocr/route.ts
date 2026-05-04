import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { extractOwnerFromTokensRoi } from "@/lib/pds2025/tokenRoiExtract";
import { detectPdsTemplateVersionFromText } from "@/lib/pds/templateDetect";
import { extractOwnerByAnchors } from "@/lib/pds/anchorOwnerExtract";
import { extractOwnerFromTokensRoi2018 } from "@/lib/pds2018/tokenRoiExtract";
import { computeAgeAndGroupFromDobIso } from "@/lib/age";
import { performCloudVisionOcr } from "@/lib/ocr/cloudVision";
import { extractSexAtBirth } from "@/lib/pds/sexAtBirthExtract";
import { getDocumentAiTokens, remapTokensToLegalSpace, type DocToken } from "@/lib/pds/documentAiTokens";
import { createDocumentAiClient, getProcessorName } from "@/lib/gcp/documentAi";
import { buildSearchablePdfFromOriginalAndTokens } from "@/lib/pds/searchablePdf";
import { extractDobFromPersonalInfoRow } from "@/lib/pds/dobRowExtract";
import { parsePdsDobToIso, safeParseDateToIso, validateDobToIso, validatePersonName } from "@/lib/pds/validators";
import { revalidatePath } from "next/cache";
import { preprocessPdsPage } from "@/lib/pds/preprocessPdsPage";
import { applyGlobal, sanitizeBox, type MapJsonV2, type NormBox } from "@/lib/pds2025/mappingSchema";
import {
  cropPhotoFromNormalizedPng,
  cropPhotoFromFrameNormalizedPng,
  findPhotoFrameCandidatesByVision,
  roiCandidatesFromPhotoToken,
  roiFromPhotoToken,
  scorePhotoPageFromTextAndTokens,
  type PhotoExtractDebug,
} from "@/lib/pds/photoExtract";
import { uploadPhotoWithBucketFallback, PRIMARY_PHOTO_BUCKET, FALLBACK_PHOTO_BUCKET } from "@/lib/supabase/storageFallback";
import { PDFDocument } from "pdf-lib";
import { detectDocumentType, type DocumentType, getDocumentCategory } from "@/lib/document/detection";
import { extractAppointmentFields, parseAppointmentDate } from "@/lib/appointment/fieldExtract";
import { extractPdsOwnerFromTextFallback, detectPdsOwnerCandidateFromDocument } from "@/lib/ownerDetect/pdsOwner";
import { resolveOwnerEmployeeForOcrNameMatches } from "@/lib/owner/resolveOwnerLink";

export const runtime = "nodejs";
export const maxDuration = 300;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function buildMultipagePdfFromPngs(pngPages: Buffer[]) {
  const pdfDoc = await PDFDocument.create();
  for (const png of pngPages) {
    const img = await pdfDoc.embedPng(png);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

function normalizeNameForMatch(s: string) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenTextUpper(t: any) {
  return String(t?.text || "").trim().toUpperCase();
}

function tokenHeight(t: any) {
  const b = t?.box;
  return b ? Math.max(0, Number(b.maxY || 0) - Number(b.minY || 0)) : 0;
}

function pickBestPhotoLabelToken(tokens: any[]) {
  const candidates = (tokens || [])
    .filter((t) => tokenTextUpper(t) === "PHOTO")
    .filter((t) => (t?.box?.midX ?? 0) > 0.55)
    .filter((t) => (t?.box?.midY ?? 0) > 0.45)
    .filter((t) => tokenHeight(t) >= 0.006);

  candidates.sort((a, b) => {
    const ax = Number(a?.box?.midX || 0);
    const bx = Number(b?.box?.midX || 0);
    if (bx !== ax) return bx - ax;
    const ay = Number(a?.box?.midY || 0);
    const by = Number(b?.box?.midY || 0);
    return by - ay;
  });
  return candidates[0] || null;
}

function looksLikePlaceholderName(s: string) {
  const u = String(s || "").toUpperCase().trim();
  if (!u) return true;
  if (["N/A", "NA", "NONE", "NULL", "UNKNOWN", "NOT AVAILABLE"].includes(u)) return true;
  // Common OCR junk that becomes employee records.
  if (/\b(YYYY|MM|DD)\b/.test(u)) return true;
  if (/\bMM\s*DD\s*YYYY\b/.test(u)) return true;
  if (/\b\d{4}\b/.test(u) && /\b\d{1,2}\b/.test(u)) return true;
  return false;
}

function formatValidation(which: string, res: { ok: boolean; reasons: string[] }) {
  if (res.ok) return null;
  return `${which}:${res.reasons.join(",")}`;
}

function isSupportedMimeType(mimeType: string) {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/ocr" });
}

export async function POST(request: Request) {
  try {
    const workerSecret = String(process.env.OCR_WORKER_SECRET || "").trim();
    const reqSecret = String(request.headers.get("x-ocr-worker-secret") || "").trim();
    const isWorker = Boolean(workerSecret) && reqSecret === workerSecret;

    const supabase: any = isWorker ? createSupabaseAdminClient() : await createSupabaseServerClient();

    let updatedById: string | null = null;

    if (!isWorker) {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const user = session?.user;
      if (!user) {
        return new NextResponse("Unauthorized", { status: 401 });
      }

      updatedById = String(user.id);
    }

  // buildMultipagePdfFromImages was removed because Tesseract processes pages individually.

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Invalid JSON body", { status: 400 });
  }

  const extractionId = String(body.extraction_id || "");
  if (!extractionId) {
    return new NextResponse("Missing extraction_id", { status: 400 });
  }

  const { data: extraction, error: exErr } = await supabase
    .from("extractions")
    .select("id, document_id, batch_id, page_index, document_set_id, doc_type_user_selected")
    .eq("id", extractionId)
    .single();

  if (exErr || !extraction?.document_id) {
    return new NextResponse(exErr?.message || "Extraction not found", { status: 404 });
  }

  async function downloadDocBytes(docRow: any) {
    const { data: downloaded, error: downloadErr } = await supabase.storage
      .from(String(docRow.storage_bucket))
      .download(String(docRow.storage_path));

    if (downloadErr || !downloaded) {
      throw new Error(downloadErr?.message || "Failed to download file from storage");
    }
    return Buffer.from(await downloaded.arrayBuffer());
  }

  async function loadBatchDocuments(): Promise<
    Array<{
      document_id: string;
      batch_id: string | null;
      page_index: number | null;
      doc: any;
    }>
  > {
    const documentSetId = (extraction as any)?.document_set_id ? String((extraction as any).document_set_id) : null;
    if (documentSetId) {
      const { data: docs, error: docsErr } = await supabase
        .from("employee_documents")
        .select("id, storage_bucket, storage_path, mime_type, original_filename, batch_id, page_index, document_set_id")
        .eq("document_set_id", documentSetId)
        .order("page_index", { ascending: true })
        .order("created_at", { ascending: true });
      if (docsErr) throw new Error(docsErr.message);
      return (docs || []).map((d: any) => ({
        document_id: String(d.id),
        batch_id: d.batch_id ? String(d.batch_id) : null,
        page_index: typeof d.page_index === "number" ? Number(d.page_index) : null,
        doc: d,
      }));
    }

    const batchId = (extraction as any)?.batch_id ? String((extraction as any).batch_id) : null;
    if (!batchId) {
      if (!extraction?.document_id) throw new Error("Extraction missing document_id");
      const { data: doc, error: docErr } = await supabase
        .from("employee_documents")
        .select("id, storage_bucket, storage_path, mime_type, original_filename, batch_id, page_index, document_set_id")
        .eq("id", extraction.document_id)
        .single();
      if (docErr || !doc?.storage_bucket || !doc?.storage_path) throw new Error(docErr?.message || "Document not found");
      return [
        {
          document_id: String(doc.id),
          batch_id: doc.batch_id ? String(doc.batch_id) : null,
          page_index: typeof doc.page_index === "number" ? Number(doc.page_index) : null,
          doc,
        },
      ];
    }

    const { data: docs, error: docsErr } = await supabase
      .from("employee_documents")
      .select("id, storage_bucket, storage_path, mime_type, original_filename, batch_id, page_index, document_set_id")
      .eq("batch_id", batchId)
      .order("page_index", { ascending: true })
      .order("created_at", { ascending: true });
    if (docsErr) throw new Error(docsErr.message);

    return (docs || []).map((d: any) => ({
      document_id: String(d.id),
      batch_id: d.batch_id ? String(d.batch_id) : null,
      page_index: typeof d.page_index === "number" ? Number(d.page_index) : null,
      doc: d,
    }));
  }

  function scorePage1FromText(text: string) {
    const u = String(text || "").toUpperCase().replace(/\s+/g, "");
    let score = 0;
    
    // Use joined text (no spaces) to be resilient to OCR spacing errors
    if (u.includes("PERSONALDATASHEET")) score += 50;
    if (u.includes("CSFORM") && u.includes("212")) score += 60;
    if (u.includes("REVISED2017") || u.includes("REVISED2018") || u.includes("REVISED2025")) score += 30;
    if (u.includes("PERSONAL") && u.includes("INFORMATION")) score += 80;
    if (u.includes("SURNAME")) score += 35;
    if (u.includes("FIRSTNAME")) score += 20;
    if (u.includes("MIDDLENAME")) score += 20;
    if (u.includes("DATEOFBIRTH") || u.includes("BIRTHDATE")) score += 25;
    if (u.includes("SEXATBIRTH") || (u.includes("SEX") && u.includes("BIRTH"))) score += 15;
    
    // Add additional PDS-specific anchors for page 1
    if (u.includes("CIVILSTATUS")) score += 10;
    if (u.includes("CITIZENSHIP")) score += 10;
    if (u.includes("RESIDENCETAX")) score += 10;
    
    return score;
  }

  const batchDocs = await loadBatchDocuments();
  if (batchDocs.length === 0) return new NextResponse("No documents found", { status: 404 });

  let fullTextAll = "";
  let tokensAll: DocToken[] = [];
  let searchablePdf: any = null;
  let searchablePdfWarning: string | null = null;
  const pageCount = batchDocs.length;

  let clientTokensToNormalize: any[] = [];
  // VERCEL TIMEOUT BYPASS: If client sent tokens, apply them
  const hasClientTokens = body.tokens && body.full_text;
  if (hasClientTokens) {
    const needsNormalization = body.tokens.some((t: any) => t.box.maxX > 2 || t.box.maxY > 2);
    if (!needsNormalization) {
      tokensAll = body.tokens;
    } else {
      clientTokensToNormalize = body.tokens;
    }
    fullTextAll = body.full_text;
  }

  // Setup Tesseract loop later

  const pages: Array<{
    document_id: string;
    batch_id: string | null;
    page_index: number | null;
    originalBytes: Buffer;
    originalMimeType: string;
    processedPng: Buffer;
    preprocessDebug: any;
    filename: string | null;
  }> = [];

  // PERF: Processing all pages can take a very long time and cause timeouts.
  // For PDS / auto-detect, scan up to 4 batch pages — page 1 (personal info) may not be file index 0.
  const userSelectedTypeForOcrPaging = (extraction as any)?.doc_type_user_selected;
  let maxOcrPages = Math.min(4, Math.max(1, batchDocs.length));
  if (userSelectedTypeForOcrPaging === "appointment") {
    maxOcrPages = Math.min(3, Math.max(1, batchDocs.length));
  } else if (userSelectedTypeForOcrPaging === "pds") {
    maxOcrPages = Math.min(4, Math.max(1, batchDocs.length));
  }
  
  for (const row of batchDocs.slice(0, maxOcrPages)) {
    const doc = row.doc;
    if (!doc?.storage_bucket || !doc?.storage_path) continue;
    const mimeType = String(doc.mime_type || "application/octet-stream");
    if (!isSupportedMimeType(mimeType)) continue;
    const originalBytes = await downloadDocBytes(doc);
    const processed = await preprocessPdsPage({ bytes: originalBytes, mimeType, pageIndex: 0, dpi: 300 });
    pages.push({
      document_id: String(row.document_id),
      batch_id: row.batch_id,
      page_index: row.page_index,
      originalBytes,
      originalMimeType: mimeType,
      processedPng: processed.buffer,
      preprocessDebug: processed.debug,
      filename: doc.original_filename ? String(doc.original_filename) : null,
    });
  }

  if (pages.length === 0) return new NextResponse("No supported documents to OCR", { status: 400 });

  const sortedPages = pages
    .slice()
    .sort((a, b) => (Number(a.page_index ?? 1e9) - Number(b.page_index ?? 1e9)) || String(a.document_id).localeCompare(String(b.document_id)));

  const pdfBuild = { pageIndexesUsed: sortedPages.map(p => p.page_index ?? 0) };

  if (!hasClientTokens || clientTokensToNormalize.length > 0) {
    let didDocAi = false;
    let docAiErrMsg = "";
    let retryCount = 0;
    const maxRetries = 2;
    
    while (!didDocAi && retryCount <= maxRetries) {
      try {
        const client = createDocumentAiClient();
        const name = getProcessorName();
        const pdfBytes = await buildMultipagePdfFromPngs(sortedPages.map((p) => p.processedPng));
        const DOC_AI_TIMEOUT = 300000; // 5 minutes
        
        console.log(`[OCR] Document AI attempt ${retryCount + 1}/${maxRetries + 1}`);
        
        const processedDoc = await (client as any).processDocument(
          {
            name,
            rawDocument: {
              content: pdfBytes,
              mimeType: "application/pdf",
            },
          },
          { timeout: DOC_AI_TIMEOUT }
        );

        const doc = (processedDoc as any)?.document || (Array.isArray(processedDoc) ? (processedDoc as any)[0]?.document : null);
        if (doc) {
          fullTextAll = String(doc.text || "");
          tokensAll = getDocumentAiTokens(doc);
          didDocAi = true;
          console.log("[OCR] Document AI SUCCESS!");
        }
      } catch (e) {
        docAiErrMsg = e instanceof Error ? e.message : String(e);
        console.error(`[OCR] Document AI FAILED (attempt ${retryCount + 1}):`, docAiErrMsg);
        
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s
          console.log(`[OCR] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        retryCount++;
      }
    }

    if (didDocAi) {
      // no-op, we already populated fullTextAll + tokensAll
    } else {
    const allowFallbackOcr = String(process.env.ALLOW_FALLBACK_OCR || "1").trim() === "1" || String(process.env.ALLOW_FALLBACK_OCR || "").toLowerCase() === "true";
    if (!allowFallbackOcr && !hasClientTokens) {
      return new NextResponse(
        JSON.stringify({
          error: "OCR engine unavailable",
          details: `Google Document AI failed and server fallback OCR is disabled.${docAiErrMsg ? ` Document AI error: ${docAiErrMsg}` : ""}`,
          suggestion:
            "Fix Google Document AI (billing/API/service account env vars) or set ALLOW_FALLBACK_OCR=1 to enable slower fallback OCR.",
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    let sharpMod: any;
    try {
      sharpMod = (await import("sharp")).default;
    } catch {
      throw new Error("sharp not installed");
    }

    for (let i = 0; i < sortedPages.length; i++) {
      const page = sortedPages[i];
      try {
        const imgMetadata = await sharpMod(page.processedPng).metadata();
        const resWidth = imgMetadata.width || 800;
        const resHeight = imgMetadata.height || 800;

        const isTargetPageForClient = hasClientTokens && String(page.document_id) === String(extraction.document_id);

        if (isTargetPageForClient) {
          // Normalize and Remap client-provided tokens to Legal space
          // We apply .rotate() because browser OCR (tesseract) usually runs on the auto-oriented visible image.
          const baseImg = sharpMod(page.originalBytes).rotate();
          const origMetadata = await baseImg.metadata();
          const origW = origMetadata.width || resWidth;
          const origH = origMetadata.height || resHeight;
          const cropBox = page.preprocessDebug?.cropBox || { left: 0, top: 0, width: origW, height: origH };

          const rawTokens = body.tokens as DocToken[];
          const remapped = remapTokensToLegalSpace(rawTokens, origW, origH, cropBox);
          
          for (const t of remapped) {
            tokensAll.push({
              ...t,
              pageIndex: i, // Assign to correct index in the batch
            });
          }
          fullTextAll += (body.full_text || "") + "\n\n";
          console.log(`[OCR] Used remapped client tokens for page ${i} (${page.document_id})`);
        } else {
          // Server-side OCR (fallback engine) for this page
          const resizedImageMod = sharpMod(page.processedPng)
            .resize({ width: 1800, withoutEnlargement: true });
          
          const resizedMetadata = await resizedImageMod.metadata();
          const rWidth = resizedMetadata.width || 1800;
          const rHeight = resizedMetadata.height || 1800;
          
          const resizedImageBuffer = await resizedImageMod.toBuffer();
          // Use Google Cloud Vision API instead of Tesseract (which doesn't work on Vercel)
          const ocrResult = await withTimeout(performCloudVisionOcr(resizedImageBuffer, i), 45_000, `vision_ocr_page_${i}`);
          
          fullTextAll += ocrResult.text + "\n\n";
          
          for (const t of ocrResult.tokens) {
            tokensAll.push({
              pageIndex: i,
              text: t.text,
              confidence: t.confidence,
              box: {
                minX: t.box.minX / rWidth,
                maxX: t.box.maxX / rWidth,
                minY: t.box.minY / rHeight,
                maxY: t.box.maxY / rHeight,
                midX: t.box.midX / rWidth,
                midY: t.box.midY / rHeight,
              }
            });
          }
        }
      } catch (err: any) {
        console.error("[OCR] OCR normalization/fallback failed for page", i, ":", err);
        await supabase
          .from("extractions")
          .update({
            status: "error",
            errors: { ocr: `OCR failed: ${err.message}. Please try again.` },
            updated_by: updatedById,
          } as any)
          .eq("id", extractionId);
        
        return new NextResponse(
          JSON.stringify({
            error: "OCR failed",
            details: err.message,
            suggestion: "Fallback OCR failed. Fix Google Document AI for best results, or retry with fewer pages.",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    }
  }

  // BUILD SEARCHABLE PDF (Common for both paths if possible)
  try {
    const firstRow = batchDocs[0];
    const firstDoc = firstRow.doc;
    const originalBytes = await downloadDocBytes(firstDoc);

    const searchableResult = await buildSearchablePdfFromOriginalAndTokens({
      originalBytes,
      originalMimeType: String(firstDoc.mime_type || "image/png"),
      tokens: tokensAll,
    });

    const fileName = `searchable_${extractionId}.pdf`;
    const storagePath = `ocr_pdfs/${extractionId}/${fileName}`;
    const { error: uploadErr } = await supabase.storage
      .from("ocr_results")
      .upload(storagePath, searchableResult.bytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (!uploadErr) {
      searchablePdf = {
        storage_bucket: "ocr_results",
        storage_path: storagePath,
        filename: fileName,
      };
    }
  } catch (err) {
    console.warn("[OCR] Searchable PDF generation failed:", err);
    searchablePdfWarning = err instanceof Error ? err.message : "PDF build failed";
  }

  // Tesseract does not return a heavily structured `document` object like Google Document AI,
  // but we can mock enough of it for downstream extractors that still rely on `document.text`.
  const document = {
    text: fullTextAll,
    pages: sortedPages.map(() => ({ tokens: [] })) // Dummy structure for legacy code compatibility
  };

  function pageTextFromTokens(pageIndex: number) {
    const toks = tokensAll.filter((t) => Number(t.pageIndex) === pageIndex);
    return toks
      .map((t) => String((t as any).text || "").trim())
      .filter(Boolean)
      .join(" ");
  }

  const pageViews = sortedPages.map((p, i) => {
    const pageIndex = i;
    const pageText = pageTextFromTokens(pageIndex);
    const template = detectPdsTemplateVersionFromText(pageText);
    const page1Score = scorePage1FromText(pageText);
    return {
      pageIndex,
      pageText,
      tokens: tokensAll.filter((t) => Number(t.pageIndex) === pageIndex),
      template,
      page1Score,
      page: p,
    };
  });

  const page1 = pageViews.slice().sort((a, b) => b.page1Score - a.page1Score)[0];
  const chosenExtractionId = String(extractionId);
  const chosenPageIndex = page1?.page?.page_index ?? null;

  // Owner/DOB extraction helpers currently assume pageIndex=0 in the Document AI output.
  // Build a page-local "document" view for the chosen page by reindexing it to 0.
  const chosenPageDocAiIndex = Number(page1?.pageIndex ?? 0);
  const page1Doc: any = {
    ...(document || {}),
    pages: Array.isArray((document as any)?.pages)
      ? [((document as any).pages || [])[chosenPageDocAiIndex]].filter(Boolean)
      : [],
    // IMPORTANT: Keep the original full-text so textAnchor indices remain valid.
    // We only subset pages to make chosen page become pageIndex=0 for downstream extractors.
    text: fullTextAll,
    tokens: (page1?.tokens || []).map((t: any) => ({ ...t, pageIndex: 0 })),
  };

  const templateAcross = (() => {
    const nonUnknown = pageViews.find((r) => r.template.version !== "unknown");
    return nonUnknown?.template ?? (page1?.template ?? detectPdsTemplateVersionFromText(fullTextAll));
  })();

  async function loadMapBox(templateVersion: string, pageNumber: number, fieldId: string): Promise<NormBox | null> {
    try {
      const { data: rows } = await supabase
        .from("pds_template_maps")
        .select("map_json")
        .eq("template_version", templateVersion)
        .eq("page", pageNumber)
        .order("updated_at", { ascending: false })
        .limit(1);

      const mj = (rows || [])[0]?.map_json as any;
      if (!mj || typeof mj !== "object") return null;

      // v2 schema: fields[] + transform
      if (mj.schema_version === 2 && Array.isArray(mj.fields)) {
        const map = mj as MapJsonV2;
        const f = (map.fields || []).find((x: any) => x && typeof x === "object" && x.id === fieldId);
        const b = f?.box;
        if (!b || typeof b !== "object") return null;
        const raw: NormBox = {
          x: Number(b.x),
          y: Number(b.y),
          w: Number(b.w),
          h: Number(b.h),
        };
        if (![raw.x, raw.y, raw.w, raw.h].every((n) => Number.isFinite(n))) return null;
        return sanitizeBox(applyGlobal(raw, map.transform));
      }

      // Legacy map shape: map_json.fields.<fieldId> = NormBox (already global)
      const legacyBox = (mj?.fields && typeof mj.fields === "object" ? (mj.fields as any)[fieldId] : null) as any;
      if (legacyBox && typeof legacyBox === "object") {
        const raw: NormBox = {
          x: Number(legacyBox.x),
          y: Number(legacyBox.y),
          w: Number(legacyBox.w),
          h: Number(legacyBox.h),
        };
        if (![raw.x, raw.y, raw.w, raw.h].every((n) => Number.isFinite(n))) return null;
        return sanitizeBox(raw);
      }

      return null;
    } catch {
      return null;
    }
  }

  // STRICT DOCUMENT TYPE ROUTING
  // A) APPOINTMENT: Extract appointment fields ONLY, update masterlist job fields
  // B) PDS: Extract personal info ONLY (name, DOB, sex), NO job fields
  // C) ALL OTHER TYPES: Store file only, NO OCR extraction
  
  const userSelectedType = (extraction as any)?.doc_type_user_selected;
  const isAutoDetect = !userSelectedType || userSelectedType === "auto-detect";
  
  let docTypeResult = detectDocumentType(fullTextAll);
  let docTypeDetected = docTypeResult.type;
  let docTypeFinal: DocumentType | string = docTypeDetected;
  let docTypeMismatchWarning = false;
  let mismatchDetails: any = null;
  
  if (!isAutoDetect) {
    // User selected a specific type - use it
    docTypeFinal = userSelectedType;
    
    // Run sanity check: detect actual type and compare
    if (docTypeDetected !== userSelectedType && docTypeResult.confidence > 0.7) {
      docTypeMismatchWarning = true;
      mismatchDetails = {
        userSelected: userSelectedType,
        detected: docTypeDetected,
        confidence: docTypeResult.confidence,
        evidence: docTypeResult.evidence,
      };
    }
  }
  
  // Validate that final type is one we handle, otherwise treat as "other"
  const supportedTypes: DocumentType[] = ["pds", "appointment", "oath", "assumption", "certification_lgu", "nosa", "nosi", "ipcr", "service_record", "training", "eligibility", "other"];
  if (!supportedTypes.includes(docTypeFinal as DocumentType)) {
    docTypeFinal = "other";
  }

  // === TYPE A: APPOINTMENT - Full appointment extraction + masterlist update ===
  let appointmentData: any = null;
  let appointmentDebug: any = null;
  let ownerCandidate: any = null;
  let ownerEmployeeId: string | null = null;
  let ownerLinkWarning: string | null = null;
  let photoDebug: any = { warnings: [] };
  
  // Variables for extraction debug (initialized for all types)
  let anchor: any = null;
  let roi: any = null;
  let sex: any = { value: null, debug: { method: null, male: null, female: null, densities: null, imageRois: null, reasons: [] } };
  let dobRow: any = { iso: null, debug: { rawDateMatch: null, usedRule: null, reasonsIfNull: [] } };

  if (docTypeFinal === "appointment") {
    const appointmentPage = pageViews[0];
    const appointmentDoc: any = {
      ...(document || {}),
      pages: Array.isArray((document as any)?.pages)
        ? [((document as any).pages || [])[0]].filter(Boolean)
        : [],
      text: fullTextAll,
      tokens: appointmentPage?.tokens || [],
    };

    const evidenceDatesRaw: string[] = [];
    for (const p of pageViews) {
      const t = String((p as any).pageText || "");
      if (!t) continue;
      const matches = t.match(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/g) || [];
      for (const m of matches) {
        if (evidenceDatesRaw.length >= 30) break;
        evidenceDatesRaw.push(m);
      }
      if (evidenceDatesRaw.length >= 30) break;
    }

    const appointmentResult = extractAppointmentFields(appointmentDoc, {
      pageIndex: appointmentPage?.page?.page_index ?? 0,
      evidenceDates: evidenceDatesRaw,
    });

    appointmentData = {
      owner: appointmentResult.owner,
      position_title: appointmentResult.position_title,
      office_department: appointmentResult.office_department,
      sg: appointmentResult.sg,
      step: appointmentResult.step,
      monthly_salary: appointmentResult.monthly_salary,
      annual_salary: appointmentResult.annual_salary,
      appointment_date: appointmentResult.appointment_date,
      date_received: appointmentResult.date_received,
      nature_of_appointment: appointmentResult.nature_of_appointment,
      status: appointmentResult.status,
      sg_from_salary: appointmentResult.sg_from_salary,
    };
    appointmentDebug = appointmentResult.debug;

    // Use appointment-extracted owner
    if (appointmentData?.owner) {
      ownerCandidate = {
        last_name: appointmentData.owner.last_name,
        first_name: appointmentData.owner.first_name,
        middle_name: appointmentData.owner.middle_name,
        confidence: 0.9,
      };
    }

    // Link employee and update masterlist appointment fields
    if (ownerCandidate) {
      const last = String(ownerCandidate.last_name || "").trim();
      const first = String(ownerCandidate.first_name || "").trim();
      
      if (last && first) {
        const normKey = normalizeNameForMatch(`${last} ${first} ${ownerCandidate.middle_name || ""}`);
        
        const { data: candidates } = await supabase
          .from("employees")
          .select("id, last_name, first_name, middle_name, date_of_birth, gender, age, age_group, position_title, sg, office_department, monthly_salary, annual_salary, date_hired")
          .ilike("last_name", last)
          .ilike("first_name", first)
          .limit(25);

        const nameKeyMatches = (candidates || []).filter((c: any) => {
          const cKey = normalizeNameForMatch(`${c.last_name || ""} ${c.first_name || ""} ${c.middle_name || ""}`);
          return cKey === normKey;
        });

        const appointmentResolve = resolveOwnerEmployeeForOcrNameMatches(nameKeyMatches, null);
        if (appointmentResolve.warning) ownerLinkWarning = appointmentResolve.warning;

        if (appointmentResolve.id) {
          ownerEmployeeId = String(appointmentResolve.id);

          // Update masterlist with appointment fields (ONLY appointment updates these) — one unambiguous person only
          const patch: any = {};
          if (appointmentData.position_title) patch.position_title = appointmentData.position_title;
          if (appointmentData.office_department) patch.office_department = appointmentData.office_department;
          if (appointmentData.sg) patch.sg = appointmentData.sg;
          if (appointmentData.step) patch.step = appointmentData.step;
          if (appointmentData.monthly_salary) patch.monthly_salary = appointmentData.monthly_salary;
          if (appointmentData.annual_salary) patch.annual_salary = appointmentData.annual_salary;

          if (appointmentData.appointment_date) {
            patch.date_hired = appointmentData.appointment_date;
            const hireDate = new Date(appointmentData.appointment_date);
            const now = new Date();
            const diffMs = now.getTime() - hireDate.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            patch.tenure_years = Math.floor(diffDays / 365);
            patch.tenure_months = Math.floor((diffDays % 365) / 30);
          }

          if (Object.keys(patch).length > 0) {
            if (updatedById) patch.updated_by = updatedById;
            await supabase.from("employees").update(patch).eq("id", ownerEmployeeId);
          }
        }
      }
    }
  }

  // === TYPE B: PDS - Personal info extraction ONLY (no job fields) ===
  if (docTypeFinal === "pds") {
    const page1TemplateVersion = templateAcross.version;
    console.log("[DEBUG PDS] Starting PDS extraction, template version:", page1TemplateVersion);
    
    anchor = extractOwnerByAnchors(page1Doc, { templateVersion: page1TemplateVersion });
    console.log("[DEBUG PDS] Anchor extraction result:", {
      hasOwner: !!anchor.owner,
      owner: anchor.owner,
      debug: anchor.debug,
    });
    
    roi = (() => {
      if (page1TemplateVersion === "2018") return extractOwnerFromTokensRoi2018(page1Doc);
      if (page1TemplateVersion === "2025") return extractOwnerFromTokensRoi(page1Doc);
      // Unknown template: try 2025 ROI first, fall back to 2018 ROI.
      const r2025 = extractOwnerFromTokensRoi(page1Doc);
      if (r2025.owner) return r2025;
      return extractOwnerFromTokensRoi2018(page1Doc);
    })();
    
    console.log("[DEBUG PDS] ROI extraction result:", {
      hasOwner: !!(roi as any).owner,
      owner: (roi as any).owner,
    });

    // ROI extractor uses calibrated fixed template coordinates — prefer it over anchor.
    ownerCandidate = (roi as any).owner ?? anchor.owner ?? null;
    console.log("[DEBUG PDS] Combined owner candidate:", ownerCandidate);
    
    // FALLBACK: Use spatial extractor (token positions) — more reliable than text-only regex.
    if (!ownerCandidate) {
      console.log("[DEBUG PDS] ROI failed, trying spatial token extractor...");
      const spatial = detectPdsOwnerCandidateFromDocument(page1Doc);
      console.log("[DEBUG PDS] Spatial result:", spatial);
      if (spatial?.last_name && spatial?.first_name) {
        ownerCandidate = spatial as any;
      } else {
        // Last resort: text regex (works only when OCR preserves line breaks).
        const textFallback = extractPdsOwnerFromTextFallback(fullTextAll);
        console.log("[DEBUG PDS] Text fallback result:", textFallback);
        if (textFallback) ownerCandidate = textFallback as any;
      }
    }

    dobRow = extractDobFromPersonalInfoRow(page1Doc, { templateVersion: page1TemplateVersion });
    console.log("[DEBUG PDS] DOB extraction result:", dobRow);
    
    if (dobRow.iso && ownerCandidate) {
      ownerCandidate = {
        ...ownerCandidate,
        date_of_birth: dobRow.iso,
        confidence: Math.max((ownerCandidate as any).confidence ?? 0, 0.99),
      };
    }

    sex = await extractSexAtBirth(page1Doc, {
      templateVersion: page1TemplateVersion,
      originalMimeType: "image/png",
      originalBytes: page1?.page?.processedPng,
    });
    console.log("[DEBUG PDS] Sex extraction result:", sex);

    if (ownerCandidate && sex.value && !(ownerCandidate as any).gender) {
      (ownerCandidate as any).gender = sex.value;
    }

    // Strict validation is for text fallbacks; spatial (anchor/ROI) names often trip label-token
    // heuristics even when the values are correct — keep those unless obviously empty/junk.
    if (ownerCandidate) {
      const spatialSource = Boolean(anchor?.owner || (roi as any)?.owner);
      const rawLast = String((ownerCandidate as any).last_name || "").trim();
      const rawFirst = String((ownerCandidate as any).first_name || "").trim();
      const vLast = validatePersonName(rawLast, "last");
      const vFirst = validatePersonName(rawFirst, "first");

      if (vLast.ok && vFirst.ok) {
        ownerCandidate = {
          ...ownerCandidate,
          last_name: vLast.value,
          first_name: vFirst.value,
        };
      } else if (
        spatialSource &&
        rawLast.length >= 2 &&
        rawFirst.length >= 2 &&
        /[A-Za-zÀ-ÿ]/.test(rawLast) &&
        /[A-Za-zÀ-ÿ]/.test(rawFirst) &&
        !looksLikePlaceholderName(rawLast) &&
        !looksLikePlaceholderName(rawFirst)
      ) {
        console.log("[DEBUG PDS] Keeping spatial owner despite validatePersonName:", {
          vLast: vLast.reasons,
          vFirst: vFirst.reasons,
        });
      } else {
        const conf = Number((ownerCandidate as any).confidence ?? 0);
        const isFallback = conf > 0 && conf < 0.8;
        if (!(isFallback && rawLast && rawFirst)) {
          console.log("[DEBUG PDS] Validation failed - clearing owner candidate", { vLast, vFirst, spatialSource });
          ownerCandidate = null;
        }
      }
    }

    // NOTE: Anchor last-resort removed — anchor reads entire header row as extractedRaw
    // which produces junk like "SURNAME FIRST NAME ABABAN ADONIS NAME EXTENSION JR SR".
    // Text fallback above is the correct last resort.

    // Link employee but DO NOT update job fields (position, office, sg, salary, tenure)
    if (ownerCandidate) {
      const last = String((ownerCandidate as any).last_name || "").trim();
      const first = String((ownerCandidate as any).first_name || "").trim();
      const dobIso = String((ownerCandidate as any).date_of_birth || "").trim();

      if (last && first) {
        const normKey = normalizeNameForMatch(`${last} ${first} ${(ownerCandidate as any).middle_name || ""}`);
        
        const { data: candidates } = await supabase
          .from("employees")
          .select("id, last_name, first_name, middle_name, date_of_birth, gender, age, age_group")
          .ilike("last_name", last)
          .ilike("first_name", first)
          .limit(25);

        const nameKeyMatches = (candidates || []).filter((c: any) => {
          const cKey = normalizeNameForMatch(`${c.last_name || ""} ${c.first_name || ""} ${c.middle_name || ""}`);
          return cKey === normKey;
        });

        const pdsResolve = resolveOwnerEmployeeForOcrNameMatches(
          nameKeyMatches,
          dobIso ? String(dobIso).trim() || null : null
        );
        if (pdsResolve.warning) ownerLinkWarning = pdsResolve.warning;

        if (pdsResolve.id) {
          ownerEmployeeId = String(pdsResolve.id);
          const row = nameKeyMatches.find((c: any) => String(c.id) === ownerEmployeeId);
          // PDS ONLY updates personal fields - NEVER job fields; only for the resolved single person
          const patch: any = {};
          const detectedGender = (ownerCandidate as any).gender ?? null;
          const computedAge = dobIso ? computeAgeAndGroupFromDobIso(dobIso) : { age: null, age_group: null };

          if (dobIso && row && !row.date_of_birth) patch.date_of_birth = dobIso;
          if (detectedGender && row && !row.gender) patch.gender = detectedGender;
          if (computedAge.age !== null && row && !row.age) {
            patch.age = computedAge.age;
            patch.age_group = computedAge.age_group;
          }

          if (Object.keys(patch).length > 0) {
            if (updatedById) patch.updated_by = updatedById;
            await supabase.from("employees").update(patch).eq("id", ownerEmployeeId);
          }
        }
      }
    }
  }

  // === TYPE C: ALL OTHER TYPES - Store only, skip extraction ===
  // No owner extraction, no field extraction - just file storage
  // employee_id must be set manually or via previous linking

  // Link document to employee_id if found
  if (ownerEmployeeId && page1?.page?.document_id) {
    await supabase.from("employee_documents").update({ employee_id: ownerEmployeeId }).eq("id", page1.page.document_id);
    await supabase.from("extractions").update({ linked_employee_id: ownerEmployeeId } as any).eq("id", chosenExtractionId);
  }

  // Photo extraction after ownerEmployeeId is computed (best-effort)
  try {
    const photoScores = pageViews.map((r) => {
      const s = scorePhotoPageFromTextAndTokens({ fullText: r.pageText, tokens: r.tokens as any });
      const pageIdx = typeof r.page.page_index === "number" ? Number(r.page.page_index) : null;

      const txt = String(r.pageText || "").toUpperCase();
      const hasPhoto = txt.includes("PHOTO");
      const hasThumb = txt.includes("RIGHT THUM") || txt.includes("RIGHT  THUM") || txt.includes("THUMBMARK");
      const hasSworn = txt.includes("SUBSCRIB") || txt.includes("SWORN") || txt.includes("OATH");
      const hasAdmin = txt.includes("ADMINISTER");
      const hasAnyAnchor = hasPhoto || hasThumb || hasSworn || hasAdmin;

      return {
        r,
        score: s.score,
        reasons: s.reasons,
        photoTokenCandidates: s.photoTokenCandidates,
        pageIdx,
        hasBoth: hasPhoto && hasThumb,
        hasAnyAnchor,
      };
    });

    for (const ps of photoScores) {
      photoDebug.pageScores?.push({ pageIndex: ps.pageIdx, score: ps.score, reasons: ps.reasons });
    }

    // Evaluate all eligible pages; choose best candidate across all pages.
    const eligible = photoScores.filter((p) => p.hasAnyAnchor);
    const eligibleSorted = eligible
      .slice()
      .sort((a, b) => (b.hasBoth ? 1 : 0) - (a.hasBoth ? 1 : 0) || b.score - a.score);

    type PageAttempt = {
      pageIdx: number | null;
      pageIndexDocAi: number;
      hasBoth: boolean;
      score: number;
      method: any;
      tierUsed: any;
      roi: NormBox | null;
      candidates: any[];
      cropped: any | null;
      croppedMethod: any;
      photoLabelBox: NormBox | null;
      thumbLabelBox: NormBox | null;
    };

    let bestAttempt: PageAttempt | null = null;

    for (const ps of eligibleSorted) {
      const docAiPageIndex = Number(ps.r.pageIndex);
      const processedPng = sortedPages[docAiPageIndex]?.processedPng;
      if (!processedPng) continue;

      const bestPageIdx = ps.pageIdx;
      const pageNumberForMap = bestPageIdx !== null ? bestPageIdx + 1 : 1;
      const templateVersionForMap = String((templateAcross as any)?.version ?? "unknown");

      let roiBox: NormBox | null = null;
      let photoLabelBox: NormBox | null = null;
      let thumbLabelBox: NormBox | null = null;
      const tierAFailedReasons: string[] = [];
      const tierBFailedReasons: string[] = [];
      let tierUsed: any = null;
      let method: any = null;

      const mapBox =
        templateVersionForMap !== "unknown"
          ? (await loadMapBox(templateVersionForMap, pageNumberForMap, "owner_photo_box")) ||
            (await loadMapBox(templateVersionForMap, pageNumberForMap, "owner_photo"))
          : null;

      if (mapBox) {
        roiBox = mapBox;
        method = "map";
        tierUsed = "A";
      } else {
        const bestPhotoTok = pickBestPhotoLabelToken(ps.r.tokens as any);
        if (bestPhotoTok) {
          roiBox = roiFromPhotoToken(bestPhotoTok as any);
          method = "anchor";
          tierUsed = "A";
          photoLabelBox = {
            x: (bestPhotoTok as any).box.minX,
            y: (bestPhotoTok as any).box.minY,
            w: (bestPhotoTok as any).box.maxX - (bestPhotoTok as any).box.minX,
            h: (bestPhotoTok as any).box.maxY - (bestPhotoTok as any).box.minY,
          };

          const toks = (ps.r.tokens as any[]) || [];
          const thumbs = toks.filter((t) => tokenTextUpper(t).includes("THUMB"));
          thumbs.sort((a, b) => Number(b?.box?.midX || 0) - Number(a?.box?.midX || 0));
          const tm = thumbs[0] || null;
          if (tm) {
            thumbLabelBox = {
              x: (tm as any).box.minX,
              y: (tm as any).box.minY,
              w: (tm as any).box.maxX - (tm as any).box.minX,
              h: (tm as any).box.maxY - (tm as any).box.minY,
            };
          }
        }
      }

      if (roiBox && tierUsed === "A") {
        const ar = roiBox.w / Math.max(1e-6, roiBox.h);
        if (ar < 0.6 || ar > 1.2) tierAFailedReasons.push(`roi_bad_aspect:${ar.toFixed(2)}`);
        if (roiBox.w < 0.10 || roiBox.h < 0.10) tierAFailedReasons.push("roi_too_small");
        if (tierAFailedReasons.length > 0) {
          roiBox = null;
          method = null;
          tierUsed = null;
        }
      }

      // Search the full page — photo can be upper-left or lower-right depending on PDS version.
      const coarseWindow: NormBox = { x: 0.00, y: 0.00, w: 1.00, h: 1.00 };
      let visionCandidates: Array<{ roi: NormBox; score: number; reasons: string[] }> = [];
      try {
        visionCandidates = await findPhotoFrameCandidatesByVision({
          png: processedPng,
          coarseWindow,
          photoLabelBox,
          thumbmarkLabelBox: thumbLabelBox,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        tierBFailedReasons.push(`vision_failed:${msg}`);
      }

      const candidateList: Array<{ roi: NormBox; baseScore: number; baseReasons: string[]; method: any }> = [];
      if (roiBox) candidateList.push({ roi: roiBox, baseScore: 1.0, baseReasons: ["tierA_roi"], method: method || "anchor" });
      for (const v of visionCandidates) candidateList.push({ roi: v.roi, baseScore: v.score, baseReasons: v.reasons, method: "vision" });
      if (candidateList.length === 0) continue;

      const candDbg: any[] = [];
      let chosenLocal: any = null;
      let chosenCropped: any = null;
      let chosenMethod: any = null;
      for (const c of candidateList.slice(0, 10)) {
        const cropped =
          c.method === "vision"
            ? await cropPhotoFromFrameNormalizedPng({ png: processedPng, frameRoi: c.roi, insetFrac: 0.04 })
            : await cropPhotoFromNormalizedPng({ png: processedPng, roi: c.roi });

        const mean = Number((cropped as any).debug?.avgMean ?? 0);
        const stdev = Number((cropped as any).debug?.avgStdev ?? 0);
        const contrastScore = Math.max(0, Math.min(1, stdev / 40));
        const faceScore = (cropped as any).debug?.faceLike ? 1 : 0;
        const frameScore = c.method === "vision" ? Math.max(0, Math.min(1, c.baseScore / 5)) : 0.25;
        const total = c.baseScore + contrastScore * 1.2 + faceScore * 2.0;

        candDbg.push({
          roi: c.roi,
          score: total,
          frameScore,
          contrastScore,
          faceScore,
          reasons: [...c.baseReasons, `mean:${mean.toFixed(0)}`, `stdev:${stdev.toFixed(1)}`],
          faceDetected: Boolean((cropped as any).debug?.faceLike),
        });

        if (!chosenLocal || total > Number(chosenLocal.score || -1) || (cropped as any).debug?.faceLike) {
          chosenLocal = { roi: c.roi, score: total };
          chosenCropped = cropped;
          chosenMethod = c.method;
          if ((cropped as any).debug?.faceLike) break;
        }
      }

      candDbg.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      const topScore = Number(candDbg[0]?.score || 0);

      const attempt: PageAttempt = {
        pageIdx: bestPageIdx,
        pageIndexDocAi: docAiPageIndex,
        hasBoth: Boolean(ps.hasBoth),
        score: topScore,
        method: chosenMethod === "vision" ? "vision" : (method || "anchor"),
        tierUsed: chosenMethod === "vision" ? "B" : (tierUsed || null),
        roi: chosenLocal?.roi ?? null,
        candidates: candDbg,
        cropped: chosenCropped,
        croppedMethod: chosenMethod,
        photoLabelBox,
        thumbLabelBox,
      };

      if (!bestAttempt) bestAttempt = attempt;
      else {
        const bestHasBoth = bestAttempt.hasBoth ? 1 : 0;
        const curHasBoth = attempt.hasBoth ? 1 : 0;
        if (curHasBoth > bestHasBoth || (curHasBoth === bestHasBoth && attempt.score > bestAttempt.score)) bestAttempt = attempt;
      }
    }

    if (!bestAttempt) {
      photoDebug.warnings.push("photo_page_not_confident");
    } else {
      photoDebug.pageIndex = bestAttempt.pageIdx;
      photoDebug.method = bestAttempt.method;
      photoDebug.tierUsed = bestAttempt.tierUsed;
      photoDebug.roi = bestAttempt.roi ? bestAttempt.roi : null;
      photoDebug.candidates = bestAttempt.candidates;
      photoDebug.photoLabelBox = bestAttempt.photoLabelBox;
      photoDebug.thumbmarkLabelBox = bestAttempt.thumbLabelBox;
      photoDebug.coarseWindow = { x: 0.00, y: 0.00, w: 1.00, h: 1.00 };
      photoDebug.faceDetected = Boolean((bestAttempt.cropped as any)?.debug?.faceLike);
      photoDebug.trim = (bestAttempt.cropped as any)?.debug?.trim ?? null;
      if (bestAttempt.roi) {
        photoDebug.chosen = { roi: bestAttempt.roi, method: photoDebug.method as any, faceDetected: photoDebug.faceDetected };
      }

      const allowNoFace = bestAttempt.croppedMethod === "vision" && (bestAttempt.candidates?.[0]?.contrastScore ?? 0) >= 0.25; // Lowered threshold from 0.35
      const pass = Boolean((bestAttempt.cropped as any)?.debug?.faceLike) || allowNoFace;
      if (!pass) {
        photoDebug.warnings.push("no_face_and_no_strong_frame");
      } else {
        const outPath = `extractions/${chosenExtractionId}/pds_photo_${Date.now()}.jpg`;
        let uploadInfo: { bucketUsed: string; path: string; usedFallback: boolean; reason: string | null } | null = null;
        try {
          uploadInfo = await uploadPhotoWithBucketFallback({
            supabase,
            path: outPath,
            bytes: (bestAttempt.cropped as any).jpeg,
            contentType: "image/jpeg",
            upsert: true,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          photoDebug.warnings.push(`upload_failed:${msg}`);
        }
        if (uploadInfo) {
          photoDebug.bucketUsed = uploadInfo.bucketUsed;
          photoDebug.bucketReason = uploadInfo.reason;
          photoDebug.storedPath = uploadInfo.path;
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    photoDebug.warnings.push(`photo_extract_failed:${msg}`);
  }

  (photoDebug as any).pageCount = pageCount;

  if (docTypeFinal === "pds") {
    const hasOwner = Boolean(ownerCandidate && (ownerCandidate as any).last_name && (ownerCandidate as any).first_name);
    const hasPhoto = Boolean((photoDebug as any)?.storedPath);
    if (!hasOwner && !hasPhoto) {
      await supabase
        .from("extractions")
        .update({
          status: "error",
          errors: {
            ocr: "OCR finished but no Personal Information and no ID photo could be extracted. Check scan quality and/or use Google Document AI billing-enabled project.",
          },
          updated_by: updatedById,
        } as any)
        .eq("id", chosenExtractionId);

      return new NextResponse(
        JSON.stringify({
          error: "OCR produced no extractable fields",
          details: "No owner_candidate and no extracted photo",
          suggestion: "Ensure the document is a clear PDS scan/photo. If using Document AI, confirm billing is enabled and the OCR processor is correct. Then retry.",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  await supabase
    .from("extractions")
    .update({
      raw_extracted_json: {
        ...(extraction as any).raw_extracted_json,
        owner_candidate: ownerCandidate,
        searchable_pdf: searchablePdf,
        owner_employee_id: ownerEmployeeId,
        debug: {
          ...(extraction as any).raw_extracted_json?.debug,
          photo: photoDebug,
          dates: {
            ...((extraction as any).raw_extracted_json?.debug?.dates || null),
            dob: {
              raw: null,
              iso: null,
              detectedFormat: "unknown",
              confidence: 0,
              reasonsIfNull: [],
            },
          },
          formFieldCount: null,
          tokenCount: page1.tokens?.length ?? null,
          ownerMethod: ownerCandidate ? ((anchor as any)?.owner ? "anchor" : (roi as any)?.owner ? "roi" : "appointment_extraction") : null,
          ownerLinkWarning,
          owner: {
            methodUsed: ownerCandidate ? ((anchor as any)?.owner ? "anchor" : (roi as any)?.owner ? "roi" : "appointment_extraction") : null,
            pageChosen: { extraction_id: chosenExtractionId, page_index: chosenPageIndex },
            personalInfoRangeY: (anchor as any)?.debug?.personalInfoRangeY ?? null,
            labelCandidates: (anchor as any)?.debug?.fields
              ? {
                  surname: (anchor as any).debug.fields.surname.allCandidates ?? null,
                  first_name: (anchor as any).debug.fields.first_name.allCandidates ?? null,
                  middle_name: (anchor as any).debug.fields.middle_name.allCandidates ?? null,
                  date_of_birth: (anchor as any).debug.fields.date_of_birth.allCandidates ?? null,
                }
              : null,
            chosenCandidates: (anchor as any)?.debug?.fields
              ? {
                  surname: (anchor as any).debug.fields.surname.chosenCandidate ?? null,
                  first_name: (anchor as any).debug.fields.first_name.chosenCandidate ?? null,
                  middle_name: (anchor as any).debug.fields.middle_name.chosenCandidate ?? null,
                  date_of_birth: (anchor as any).debug.fields.date_of_birth.chosenCandidate ?? null,
                }
              : null,
            selectedTokens: (anchor as any)?.debug?.fields
              ? {
                  surname: (anchor as any).debug.fields.surname.selectedTokens ?? null,
                  first_name: (anchor as any).debug.fields.first_name.selectedTokens ?? null,
                  middle_name: (anchor as any).debug.fields.middle_name.selectedTokens ?? null,
                  date_of_birth: (anchor as any).debug.fields.date_of_birth.selectedTokens ?? null,
                }
              : null,
            validationReasons: (page1 as any).__ownerValidationReasons ?? null,
          },
          sex: {
            method: sex.debug.method,
            maleScore: sex.debug.method === "image" ? sex.debug.densities?.male ?? null : sex.debug.male?.hitTokens?.length ?? 0,
            femaleScore: sex.debug.method === "image" ? sex.debug.densities?.female ?? null : sex.debug.female?.hitTokens?.length ?? 0,
            threshold: sex.debug.densities?.threshold ?? null,
            roisUsed:
              sex.debug.method === "image"
                ? sex.debug.imageRois ?? null
                : {
                    male: sex.debug.male?.checkboxRoi ?? null,
                    female: sex.debug.female?.checkboxRoi ?? null,
                  },
            decision: sex.value,
            reasonIfNull: sex.value ? null : sex.debug.reasons.join("; ") || "ambiguous",
            raw: sex.debug,
          },
          gender: {
            male:
              sex.debug.method === "image"
                ? sex.debug.imageRois?.male ?? null
                : sex.debug.male?.checkboxRoi ?? null,
            female:
              sex.debug.method === "image"
                ? sex.debug.imageRois?.female ?? null
                : sex.debug.female?.checkboxRoi ?? null,
            maleScore:
              sex.debug.method === "image"
                ? sex.debug.densities?.male ?? null
                : (sex.debug.male?.hitTokens?.length ?? 0),
            femaleScore:
              sex.debug.method === "image"
                ? sex.debug.densities?.female ?? null
                : (sex.debug.female?.hitTokens?.length ?? 0),
            threshold: sex.debug.densities?.threshold ?? null,
            decided: sex.value,
            raw: sex.debug,
          },
          searchablePdfWarning,
          dob: {
            raw: (dobRow.debug.rawDateMatch) || null,
            parsedIso: dobRow.iso,
            parseRuleUsed: dobRow.debug.usedRule ?? null,
            reasonsIfNull: dobRow.iso ? [] : dobRow.debug.reasonsIfNull,
            rawDebug: dobRow.debug,
          },
          template: templateAcross,
          preprocess: page1?.page?.preprocessDebug ?? null,
          batch: {
            documentSetId: (extraction as any).document_set_id ? String((extraction as any).document_set_id) : null,
            batchId: (extraction as any).batch_id ? String((extraction as any).batch_id) : null,
            pageCount,
            pagesProcessed: pageViews.length,
            pageIndexesUsed: pdfBuild.pageIndexesUsed,
            pageChosen: { extraction_id: chosenExtractionId, page_index: chosenPageIndex, score: page1.page1Score },
            pages: pageViews.map((r) => ({
              document_id: r.page.document_id,
              page_index: r.page.page_index,
              pageIndexDocAi: r.pageIndex,
              page1Score: r.page1Score,
              template: r.template,
              textLength: r.pageText.length,
            })),
          },
        },
        pages: null,
        paragraphs: null,
        text: pageViews.find((p) => p.pageIndex === 0)?.pageText ?? fullTextAll,
        text_pages: pageViews.map((r) => ({
          document_id: r.page.document_id,
          page_index: r.page.page_index,
          pageIndexDocAi: r.pageIndex,
          textLength: r.pageText.length,
          snippet: r.pageText.slice(0, 300),
        })),
      },
      warnings: ownerLinkWarning ? { owner_link: ownerLinkWarning } : null,
      status: "extracted",
      document_type: docTypeFinal,
      appointment_data: docTypeFinal === "appointment" ? appointmentData : null,
      extraction_debug: {
        ...(docTypeFinal === "appointment" ? { appointment: appointmentDebug } : {}),
        document_detection: {
          type: docTypeFinal,
          detected: docTypeDetected,
          user_selected: userSelectedType,
          confidence: docTypeResult.confidence,
          evidence: docTypeResult.evidence,
          full_text_length: fullTextAll.length,
          is_auto_detect: isAutoDetect,
          mismatch_warning: docTypeMismatchWarning,
          mismatch_details: mismatchDetails,
        },
      },
      doc_type_final: docTypeFinal,
      doc_type_detected: docTypeDetected,
      doc_type_mismatch_warning: docTypeMismatchWarning,
      updated_by: updatedById,
    } as any)
    .eq("id", chosenExtractionId);

  // Update employee_documents with doc_type for all documents in this extraction
  try {
    const docSetId = (extraction as any)?.document_set_id;
    const batchId = (extraction as any)?.batch_id;
    
    if (docSetId || batchId) {
      let query = supabase.from("employee_documents").update({
        doc_type: docTypeFinal,
        doc_type_final: docTypeFinal,
        doc_type_detected: docTypeDetected,
        doc_type_mismatch_warning: docTypeMismatchWarning,
        detection_confidence: docTypeResult.confidence,
        detection_evidence: {
          ...docTypeResult.evidence,
          is_auto_detect: isAutoDetect,
          user_selected: userSelectedType,
        },
        document_category: getDocumentCategory(docTypeFinal as DocumentType),
      });
      
      if (docSetId) {
        query = query.eq("document_set_id", docSetId);
      } else if (batchId) {
        query = query.eq("batch_id", batchId);
      }
      
      await query;
    } else {
      // Update single document
      await supabase.from("employee_documents").update({
        doc_type: docTypeFinal,
        doc_type_final: docTypeFinal,
        doc_type_detected: docTypeDetected,
        doc_type_mismatch_warning: docTypeMismatchWarning,
        detection_confidence: docTypeResult.confidence,
        detection_evidence: {
          ...docTypeResult.evidence,
          is_auto_detect: isAutoDetect,
          user_selected: userSelectedType,
        },
        document_category: getDocumentCategory(docTypeFinal as DocumentType),
      }).eq("id", extraction.document_id);
    }
  } catch (e) {
    console.error("Failed to update employee_documents doc_type:", e);
  }

  // Ensure masterlist reflects newly created employees.
  try {
    revalidatePath("/masterlist");
  } catch {
    // ignore
  }

  return NextResponse.json({
    extraction_id: chosenExtractionId,
    batch_id: (extraction as any).batch_id ? String((extraction as any).batch_id) : null,
    page_chosen: { extraction_id: chosenExtractionId, page_index: chosenPageIndex, score: page1.page1Score },
    pageCount,
    pagesProcessed: pageViews.length,
    textLength: (pageViews.find((p) => p.pageIndex === 0)?.pageText ?? fullTextAll).length,
    textPreview: (pageViews.find((p) => p.pageIndex === 0)?.pageText ?? fullTextAll).slice(0, 4000),
    debug: {
      template: templateAcross,
      genderFinal: (ownerCandidate as any)?.gender ?? null,
    },
    ownerEmployeeId,
    ownerLinkWarning,
    documentType: docTypeFinal,
    appointmentData: docTypeFinal === "appointment" ? appointmentData : null,
  });
} catch (err) {
  console.error("/api/ocr failed", err);
  return new NextResponse(err instanceof Error ? err.message : "OCR failed", { status: 500 });
}
}

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { triggerOcrJob } from "@/lib/ocr/triggerOcrJob";
import { isAdminUser } from "@/lib/auth/roles";

export const runtime = "nodejs";

function isAllowedMimeType(mimeType: string) {
  const mt = String(mimeType || "").toLowerCase();
  return mt.startsWith("image/") || mt === "application/pdf";
}

export async function POST(request: Request) {
  const authHeader = String(request.headers.get("authorization") || "").trim();
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

  if (!url || !anonKey) {
    return new NextResponse("Server misconfigured: missing Supabase URL/anon key", { status: 500 });
  }

  // Prefer Bearer token (XHR header). If it is missing/expired, fall back to cookie auth.
  let supabase: any = null;
  let user: any = null;
  let userError: any = null;

  if (bearer) {
    supabase = createClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${bearer}` },
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const r = await supabase.auth.getUser(bearer);
    user = r.data?.user ?? null;
    userError = r.error ?? null;
  }

  if (!user) {
    supabase = await createSupabaseServerClient();
    const r = await supabase.auth.getUser();
    user = r.data?.user ?? null;
    userError = r.error ?? null;
  }

  if (userError || !user) {
    return new NextResponse(`Unauthorized${userError?.message ? `: ${userError.message}` : ""}`, { status: 401 });
  }
  if (isAdminUser(user)) {
    return new NextResponse("Forbidden: admin accounts cannot upload documents", { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new NextResponse("Expected multipart/form-data", { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return new NextResponse("Missing file", { status: 400 });
  }

  const batchId = String(form.get("batch_id") || "").trim() || null;
  const pageIndexRaw = String(form.get("page_index") || "").trim();
  const pageIndex = pageIndexRaw ? Number(pageIndexRaw) : null;
  const documentSetIdRaw = String(form.get("document_set_id") || "").trim();
  const attachToDocumentSetId = documentSetIdRaw ? documentSetIdRaw : null;
  const extractionIdRaw = String(form.get("extraction_id") || "").trim();
  const attachToExtractionId = extractionIdRaw ? extractionIdRaw : null;
  const ownerEmployeeIdRaw = String(form.get("owner_employee_id") || "").trim();
  const ownerEmployeeId = ownerEmployeeIdRaw ? ownerEmployeeIdRaw : null;
  
  // Document type user selection
  const docTypeUserSelected = String(form.get("doc_type_user_selected") || "").trim() || null;
  const docTypeFinal = docTypeUserSelected || "unknown";

  const originalFilename = String(form.get("original_filename") || file.name || "").trim();
  const mimeType = String(form.get("mime_type") || file.type || "application/octet-stream").trim();
  const fileSizeBytes = Number(form.get("file_size_bytes") || file.size || 0);

  if (!originalFilename) return new NextResponse("Missing original_filename", { status: 400 });
  if (!isAllowedMimeType(mimeType)) {
    return new NextResponse(`Unsupported file type: ${mimeType}`, { status: 400 });
  }

  // document_sets: create-on-first-upload unless provided.
  let documentSetId: string | null = attachToDocumentSetId;
  if (!documentSetId) {
    const { data: ds, error: dsErr } = await supabase
      .from("document_sets")
      .insert({ status: "uploaded" } as any)
      .select("id")
      .single();
    if (dsErr || !ds?.id) {
      return new NextResponse(dsErr?.message || "Failed to create document_set", { status: 400 });
    }
    documentSetId = String(ds.id);
  }

  const ext = originalFilename.includes(".") ? originalFilename.split(".").pop() : "bin";
  const safeExt = (ext || "bin").toLowerCase().replace(/[^0-9a-z]/g, "");
  const filename = `${crypto.randomUUID()}.${safeExt || "bin"}`;
  const path = `uploads/${new Date().toISOString().slice(0, 10)}/${filename}`;

  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage.from("hr-documents").upload(path, bytes, {
    contentType: mimeType,
    upsert: false,
  } as any);

  if (uploadErr) {
    return new NextResponse(uploadErr.message, { status: 400 });
  }

  const { data: doc, error: docErr } = await supabase
    .from("employee_documents")
    .insert({
      storage_bucket: "hr-documents",
      storage_path: path,
      mime_type: mimeType,
      original_filename: originalFilename,
      file_size_bytes: Number.isFinite(fileSizeBytes) ? fileSizeBytes : null,
      employee_id: ownerEmployeeId,
      batch_id: batchId,
      document_set_id: documentSetId,
      page_index: Number.isFinite(pageIndex as any) ? pageIndex : null,
      created_by: user.id,
      doc_type: docTypeFinal,
      doc_type_user_selected: docTypeUserSelected,
      doc_type_final: docTypeFinal,
      detection_confidence: docTypeUserSelected ? 1.0 : 0,
      detection_evidence: { 
        stage: docTypeUserSelected ? "user_selected" : "pending", 
        matched: docTypeUserSelected ? ["user_selected"] : [], 
        scores: {} 
      },
      document_category: docTypeFinal,
    } as any)
    .select("id")
    .single();

  if (docErr || !doc?.id) {
    return new NextResponse(docErr?.message || "Failed to create employee_documents row", { status: 400 });
  }

  let outExtractionId: string | null = null;
  if (attachToExtractionId) {
    // Attach this page to an existing extraction group.
    // The OCR route will fetch all pages via batch_id, so we only need the anchor extraction to exist.
    const { data: existing, error: existingErr } = await supabase
      .from("extractions")
      .select("id, batch_id, document_set_id")
      .eq("id", attachToExtractionId)
      .single();
    if (existingErr || !existing?.id) {
      return new NextResponse(existingErr?.message || "Invalid extraction_id (cannot attach)", { status: 400 });
    }
    const existingBatch = existing.batch_id ? String(existing.batch_id) : null;
    if (existingBatch && batchId && existingBatch !== batchId) {
      return new NextResponse("batch_id mismatch when attaching page to extraction", { status: 400 });
    }
    if (!existingBatch && batchId) {
      const extractionPatch: any = { batch_id: batchId };
      if (ownerEmployeeId) extractionPatch.linked_employee_id = ownerEmployeeId;
      const { error: upErr } = await supabase
        .from("extractions")
        .update(extractionPatch)
        .eq("id", attachToExtractionId);
      if (upErr) return new NextResponse(upErr.message || "Failed to set extraction.batch_id", { status: 400 });
    } else if (ownerEmployeeId) {
      const { error: ownerLinkErr } = await supabase
        .from("extractions")
        .update({ linked_employee_id: ownerEmployeeId } as any)
        .eq("id", attachToExtractionId);
      if (ownerLinkErr) return new NextResponse(ownerLinkErr.message || "Failed to set extraction.linked_employee_id", { status: 400 });
    }

    const existingSetId = existing.document_set_id ? String(existing.document_set_id) : null;
    if (existingSetId && documentSetId && existingSetId !== documentSetId) {
      return new NextResponse("document_set_id mismatch when attaching page to extraction", { status: 400 });
    }
    if (!existingSetId && documentSetId) {
      const { error: upSetErr } = await supabase
        .from("extractions")
        .update({ document_set_id: documentSetId } as any)
        .eq("id", attachToExtractionId);
      if (upSetErr) return new NextResponse(upSetErr.message || "Failed to set extraction.document_set_id", { status: 400 });
    }
    outExtractionId = String(existing.id);
  } else {
    const { data: extraction, error: exErr } = await supabase
      .from("extractions")
      .insert({
        document_id: doc.id,
        batch_id: batchId,
        document_set_id: documentSetId,
        page_index: Number.isFinite(pageIndex as any) ? pageIndex : null,
        status: "uploaded",
        linked_employee_id: ownerEmployeeId,
        created_by: user.id,
        updated_by: user.id,
        doc_type_user_selected: docTypeUserSelected,
        doc_type_final: docTypeFinal,
        document_type: docTypeFinal,
      } as any)
      .select("id")
      .single();

    if (exErr || !extraction?.id) {
      return new NextResponse(exErr?.message || "Failed to create extraction", { status: 400 });
    }
    outExtractionId = String(extraction.id);
  }

  let ocrEnqueued = false;
  let ocrEnqueueError: string | null = null;
  if (outExtractionId) {
    try {
      await triggerOcrJob({ extractionId: outExtractionId });
      ocrEnqueued = true;
    } catch (e) {
      ocrEnqueueError = e instanceof Error ? e.message : String(e);
      console.error("[UPLOAD] Failed to enqueue OCR job:", ocrEnqueueError);
    }
  }

  return NextResponse.json({
    ok: true,
    batch_id: batchId,
    document_set_id: documentSetId,
    extraction_id: outExtractionId,
    document_id: doc.id,
    ocr_enqueued: ocrEnqueued,
    ocr_enqueue_error: ocrEnqueueError,
  });
}

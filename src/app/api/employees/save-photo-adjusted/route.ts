import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeScanToLegal } from "@/lib/pds/normalizeScanToLegal";

export const runtime = "nodejs";

type NormBox = { x: number; y: number; w: number; h: number };

function normalizeRotationDegrees(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const normalized = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampBox(b: NormBox): NormBox {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  const w = clamp01(b.w);
  const h = clamp01(b.h);

  const maxW = 1 - x;
  const maxH = 1 - y;

  return {
    x,
    y,
    w: Math.max(0.02, Math.min(w, maxW)),
    h: Math.max(0.02, Math.min(h, maxH)),
  };
}

async function ensurePrivateBucket(admin: any, bucketName: string) {
  const { data: buckets, error: listErr } = await admin.storage.listBuckets();
  if (listErr) throw new Error(listErr.message);
  const exists = (buckets || []).some((b: any) => String(b?.name || "") === bucketName);
  if (exists) return;

  const { error: createErr } = await admin.storage.createBucket(bucketName, {
    public: false,
  } as any);
  if (createErr) {
    const msg = String(createErr.message || "");
    if (!/already exists/i.test(msg)) throw new Error(createErr.message);
  }
}

async function downloadObject(admin: any, bucket: string, path: string) {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message || "download_failed");
  const ab = await (data as any).arrayBuffer();
  return Buffer.from(ab);
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return new NextResponse("Unauthorized", { status: 401 });

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new NextResponse("Invalid JSON body", { status: 400 });
    }

    const extractionId = String(body.extraction_id || "").trim();
    const employeeId = String(body.employee_id || "").trim();
    const pageIndex = Number(body.page_index);
    const roi = body.roi as NormBox;
    const force = Boolean(body.force);
    const rotationDegrees = normalizeRotationDegrees(body.rotation_degrees);

    if (!extractionId) return new NextResponse("Missing extraction_id", { status: 400 });
    if (!employeeId) return new NextResponse("Missing employee_id", { status: 400 });
    if (!Number.isFinite(pageIndex) || pageIndex < 0) return new NextResponse("Invalid page_index", { status: 400 });
    if (!roi || typeof roi !== "object") return new NextResponse("Missing roi", { status: 400 });

    let dbClient: any = supabase;
    let storageClient: any = supabase;
    try {
      const admin = createSupabaseAdminClient();
      dbClient = admin;
      storageClient = admin;
    } catch {
      // fall back to user session; requires RLS/storage policies
    }

    const { data: emp, error: empErr } = await dbClient.from("employees").select("id, photo_url").eq("id", employeeId).single();
    if (empErr || !emp) return new NextResponse(empErr?.message || "Employee not found", { status: 404 });
    if ((emp as any).photo_url && !force) {
      return new NextResponse("Employee already has a photo. Pass force=true to replace.", { status: 400 });
    }

    const { data: extraction, error: exErr } = await dbClient
      .from("extractions")
      .select("id, document_id, document_set_id, batch_id, raw_extracted_json")
      .eq("id", extractionId)
      .single();
    if (exErr || !extraction) return new NextResponse(exErr?.message || "Extraction not found", { status: 404 });

    const docSetId = (extraction as any).document_set_id ? String((extraction as any).document_set_id) : "";
    const batchId = (extraction as any).batch_id ? String((extraction as any).batch_id) : "";

    // Resolve the page's employee_documents row.
    let docRow: any = null;
    if (docSetId) {
      const { data: docs, error: docsErr } = await dbClient
        .from("employee_documents")
        .select("id, storage_bucket, storage_path, mime_type")
        .eq("document_set_id", docSetId)
        .eq("page_index", pageIndex)
        .order("created_at", { ascending: true })
        .limit(1);
      if (docsErr) return new NextResponse(docsErr.message, { status: 400 });
      docRow = (docs || [])[0] || null;
    }

    if (!docRow && batchId) {
      const { data: docs, error: docsErr } = await dbClient
        .from("employee_documents")
        .select("id, storage_bucket, storage_path, mime_type")
        .eq("batch_id", batchId)
        .eq("page_index", pageIndex)
        .order("created_at", { ascending: true })
        .limit(1);
      if (docsErr) return new NextResponse(docsErr.message, { status: 400 });
      docRow = (docs || [])[0] || null;
    }

    if (!docRow && (extraction as any).document_id) {
      const { data: d, error: dErr } = await dbClient
        .from("employee_documents")
        .select("id, storage_bucket, storage_path, mime_type")
        .eq("id", String((extraction as any).document_id))
        .single();
      if (!dErr && d) docRow = d;
    }

    if (!docRow?.storage_bucket || !docRow?.storage_path) {
      return new NextResponse("Could not resolve original page for cropping", { status: 400 });
    }

    const srcBucket = String(docRow.storage_bucket);
    const srcPath = String(docRow.storage_path);
    const mime = String(docRow.mime_type || "application/octet-stream");

    const originalBytes = await downloadObject(storageClient, srcBucket, srcPath);

    const norm = await normalizeScanToLegal({
      bytes: originalBytes,
      mimeType: mime,
      pageIndex,
      dpi: 180,
      enhance: true,
      skipPaperCrop: true,
    });

    const safeRoi = clampBox({ x: Number(roi.x), y: Number(roi.y), w: Number(roi.w), h: Number(roi.h) });

    let sharp: any;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      return new NextResponse("sharp not installed", { status: 500 });
    }

    let normalizedBuffer = Buffer.from(norm.buffer);
    if (rotationDegrees !== 0) {
      normalizedBuffer = await sharp(normalizedBuffer).rotate(rotationDegrees).png().toBuffer();
    }

    const meta = await sharp(normalizedBuffer).metadata();
    const w = Number(meta.width || 0);
    const h = Number(meta.height || 0);
    if (!w || !h) return new NextResponse("Invalid normalized image", { status: 500 });

    const left = Math.max(0, Math.floor(safeRoi.x * w));
    const top = Math.max(0, Math.floor(safeRoi.y * h));
    const width = Math.max(1, Math.floor(safeRoi.w * w));
    const height = Math.max(1, Math.floor(safeRoi.h * h));

    let img = sharp(normalizedBuffer).extract({ left, top, width, height });
    try {
      img = img.trim({ threshold: 12 });
    } catch {
      // ignore
    }

    const jpeg = await img
      .resize(512, 512, { fit: "cover", position: "centre" })
      .jpeg({ quality: 90 })
      .toBuffer();

    const destBucket = "employee_photos";
    try {
      await ensurePrivateBucket(storageClient, destBucket);
    } catch {
      // ignore (user-session client may not be allowed to list/create buckets)
    }

    const destPath = `${employeeId}/id_photo_${extractionId}_manual.jpg`;
    const { error: upErr } = await storageClient.storage.from(destBucket).upload(destPath, jpeg, {
      contentType: "image/jpeg",
      upsert: true,
    } as any);
    if (upErr) return new NextResponse(upErr.message, { status: 400 });

    const employeeUpdate: any = {
      photo_url: destPath,
      photo_bucket: destBucket,
      photo_source: "manual_crop",
      photo_updated_at: new Date().toISOString(),
    };

    const { error: empUpErr } = await dbClient.from("employees").update(employeeUpdate).eq("id", employeeId);
    if (empUpErr) return new NextResponse(empUpErr.message, { status: 400 });

    // Update extraction debug (best-effort).
    try {
      const raw = (extraction as any).raw_extracted_json || {};
      const dbg = (raw as any).debug || {};
      const prevPhoto = (dbg as any).photo || {};
      const updatedRaw = {
        ...raw,
        debug: {
          ...dbg,
          photo: {
            ...prevPhoto,
            pageIndex,
            method: "manual",
            roi: safeRoi,
            rotationDegrees,
            storedPath: destPath,
            bucketUsed: destBucket,
            faceDetected: true,
          },
        },
      };
      await dbClient.from("extractions").update({ raw_extracted_json: updatedRaw } as any).eq("id", extractionId);
    } catch {
      // ignore
    }

    return NextResponse.json({
      ok: true,
      employee_id: employeeId,
      extraction_id: extractionId,
      bucket: destBucket,
      path: destPath,
      roi: safeRoi,
      rotationDegrees,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(msg || "Failed to save adjusted photo", { status: 500 });
  }
}

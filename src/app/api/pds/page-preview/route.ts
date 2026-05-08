import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeScanToLegal } from "@/lib/pds/normalizeScanToLegal";

export const runtime = "nodejs";

async function downloadObject(client: any, bucket: string, path: string) {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message || "download_failed");
  const ab = await (data as any).arrayBuffer();
  return Buffer.from(ab);
}

function normalizeRotationDegrees(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const normalized = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) return new NextResponse("Unauthorized", { status: 401 });

    const url = new URL(request.url);
    const extractionId = String(url.searchParams.get("extraction_id") || "").trim();
    const pageIndex = Number(url.searchParams.get("page_index"));
    const rotationDegrees = normalizeRotationDegrees(url.searchParams.get("rotation_degrees"));

    if (!extractionId) return new NextResponse("Missing extraction_id", { status: 400 });
    if (!Number.isFinite(pageIndex) || pageIndex < 0) return new NextResponse("Invalid page_index", { status: 400 });

    // Prefer service-role to avoid any RLS surprises, but fall back to the authenticated server client
    // when SUPABASE_SERVICE_ROLE_KEY isn't configured.
    let dbClient: any = supabase;
    let storageClient: any = supabase;
    try {
      const admin = createSupabaseAdminClient();
      dbClient = admin;
      storageClient = admin;
    } catch {
      // intentional fallback
    }

    const { data: extraction, error: exErr } = await dbClient
      .from("extractions")
      .select("id, document_id, document_set_id, batch_id")
      .eq("id", extractionId)
      .single();

    if (exErr || !extraction) return new NextResponse(exErr?.message || "Extraction not found", { status: 404 });

    const docSetId = (extraction as any).document_set_id ? String((extraction as any).document_set_id) : "";
    const batchId = (extraction as any).batch_id ? String((extraction as any).batch_id) : "";

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
      return new NextResponse("Could not resolve original page", { status: 400 });
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

    let outputBuffer = Buffer.from(norm.buffer);
    if (rotationDegrees !== 0) {
      let sharp: any;
      try {
        sharp = (await import("sharp")).default;
      } catch {
        return new NextResponse("sharp not installed", { status: 500 });
      }
      outputBuffer = await sharp(outputBuffer).rotate(rotationDegrees).png().toBuffer();
    }

    return new NextResponse(outputBuffer, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(msg || "Internal Server Error", { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";

function inferDocumentCategory(doc: any) {
  const docType = String(doc?.doc_type || doc?.document_type || doc?.document_category || "").toLowerCase().trim();
  if (docType && docType !== "unknown") return docType;
  const filename = String(doc?.original_filename || "").toLowerCase();
  const mime = String(doc?.mime_type || "").toLowerCase();
  if (filename.includes("pds")) return "pds";
  if (filename.includes("appointment")) return "appointment";
  if (filename.includes("oath")) return "oath";
  if (filename.includes("assumption")) return "assumption";
  if (filename.includes("certification")) return "certification_lgu";
  if (filename.includes("nosa")) return "nosa";
  if (filename.includes("nosi")) return "nosi";
  if (filename.includes("ipcr")) return "ipcr";
  if (filename.includes("service record") || filename.includes("coe")) return "service_record";
  if (filename.includes("training") || filename.includes("seminar")) return "training";
  if (filename.includes("eligibility")) return "eligibility";
  if (mime.startsWith("image/")) return "photo";
  return "other";
}

function normalizeNamePart(value: string | null | undefined) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function middleNameCompatible(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeNamePart(a);
  const right = normalizeNamePart(b);
  if (!left || !right) return true;
  if (left === right) return true;
  return left[0] === right[0] || left.startsWith(right) || right.startsWith(left);
}

function extractionMatchesEmployee(extraction: any, employee: any) {
  const employeeId = String(employee?.id || "");
  if (!employeeId) return false;

  if (String(extraction?.linked_employee_id || "") === employeeId) return true;

  const raw = extraction?.raw_extracted_json || {};
  if (String(raw?.owner_employee_id || "") === employeeId) return true;

  const rawOwner = raw?.owner_candidate || raw?.appointment_data?.owner || {};
  const appointmentOwner = extraction?.appointment_data?.owner || {};
  const owner = {
    last_name: String(rawOwner?.last_name || appointmentOwner?.last_name || "").trim(),
    first_name: String(rawOwner?.first_name || appointmentOwner?.first_name || "").trim(),
    middle_name: String(rawOwner?.middle_name || appointmentOwner?.middle_name || "").trim(),
    date_of_birth: String(rawOwner?.date_of_birth || appointmentOwner?.date_of_birth || "").trim(),
  };

  if (!owner.last_name || !owner.first_name) return false;
  if (normalizeNamePart(owner.last_name) !== normalizeNamePart(employee?.last_name)) return false;
  if (normalizeNamePart(owner.first_name) !== normalizeNamePart(employee?.first_name)) return false;
  if (!middleNameCompatible(owner.middle_name, employee?.middle_name)) return false;

  const employeeDob = String(employee?.date_of_birth || "").trim();
  if (owner.date_of_birth && employeeDob && owner.date_of_birth !== employeeDob) return false;

  return true;
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const employeeId = String(url.searchParams.get("employee_id") || "").trim();
  const docType = String(url.searchParams.get("doc_type") || "").trim() as any;
  const format = String(url.searchParams.get("format") || "pdf").trim(); // pdf, zip, or original

  if (!employeeId) {
    return new NextResponse("Missing employee_id", { status: 400 });
  }

  const { data: employee, error: employeeErr } = await supabase
    .from("employees")
    .select("id, last_name, first_name, middle_name, date_of_birth")
    .eq("id", employeeId)
    .single();

  if (employeeErr || !employee) {
    return new NextResponse(employeeErr?.message || "Employee not found", { status: 404 });
  }

  const { data: directDocs, error: docsErr } = await supabase
    .from("employee_documents")
    .select("id, employee_id, storage_bucket, storage_path, mime_type, original_filename, page_index, doc_type, document_type, document_category, document_set_id, created_at")
    .eq("employee_id", employeeId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (docsErr) {
    return new NextResponse(docsErr.message, { status: 400 });
  }

  const { data: linkedExtractions, error: linkedErr } = await supabase
    .from("extractions")
    .select("id, document_id, linked_employee_id, appointment_data, raw_extracted_json")
    .eq("linked_employee_id", employeeId)
    .limit(100);

  if (linkedErr) {
    return new NextResponse(linkedErr.message, { status: 400 });
  }

  const { data: recoveryExtractions, error: recoveryErr } = await supabase
    .from("extractions")
    .select("id, document_id, linked_employee_id, appointment_data, raw_extracted_json, created_at")
    .not("document_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (recoveryErr) {
    return new NextResponse(recoveryErr.message, { status: 400 });
  }

  const matchedExtractions = [
    ...(linkedExtractions || []),
    ...((recoveryExtractions || []).filter((extraction: any) => extractionMatchesEmployee(extraction, employee))),
  ];

  const directIds = new Set((directDocs || []).map((d: any) => String(d.id)));
  const missingDocIds = Array.from(
    new Set(matchedExtractions.map((e: any) => String(e?.document_id || "")).filter(Boolean))
  ).filter((id) => !directIds.has(id));

  let fallbackDocs: any[] = [];
  if (missingDocIds.length > 0) {
    const { data, error } = await supabase
      .from("employee_documents")
      .select("id, employee_id, storage_bucket, storage_path, mime_type, original_filename, page_index, doc_type, document_type, document_category, document_set_id, created_at")
      .in("id", missingDocIds)
      .order("created_at", { ascending: false });
    if (error) {
      return new NextResponse(error.message, { status: 400 });
    }
    fallbackDocs = data || [];
  }

  const mergedRows = [...(directDocs || []), ...fallbackDocs].filter((row, index, arr) => {
    const id = String(row?.id || "");
    return id && arr.findIndex((x: any) => String(x?.id || "") === id) === index;
  });

  const rows = mergedRows.filter((row: any) => {
    if (!docType || docType === "all") return true;
    return inferDocumentCategory(row) === docType || String(row?.doc_type || "") === docType;
  });

  if (rows.length === 0) {
    return new NextResponse("No documents found", { status: 404 });
  }

  // Download all files
  const fileBuffers: Array<{ 
    name: string; 
    buffer: Buffer; 
    mimeType: string;
    docType: string;
    originalFilename: string;
  }> = [];

  for (const d of rows) {
    const bucket = String(d.storage_bucket || "");
    const path = String(d.storage_path || "");
    if (!bucket || !path) continue;

    const { data: downloaded, error: dlErr } = await supabase.storage.from(bucket).download(path);
    if (dlErr || !downloaded) continue;

    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const mime = String(d.mime_type || "application/octet-stream");
    const originalName = String(d.original_filename || `document-${d.id}`);
    const type = inferDocumentCategory(d);

    fileBuffers.push({
      name: originalName,
      buffer: bytes,
      mimeType: mime,
      docType: type,
      originalFilename: originalName,
    });
  }

  if (fileBuffers.length === 0) {
    return new NextResponse("No downloadable documents found", { status: 404 });
  }

  // Return based on format
  if (format === "zip" || (format === "original" && fileBuffers.length > 1)) {
    // Create ZIP
    const zip = new JSZip();
    const typeLabel = docType === "all" ? "all" : docType;
    
    // Group files by doc_type for better organization in ZIP
    const grouped = fileBuffers.reduce((acc, file) => {
      const type = file.docType || "other";
      if (!acc[type]) acc[type] = [];
      acc[type].push(file);
      return acc;
    }, {} as Record<string, typeof fileBuffers>);

    // Add files to ZIP, organized by type
    for (const [type, files] of Object.entries(grouped)) {
      const folder = zip.folder(type) || zip;
      files.forEach((file, idx) => {
        const ext = file.name.includes(".") ? "" : ".bin";
        const filename = file.name.endsWith(ext) ? file.name : `${file.name}${ext}`;
        // Add index to prevent overwrites
        const uniqueName = files.length > 1 ? `${idx + 1}_${filename}` : filename;
        folder.file(uniqueName, file.buffer);
      });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename=employee-${employeeId}-${typeLabel}-documents.zip`,
        "cache-control": "no-store",
      },
    });
  }

  // Default: Combine into single PDF
  const outPdf = await PDFDocument.create();
  const legalW = 8.5 * 72;
  const legalH = 13 * 72;

  for (const file of fileBuffers) {
    try {
      const isPdf = file.mimeType === "application/pdf";
      
      if (isPdf) {
        // Embed PDF pages
        const srcPdf = await PDFDocument.load(file.buffer);
        const pages = await outPdf.copyPages(srcPdf, srcPdf.getPageIndices());
        pages.forEach((page) => outPdf.addPage(page));
      } else if (file.mimeType.startsWith("image/")) {
        // Embed image
        let img;
        if (file.mimeType === "image/png") {
          img = await outPdf.embedPng(file.buffer);
        } else if (file.mimeType === "image/jpeg" || file.mimeType === "image/jpg") {
          img = await outPdf.embedJpg(file.buffer);
        } else {
          // Skip unsupported image types
          continue;
        }
        
        const page = outPdf.addPage([legalW, legalH]);
        const scale = Math.min(legalW / img.width, legalH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const x = (legalW - w) / 2;
        const y = (legalH - h) / 2;
        page.drawImage(img, { x, y, width: w, height: h });
      }
    } catch (e) {
      console.error(`Failed to add file ${file.name} to PDF:`, e);
    }
  }

  const out = await outPdf.save();
  const typeLabel = docType === "all" ? "all" : docType;
  
  return new NextResponse(Buffer.from(out), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename=employee-${employeeId}-${typeLabel}-combined.pdf`,
      "cache-control": "no-store",
    },
  });
}

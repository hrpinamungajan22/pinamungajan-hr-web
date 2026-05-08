import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { formatDateDdMmYyyy } from "@/lib/pds/validators";
import { computeAgeAndGroupFromDobIso } from "@/lib/age";

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

function buildDocumentRowKey(doc: any) {
  const bucket = String(doc?.storage_bucket || "").trim();
  const path = String(doc?.storage_path || "").trim();
  const setId = String(doc?.document_set_id || "").trim();
  const batchId = String(doc?.batch_id || "").trim();
  const pageIndex = doc?.page_index === null || doc?.page_index === undefined ? "" : String(doc.page_index);
  if (bucket && path) return `${bucket}|${path}|${pageIndex}`;
  if (setId) return `set|${setId}|${pageIndex}`;
  if (batchId) return `batch|${batchId}|${pageIndex}`;
  return `id|${String(doc?.id || "")}`;
}

function buildDownloadHref(input: { bucket: string; path: string; filename: string; contentType: string }) {
  const qs = new URLSearchParams({
    bucket: input.bucket,
    path: input.path,
    filename: input.filename,
    contentType: input.contentType,
  });
  return `/api/files/download?${qs.toString()}`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authSupabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await authSupabase.auth.getUser();

  if (userError || !user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const supabase = createSupabaseAdminClient();

  const { id } = await params;
  const employeeId = String(id || "");
  if (!employeeId) return new NextResponse("Missing employee id", { status: 400 });

  const { data: employee, error: employeeErr } = await supabase
    .from("employees")
    .select(
      "id, last_name, first_name, middle_name, name_extension, date_of_birth, age, age_group, position_title, office_department, sg, monthly_salary, annual_salary, gender, photo_url, photo_bucket, photo_source, photo_updated_at, date_hired"
    )
    .eq("id", employeeId)
    .single();

  if (employeeErr || !employee) {
    return new NextResponse(employeeErr?.message || "Employee not found", { status: 404 });
  }

  const { data: directDocs } = await supabase
    .from("employee_documents")
    .select("id, employee_id, storage_bucket, storage_path, mime_type, original_filename, page_index, created_at, document_set_id, batch_id, document_category, document_type, doc_type, detection_confidence, detection_evidence")
    .eq("employee_id", employeeId)
    .order("created_at", { ascending: false })
    .limit(100);

  const { data: linkedExtractions } = await supabase
    .from("extractions")
    .select("id, document_id, status, document_type, appointment_data, created_at, linked_employee_id, raw_extracted_json, document_set_id, batch_id")
    .eq("linked_employee_id", employeeId)
    .order("created_at", { ascending: false })
    .limit(100);

  const { data: recoveryExtractions } = await supabase
    .from("extractions")
    .select("id, document_id, status, document_type, appointment_data, created_at, linked_employee_id, raw_extracted_json, document_set_id, batch_id")
    .not("document_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  const matchedExtractionMap = new Map<string, any>();
  for (const extraction of [
    ...(linkedExtractions || []),
    ...((recoveryExtractions || []).filter((row: any) => extractionMatchesEmployee(row, employee))),
  ]) {
    const extractionId = String(extraction?.id || "");
    if (!extractionId || matchedExtractionMap.has(extractionId)) continue;
    matchedExtractionMap.set(extractionId, extraction);
  }
  const matchedExtractions = Array.from(matchedExtractionMap.values());

  const extractionByDocId = new Map<string, any>();
  const extractionBySetId = new Map<string, any>();
  const extractionByBatchId = new Map<string, any>();
  for (const extraction of matchedExtractions) {
    const docId = extraction?.document_id ? String(extraction.document_id) : "";
    if (docId && !extractionByDocId.has(docId)) extractionByDocId.set(docId, extraction);
    const setId = extraction?.document_set_id ? String(extraction.document_set_id) : "";
    if (setId && !extractionBySetId.has(setId)) extractionBySetId.set(setId, extraction);
    const batchId = extraction?.batch_id ? String(extraction.batch_id) : "";
    if (batchId && !extractionByBatchId.has(batchId)) extractionByBatchId.set(batchId, extraction);
  }

  const directDocIds = new Set((directDocs || []).map((doc: any) => String(doc.id)));
  const missingDocIds = Array.from(extractionByDocId.keys()).filter((id) => !directDocIds.has(id));
  const relatedSetIds = Array.from(new Set(matchedExtractions.map((row: any) => String(row?.document_set_id || "")).filter(Boolean)));
  const relatedBatchIds = Array.from(new Set(matchedExtractions.map((row: any) => String(row?.batch_id || "")).filter(Boolean)));
  const directSetIds = new Set((directDocs || []).map((doc: any) => String(doc?.document_set_id || "")).filter(Boolean));
  const directBatchIds = new Set((directDocs || []).map((doc: any) => String(doc?.batch_id || "")).filter(Boolean));
  const missingSetIds = relatedSetIds.filter((setId) => !directSetIds.has(setId));
  const missingBatchIds = relatedBatchIds.filter((batchId) => !directBatchIds.has(batchId));

  let fallbackDocs: any[] = [];
  if (missingDocIds.length > 0) {
    const { data } = await supabase
      .from("employee_documents")
      .select("id, employee_id, storage_bucket, storage_path, mime_type, original_filename, page_index, created_at, document_set_id, batch_id, document_category, document_type, doc_type, detection_confidence, detection_evidence")
      .in("id", missingDocIds)
      .order("created_at", { ascending: false });
    fallbackDocs = data || [];
  }

  let setDocs: any[] = [];
  if (missingSetIds.length > 0) {
    const { data } = await supabase
      .from("employee_documents")
      .select("id, employee_id, storage_bucket, storage_path, mime_type, original_filename, page_index, created_at, document_set_id, batch_id, document_category, document_type, doc_type, detection_confidence, detection_evidence")
      .in("document_set_id", missingSetIds)
      .order("created_at", { ascending: false })
      .limit(500);
    setDocs = data || [];
  }

  let batchDocs: any[] = [];
  if (missingBatchIds.length > 0) {
    const { data } = await supabase
      .from("employee_documents")
      .select("id, employee_id, storage_bucket, storage_path, mime_type, original_filename, page_index, created_at, document_set_id, batch_id, document_category, document_type, doc_type, detection_confidence, detection_evidence")
      .in("batch_id", missingBatchIds)
      .order("created_at", { ascending: false })
      .limit(500);
    batchDocs = data || [];
  }

  const enrichmentDocIds = Array.from(
    new Set(
      [...(directDocs || []), ...fallbackDocs, ...setDocs, ...batchDocs]
        .map((doc: any) => String(doc?.id || ""))
        .filter(Boolean)
    )
  );

  if (enrichmentDocIds.length > 0) {
    const { data: extractionsForDocs } = await supabase
      .from("extractions")
      .select("id, document_id, status, document_type, appointment_data, created_at, linked_employee_id, raw_extracted_json, document_set_id, batch_id")
      .in("document_id", enrichmentDocIds)
      .order("created_at", { ascending: false })
      .limit(500);

    for (const extraction of extractionsForDocs || []) {
      const docId = extraction?.document_id ? String(extraction.document_id) : "";
      if (docId && !extractionByDocId.has(docId)) extractionByDocId.set(docId, extraction);
      const setId = extraction?.document_set_id ? String(extraction.document_set_id) : "";
      if (setId && !extractionBySetId.has(setId)) extractionBySetId.set(setId, extraction);
      const batchId = extraction?.batch_id ? String(extraction.batch_id) : "";
      if (batchId && !extractionByBatchId.has(batchId)) extractionByBatchId.set(batchId, extraction);
    }
  }

  const mergedDocMap = new Map<string, any>();
  for (const doc of [...(directDocs || []), ...fallbackDocs, ...setDocs, ...batchDocs]) {
    const key = buildDocumentRowKey(doc);
    if (!key) continue;
    const existing = mergedDocMap.get(key);
    if (!existing) {
      mergedDocMap.set(key, doc);
      continue;
    }
    if (!existing.employee_id && doc?.employee_id) {
      mergedDocMap.set(key, doc);
    }
  }

  const rawDocuments = Array.from(mergedDocMap.values()).sort(
    (a: any, b: any) => +new Date(String(b?.created_at || 0)) - +new Date(String(a?.created_at || 0))
  );

  const documents = await Promise.all(
    rawDocuments.map(async (d: any) => {
      const bucket = String(d.storage_bucket || "");
      const path = String(d.storage_path || "");
      let signed_url: string | null = null;
      if (bucket && path) {
        const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 10);
        signed_url = signed?.signedUrl ?? null;
      }
      const extraction =
        extractionByDocId.get(String(d.id)) ||
        (d.document_set_id ? extractionBySetId.get(String(d.document_set_id)) : null) ||
        (d.batch_id ? extractionByBatchId.get(String(d.batch_id)) : null) ||
        null;
      return {
        id: d.id,
        original_filename: d.original_filename,
        mime_type: d.mime_type,
        page_index: d.page_index,
        document_set_id: d.document_set_id,
        batch_id: d.batch_id,
        document_category: d.document_category || inferDocumentCategory(d),
        document_type: d.document_type,
        doc_type: d.doc_type,
        detection_confidence: d.detection_confidence,
        detection_evidence: d.detection_evidence,
        created_at: d.created_at,
        bucket,
        path,
        signed_url,
        download_url: bucket && path
          ? buildDownloadHref({
              bucket,
              path,
              filename: String(d.original_filename || `document-${d.id}`),
              contentType: String(d.mime_type || "application/octet-stream"),
            })
          : null,
        link_source: d.employee_id ? "employee_document" : extraction ? "extraction_link" : "unknown",
        extraction: extraction
          ? {
              id: extraction.id,
              status: extraction.status,
              document_type: extraction.document_type,
              appointment_data: extraction.appointment_data,
              created_at: extraction.created_at,
            }
          : null,
      };
    })
  );

  // Preferred: employees.photo_url in employee_photos bucket.
  let photo: any = null;
  const employeePhotoPath = (employee as any)?.photo_url ? String((employee as any).photo_url) : "";
  if ((employee as any).photo_url) {
    try {
      const bucket = String((employee as any).photo_bucket || "employee_photos");
      const { data: signed, error: signErr } = await supabase.storage.from(bucket).createSignedUrl((employee as any).photo_url, 60 * 10);
      if (!signErr && signed?.signedUrl) {
        photo = {
          bucket,
          path: employeePhotoPath,
          signed_url: signed.signedUrl,
          source: (employee as any)?.photo_source ?? null,
          updated_at: (employee as any)?.photo_updated_at ?? null,
        };
      }
    } catch {
      // ignore
    }
  } else {
    const photoDoc = documents.find((d: any) => String(d?.mime_type || "").toLowerCase().startsWith("image/")) || null;
    photo = photoDoc
      ? {
          document_id: photoDoc.id,
          original_filename: photoDoc.original_filename,
          mime_type: photoDoc.mime_type,
          created_at: photoDoc.created_at,
          signed_url: photoDoc.signed_url,
        }
      : null;
  }

  const dobIso = (employee as any).date_of_birth ? String((employee as any).date_of_birth) : null;
  const computedAge = dobIso ? computeAgeAndGroupFromDobIso(dobIso) : { age: null, age_group: null };

  return NextResponse.json({
    employee: {
      ...employee,
      date_of_birth_display: dobIso ? formatDateDdMmYyyy(dobIso) : "",
      age_final: (employee as any).age ?? computedAge.age,
      age_group_final: (employee as any).age_group ?? computedAge.age_group,
    },
    photo,
    documents,
  });
}

import { AppShell } from "@/components/AppShell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RunOcrButton } from "@/app/review/[id]/RunOcrButton";
import { GeneratePdsPdfButton } from "@/app/review/[id]/GeneratePdsPdfButton";
import { formatIsoToDdMmYyyy } from "@/lib/pds/validators";
import { CommitEmployeePanel } from "@/app/review/[id]/CommitEmployeePanel";
import { AppointmentDetailsPanel } from "@/app/review/[id]/AppointmentDetailsPanel";
import { PdsPersonalInfoPanel } from "@/app/review/[id]/PdsPersonalInfoPanel";
import { cookies } from "next/headers";
import { SexConfirm } from "@/app/review/[id]/SexConfirm";
import { ExtractedPhotoPanel } from "@/app/review/[id]/ExtractedPhotoPanel";
import { DebugExtractionPanel } from "@/app/review/[id]/DebugExtractionPanel";
import { DocTypePanel } from "@/app/review/[id]/DocTypePanel";
import { canAccessReviewQueue } from "@/lib/auth/roles";
import { extractAppointmentFields } from "@/lib/appointment/fieldExtract";

export const dynamic = "force-dynamic";

function trimReview(s: unknown) {
  const t = String(s ?? "").trim();
  return t ? t : "";
}

function statusBadgeClass(status: unknown) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "committed") return "bg-app-success/10 text-app-success";
  if (normalized === "pending") return "bg-app-warning-muted text-app-warning";
  if (normalized === "extracted") return "bg-app-primary/10 text-app-primary";
  if (normalized === "failed" || normalized === "error") return "bg-app-danger-muted text-app-danger";
  return "bg-app-surface-muted text-app-muted";
}

/** Prefer committed owner_candidate; never clear UI when debug still has anchor lines (helps diagnose OCR). */
function pdsPersonalFieldsForDisplay(ex: any) {
  const raw = ex?.raw_extracted_json;
  const oc = raw?.owner_candidate || {};
  const ch = raw?.debug?.owner?.chosenCandidates;
  const tokens = raw?.debug?.owner?.selectedTokens;
  const fromTok = (sel: any) =>
    Array.isArray(sel) ? sel.map((t: any) => String(t?.text || "").trim()).filter(Boolean).join(" ").trim() : "";

  const last =
    trimReview(oc.last_name) ||
    trimReview(ch?.surname?.lineText) ||
    trimReview(fromTok(tokens?.surname));
  const first =
    trimReview(oc.first_name) ||
    trimReview(ch?.first_name?.lineText) ||
    trimReview(fromTok(tokens?.first_name));
  const middle =
    trimReview(oc.middle_name) ||
    trimReview(ch?.middle_name?.lineText) ||
    trimReview(fromTok(tokens?.middle_name));
  const dob = trimReview(oc.date_of_birth) || trimReview(raw?.debug?.dob?.parsedIso);
  const gender = trimReview(oc.gender) || trimReview(raw?.debug?.sex?.decision);

  return {
    last_name: last || null,
    first_name: first || null,
    middle_name: middle || null,
    date_of_birth: dob || null,
    gender: gender || null,
    /** True when we only have debug/anchor strings — Save to Masterlist still needs owner_candidate in JSON. */
    displayFromDebugOnly: Boolean(
      (!trimReview(oc.last_name) && !trimReview(oc.first_name) && (trimReview(ch?.surname?.lineText) || trimReview(ch?.first_name?.lineText))),
    ),
  };
}

function firstReviewValue<T>(...values: T[]) {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim()) return value;
      continue;
    }
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !canAccessReviewQueue(user)) {
    return (
      <AppShell
        title="Review extraction"
        description="Approved HR staff and administrators can verify extractions here."
      >
        <div className="app-card max-w-2xl p-5 sm:p-6 text-sm text-app-muted">
          Sign in with an approved account that can use the review queue, then open the row again from{" "}
          <strong className="text-app-text">Review queue</strong> in the menu.
        </div>
      </AppShell>
    );
  }

  const { data: extraction, error } = await supabase
    .from("extractions")
    .select(
      "id, status, raw_extracted_json, normalized_json, validated_json, warnings, errors, evidence, confidence, document_id, document_set_id, batch_id, linked_employee_id, doc_type_user_selected, doc_type_final, doc_type_detected, doc_type_mismatch_warning, appointment_data, extraction_debug"
    )
    .eq("id", id)
    .single();

  const cookieStore = await cookies();
  const normCookie = cookieStore.get("pds_normalize_legal")?.value;
  const normalizeEnabled = normCookie === null || normCookie === undefined ? true : normCookie === "1";
  const normDebug = (extraction as any)?.raw_extracted_json?.debug?.normalize;

  let originalSignedUrl: string | null = null;
  let originalInfo: { filename: string; mime: string } | null = null;
  let searchableSignedUrl: string | null = null;
  let linkedEmployeeIdFromDoc: string | null = null;
  let linkedEmployeeRecord: {
    id: string;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    date_of_birth: string | null;
  } | null = null;
  let originalDownloadHref: string | null = null;
  let searchableDownloadHref: string | null = null;
  let photoSourcePages: Array<{ pageIndex: number; label: string }> = [];

  if (!error && (extraction as any)?.linked_employee_id) {
    linkedEmployeeIdFromDoc = String((extraction as any).linked_employee_id);
  }

  if (!error && extraction?.document_id) {
    const { data: doc } = await supabase
      .from("employee_documents")
      .select("storage_bucket, storage_path, original_filename, mime_type, employee_id")
      .eq("id", extraction.document_id)
      .single();

    if (doc?.storage_bucket && doc?.storage_path) {
      originalInfo = { filename: doc.original_filename, mime: doc.mime_type };
      linkedEmployeeIdFromDoc = (doc as any).employee_id ? String((doc as any).employee_id) : linkedEmployeeIdFromDoc;
      const { data: signed } = await supabase.storage
        .from(doc.storage_bucket)
        .createSignedUrl(doc.storage_path, 60 * 10);
      originalSignedUrl = signed?.signedUrl ?? null;

      const qs = new URLSearchParams({
        bucket: String(doc.storage_bucket),
        path: String(doc.storage_path),
        filename: String(doc.original_filename || "original"),
        contentType: String(doc.mime_type || ""),
      });
      originalDownloadHref = `/api/files/download?${qs.toString()}`;
    }

    const searchable = (extraction as any)?.raw_extracted_json?.searchable_pdf;
    if (searchable?.storage_bucket && searchable?.storage_path) {
      const { data: signed } = await supabase.storage
        .from(String(searchable.storage_bucket))
        .createSignedUrl(String(searchable.storage_path), 60 * 10);
      searchableSignedUrl = signed?.signedUrl ?? null;

      const qs = new URLSearchParams({
        bucket: String(searchable.storage_bucket),
        path: String(searchable.storage_path),
        filename: String(searchable.filename || "searchable.pdf"),
        contentType: "application/pdf",
      });
      searchableDownloadHref = `/api/files/download?${qs.toString()}`;
    }

    const docSetId = (extraction as any)?.document_set_id ? String((extraction as any).document_set_id) : "";
    const batchId = (extraction as any)?.batch_id ? String((extraction as any).batch_id) : "";
    let pageRows: any[] = [];

    if (docSetId) {
      const { data } = await supabase
        .from("employee_documents")
        .select("page_index, original_filename")
        .eq("document_set_id", docSetId)
        .order("page_index", { ascending: true })
        .order("created_at", { ascending: true });
      pageRows = data || [];
    } else if (batchId) {
      const { data } = await supabase
        .from("employee_documents")
        .select("page_index, original_filename")
        .eq("batch_id", batchId)
        .order("page_index", { ascending: true })
        .order("created_at", { ascending: true });
      pageRows = data || [];
    }

    const seenPageIndexes = new Set<number>();
    photoSourcePages = (pageRows || [])
      .map((row: any) => ({
        pageIndex: Number(row?.page_index),
        label: `Page ${Number(row?.page_index) + 1}${row?.original_filename ? ` - ${String(row.original_filename)}` : ""}`,
      }))
      .filter((row) => Number.isFinite(row.pageIndex) && row.pageIndex >= 0)
      .filter((row) => {
        if (seenPageIndexes.has(row.pageIndex)) return false;
        seenPageIndexes.add(row.pageIndex);
        return true;
      });

    if (photoSourcePages.length === 0 && extraction?.document_id && originalInfo?.filename) {
      photoSourcePages = [{ pageIndex: 0, label: `Page 1 - ${originalInfo.filename}` }];
    }
  }

  if (!error && linkedEmployeeIdFromDoc) {
    const { data: employee } = await supabase
      .from("employees")
      .select("id, last_name, first_name, middle_name, date_of_birth")
      .eq("id", linkedEmployeeIdFromDoc)
      .single();

    if (employee?.id) {
      linkedEmployeeRecord = {
        id: String(employee.id),
        last_name: employee.last_name ?? null,
        first_name: employee.first_name ?? null,
        middle_name: employee.middle_name ?? null,
        date_of_birth: employee.date_of_birth ?? null,
      };
    }
  }

  const pdsPersonal = extraction && !error ? pdsPersonalFieldsForDisplay(extraction) : null;
  const appointmentDataForDisplay = extraction && !error
    ? (() => {
        const appointmentData = ((extraction as any)?.appointment_data ?? null) as any;
        const rawText = String((extraction as any)?.raw_extracted_json?.text || "").trim();
        const evidenceDates = (rawText.match(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/g) || []).slice(0, 30);
        const derivedAppointment = rawText ? extractAppointmentFields({ text: rawText }, { evidenceDates }) : null;

        const mergedAppointment = {
          owner: {
            last_name: firstReviewValue(appointmentData?.owner?.last_name, derivedAppointment?.owner?.last_name),
            first_name: firstReviewValue(appointmentData?.owner?.first_name, derivedAppointment?.owner?.first_name),
            middle_name: firstReviewValue(appointmentData?.owner?.middle_name, derivedAppointment?.owner?.middle_name),
            date_of_birth: firstReviewValue(appointmentData?.owner?.date_of_birth, (derivedAppointment as any)?.owner?.date_of_birth),
          },
          position_title: firstReviewValue(appointmentData?.position_title, derivedAppointment?.position_title),
          office_department: firstReviewValue(appointmentData?.office_department, derivedAppointment?.office_department),
          sg: firstReviewValue(appointmentData?.sg, derivedAppointment?.sg),
          step: firstReviewValue(appointmentData?.step, derivedAppointment?.step),
          monthly_salary: firstReviewValue(appointmentData?.monthly_salary, derivedAppointment?.monthly_salary),
          annual_salary: firstReviewValue(appointmentData?.annual_salary, derivedAppointment?.annual_salary),
          appointment_date: firstReviewValue(appointmentData?.appointment_date, derivedAppointment?.appointment_date),
          date_received: firstReviewValue(appointmentData?.date_received, derivedAppointment?.date_received),
          date_approved: firstReviewValue(appointmentData?.date_approved, derivedAppointment?.date_approved),
          plantilla_item_no: firstReviewValue(appointmentData?.plantilla_item_no, derivedAppointment?.plantilla_item_no),
          nature_of_appointment: firstReviewValue(appointmentData?.nature_of_appointment, derivedAppointment?.nature_of_appointment),
          status: firstReviewValue(appointmentData?.status, derivedAppointment?.status),
          sg_from_salary: Boolean(appointmentData?.sg_from_salary ?? derivedAppointment?.sg_from_salary ?? false),
        };

        if (!linkedEmployeeRecord) return mergedAppointment;

        const owner = mergedAppointment?.owner || null;
        const hasOwnerName = Boolean(trimReview(owner?.last_name) && trimReview(owner?.first_name));
        if (hasOwnerName) return mergedAppointment;

        return {
          ...mergedAppointment,
          owner: {
            last_name: linkedEmployeeRecord.last_name,
            first_name: linkedEmployeeRecord.first_name,
            middle_name: linkedEmployeeRecord.middle_name,
            date_of_birth: linkedEmployeeRecord.date_of_birth,
          },
        };
      })()
    : null;
  const genericOwner = extraction && !error
    ? (() => {
        const rawOwner = (extraction as any)?.raw_extracted_json?.owner_candidate || appointmentDataForDisplay?.owner || linkedEmployeeRecord || null;
        const last = String(rawOwner?.last_name || "").trim() || null;
        const first = String(rawOwner?.first_name || "").trim() || null;
        if (!last || !first) return null;
        return {
          last_name: last,
          first_name: first,
          middle_name: String(rawOwner?.middle_name || "").trim() || null,
          date_of_birth: String(rawOwner?.date_of_birth || "").trim() || null,
        };
      })()
    : null;

  return (
    <AppShell
      title="Review extraction"
      description="Check fields, run OCR if needed, then commit to the masterlist when the record is correct."
    >
      {error ? (
        <div className="app-alert-danger max-w-xl" role="alert">
          <p className="font-medium">We couldn’t load this extraction</p>
          <p className="mt-1 text-sm">{error.message}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="app-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-app-muted">Status</div>
              <div className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-sm font-semibold ${statusBadgeClass(extraction.status)}`}>
                {String(extraction.status)}
              </div>
            </div>
            <div className="app-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-app-muted">Document type</div>
              <div className="mt-2 text-sm font-semibold text-app-text">{String((extraction as any)?.doc_type_final || "Unknown")}</div>
            </div>
            <div className="app-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-app-muted">Masterlist link</div>
              <div className="mt-2 text-sm text-app-text">{linkedEmployeeIdFromDoc ? "Linked to employee" : "Not linked yet"}</div>
            </div>
          </div>

          {/* Document Type Section */}
          <DocTypePanel
            extractionId={id}
            docTypeUserSelected={(extraction as any)?.doc_type_user_selected}
            docTypeDetected={(extraction as any)?.doc_type_detected}
            docTypeFinal={(extraction as any)?.doc_type_final}
            docTypeMismatchWarning={Boolean((extraction as any)?.doc_type_mismatch_warning)}
          />

          {/* TYPE-SPECIFIC EXTRACTION PANELS */}
          {(extraction as any)?.doc_type_final === "appointment" ? (
            <AppointmentDetailsPanel
              extractionId={id}
              initialLinkedEmployeeId={linkedEmployeeIdFromDoc}
              initialAppointmentData={appointmentDataForDisplay}
            />
          ) : (extraction as any)?.doc_type_final === "pds" ? (
            <div className="grid gap-4">
              <PdsPersonalInfoPanel
                extractionId={id}
                initialLinkedEmployeeId={linkedEmployeeIdFromDoc}
                initialPersonalData={pdsPersonal}
              />

              <SexConfirm
                extractionId={id}
                canConfirm={Boolean(linkedEmployeeIdFromDoc)}
                initialValue={(pdsPersonal?.gender as "Male" | "Female" | null) || null}
                isConfirmed={Boolean((extraction as any).raw_extracted_json?.debug?.sex?.decision)}
              />

              <ExtractedPhotoPanel
                extractionId={id}
                initialEmployeeId={linkedEmployeeIdFromDoc}
                debugPhoto={(extraction as any).raw_extracted_json?.debug?.photo ?? null}
                sourcePages={photoSourcePages}
              />
            </div>
          ) : (
            /* ALL OTHER TYPES: Store only, no extraction */
            <div className="app-card p-4">
              <div className="text-sm font-semibold text-app-text">Document Storage</div>
              <div className="mt-2 text-xs text-app-muted">
                This document type is stored for reference only. No structured data extraction is performed.
              </div>
              <div className="mt-3 rounded-lg bg-app-surface-muted px-3 py-3 text-center ring-1 ring-app-border/45">
                <div className="text-xs text-app-text">
                  Document type:{" "}
                  <span className="font-semibold text-app-primary">{(extraction as any)?.doc_type_final || "Unknown"}</span>
                </div>
                <div className="mt-2 text-[11px] text-app-muted">
                  {genericOwner
                    ? "Owner was detected from this file or the same upload batch. You can link it to the correct employee below if needed."
                    : "Choose who owns this document below so it will be stored in that employee's Personal Info."}
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-app-primary/25 bg-app-primary/5 px-3 py-3">
                <div className="text-xs font-semibold text-app-text">Save to Masterlist</div>
                <div className="mt-1 text-[11px] text-app-muted">
                  {genericOwner
                    ? "Link this document to the employee record for the detected owner."
                    : "Search and select the employee who owns this document."}
                </div>
                <div className="mt-2">
                  <CommitEmployeePanel
                    extractionId={id}
                    initialLinkedEmployeeId={linkedEmployeeIdFromDoc}
                    owner={{
                      last_name: genericOwner?.last_name ?? null,
                      first_name: genericOwner?.first_name ?? null,
                      middle_name: genericOwner?.middle_name ?? null,
                      date_of_birth: genericOwner?.date_of_birth ?? null,
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Only show old Owner panel for PDS (already included above) or as fallback */}
          {(extraction as any)?.doc_type_final !== "appointment" && (extraction as any)?.doc_type_final !== "pds" && (
            <div className="app-card p-4">
              <div className="text-sm font-semibold text-app-text">Owner (OCR)</div>
              <div className="mt-2 grid gap-2 text-sm">
                <div className="rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/45">
                  {genericOwner ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
                        <div className="text-[11px] font-semibold text-app-text">Last name</div>
                        <div className="mt-0.5 text-xs text-app-text">{genericOwner.last_name}</div>
                      </div>
                      <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
                        <div className="text-[11px] font-semibold text-app-text">First name</div>
                        <div className="mt-0.5 text-xs text-app-text">{genericOwner.first_name}</div>
                      </div>
                      <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
                        <div className="text-[11px] font-semibold text-app-text">Middle name</div>
                        <div className="mt-0.5 text-xs text-app-text">{genericOwner.middle_name || "—"}</div>
                      </div>
                      <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
                        <div className="text-[11px] font-semibold text-app-text">Date of birth</div>
                        <div className="mt-0.5 text-xs text-app-text">{formatIsoToDdMmYyyy(genericOwner.date_of_birth)}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-app-muted">No owner was detected for this document yet</div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="app-card p-4">
            <div className="text-sm font-semibold text-app-text">Document actions</div>
            <div className="mt-2 grid gap-2 text-sm">
              <div className="flex flex-col gap-2 rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/45 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div>
                  <div className="font-medium text-app-text">OCR conversion</div>
                  <div className="text-xs text-app-muted">Run Google Document AI OCR and store extracted text</div>
                </div>
                <div className="self-start sm:self-auto">
                  <RunOcrButton extractionId={id} />
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/45 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div>
                  <div className="font-medium text-app-text">Printable export</div>
                  <div className="text-xs text-app-muted">Downloads a non-editable, printable output (image-based)</div>
                  {normalizeEnabled ? (
                    <div className="mt-1 text-[11px] text-app-muted">
                      Normalized to 8.5×13 (Legal)
                      {normDebug?.method ? ` • ${String(normDebug.method)}` : ""}
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-app-muted">Normalization: OFF</div>
                  )}
                </div>
                <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                  <GeneratePdsPdfButton
                    extractionId={id}
                    batchId={(extraction as any)?.batch_id ? String((extraction as any).batch_id) : null}
                    documentSetId={(extraction as any)?.document_set_id ? String((extraction as any).document_set_id) : null}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-app-primary/20 bg-app-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div>
                  <div className="font-medium text-app-text">Original upload</div>
                  <div className="text-xs text-app-muted">
                    {originalInfo ? `${originalInfo.filename} (${originalInfo.mime})` : "—"}
                  </div>
                </div>
                {originalSignedUrl ? (
                  <a
                    className="inline-flex rounded-lg bg-app-primary px-3 py-1.5 text-xs font-semibold text-app-on-primary transition-colors hover:bg-app-primary-hover"
                    href={originalDownloadHref || originalSignedUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-app-muted">No link</span>
                )}
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-app-success/35 bg-app-success-muted px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div>
                  <div className="font-medium text-app-success">Searchable PDF</div>
                  <div className="text-xs text-app-muted">Generated after OCR (scan/photo + invisible text layer)</div>
                </div>
                {searchableSignedUrl ? (
                  <a
                    className="inline-flex rounded-lg border border-app-success/40 bg-app-success/20 px-3 py-1.5 text-xs font-semibold text-app-success transition-colors hover:bg-app-success/30"
                    href={searchableDownloadHref || searchableSignedUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download searchable PDF
                  </a>
                ) : (
                  <span className="text-xs text-app-muted">No link yet (run OCR)</span>
                )}
              </div>

              <div className="flex flex-col gap-2 rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/45">
                <div>
                  <div className="font-medium text-app-text">Guides (blank PDS)</div>
                  <div className="text-xs text-app-muted">Open the official template to follow the correct format</div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <a
                    className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-text transition-colors hover:bg-app-surface-muted"
                    href="/guides/CS-Form-No.-212-Revised-2025-Personal-Data-Sheet.pdf"
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDS Guide 1
                  </a>
                  <a
                    className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-text transition-colors hover:bg-app-surface-muted"
                    href="/guides/CS-Form-No.-212-Revised-2025-Personal-Data-Sheet2.pdf"
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDS Guide 2
                  </a>
                  <a
                    className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-text transition-colors hover:bg-app-surface-muted"
                    href="/guides/CS-Form-No.-212-Revised-2025-Personal-Data-Sheet3.pdf"
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDS Guide 3
                  </a>
                  <a
                    className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-text transition-colors hover:bg-app-surface-muted"
                    href="/guides/CS-Form-No.-212-Revised-2025-Personal-Data-Sheet4.pdf"
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDS Guide 4
                  </a>
                </div>
              </div>
            </div>
          </div>

          <details className="app-card overflow-hidden">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-app-text">Technical debug</summary>
            <div className="border-t border-app-border p-4">
              <DebugExtractionPanel
                rawExtractedJson={extraction.raw_extracted_json}
                documentType={(extraction as any)?.document_type}
                appointmentData={(extraction as any)?.appointment_data}
                extractionDebug={(extraction as any)?.extraction_debug}
              />
            </div>
          </details>

          <details className="app-card overflow-hidden">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-app-text">Validated JSON</summary>
            <div className="border-t border-app-border p-4">
              <pre className="max-h-[400px] overflow-auto rounded-lg border border-app-border bg-app-bg p-2 text-xs text-app-text sm:p-3">
                {JSON.stringify(extraction.validated_json, null, 2)}
              </pre>
            </div>
          </details>
        </div>
      )}
    </AppShell>
  );
}

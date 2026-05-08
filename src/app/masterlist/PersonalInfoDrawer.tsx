"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { DocumentPreviewModal } from "@/components/DocumentPreviewModal";

type DrawerState =
  | { status: "closed" }
  | { status: "loading"; employeeId: string }
  | { status: "ready"; employeeId: string; payload: any }
  | { status: "error"; employeeId: string; message: string };

type DocumentCategory = "pds" | "appointment" | "oath" | "assumption" | "certification_lgu" | "nosa" | "nosi" | "ipcr" | "service_record" | "training" | "eligibility" | "photo" | "other";

interface CategorizedDocument {
  id: string;
  original_filename: string;
  mime_type: string;
  page_index?: number | null;
  signed_url?: string;
  document_category?: DocumentCategory | null;
  storage_bucket?: string;
  storage_path?: string;
  document_type?: string | null;
  doc_type?: string | null;
  document_set_id?: string | null;
  created_at?: string;
  detection_confidence?: number;
  download_url?: string | null;
  link_source?: string | null;
  extraction?: {
    id: string;
    status: string;
    document_type: string | null;
    appointment_data: any;
    created_at: string;
  } | null;
}

function getDocumentCategory(doc: any): DocumentCategory {
  // Use doc_type from database if available (from detection)
  const docType = doc.doc_type || doc.document_type || "";
  if (docType && docType !== "unknown") {
    return docType as DocumentCategory;
  }
  
  // Fallback to filename/mime detection
  const category = doc.document_category;
  const filename = String(doc.original_filename || "").toLowerCase();
  const mime = String(doc.mime_type || "").toLowerCase();
  
  if (category === "pds" || filename.includes("pds")) return "pds";
  if (category === "appointment" || filename.includes("appointment")) return "appointment";
  if (category === "certification_lgu" || filename.includes("certification")) return "certification_lgu";
  if (category === "oath" || filename.includes("oath")) return "oath";
  if (category === "assumption" || filename.includes("assumption")) return "assumption";
  if (category === "nosa" || filename.includes("nosa")) return "nosa";
  if (category === "nosi" || filename.includes("nosi")) return "nosi";
  if (category === "ipcr" || filename.includes("ipcr")) return "ipcr";
  if (category === "service_record" || filename.includes("service record") || filename.includes("coe")) return "service_record";
  if (category === "training" || filename.includes("training") || filename.includes("seminar")) return "training";
  if (category === "eligibility" || filename.includes("eligibility")) return "eligibility";
  if (mime.startsWith("image/") || filename.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/)) return "photo";
  return "other";
}

function getCategoryLabel(category: DocumentCategory): string {
  const labels: Record<DocumentCategory, string> = {
    pds: "PDS Documents",
    appointment: "Appointment Forms",
    oath: "Oath of Office",
    assumption: "Assumption to Duty",
    certification_lgu: "LGU Certification",
    nosa: "NOSA",
    nosi: "NOSI",
    ipcr: "IPCR",
    service_record: "Service Record / COE",
    training: "Training Certificates",
    eligibility: "Eligibility",
    photo: "Photos",
    other: "Other Documents",
  };
  return labels[category] || "Other Documents";
}

function getCategoryColor(category: DocumentCategory): string {
  const colors: Record<DocumentCategory, string> = {
    pds: "border-app-primary/25 bg-app-primary/5",
    appointment: "border-app-success/25 bg-app-success/8",
    oath: "border-app-primary/20 bg-app-surface-muted",
    assumption: "border-app-primary/20 bg-app-surface-muted",
    certification_lgu: "border-app-primary/20 bg-app-surface-muted",
    nosa: "border-app-warning/25 bg-app-warning-muted",
    nosi: "border-app-warning/25 bg-app-warning-muted",
    ipcr: "border-app-primary/20 bg-app-surface-muted",
    service_record: "border-app-primary/20 bg-app-surface-muted",
    training: "border-app-success/25 bg-app-success/8",
    eligibility: "border-app-primary/20 bg-app-surface-muted",
    photo: "border-app-primary/20 bg-app-surface-muted",
    other: "border-app-border bg-app-surface-muted",
  };
  return colors[category] || "border-app-border bg-app-surface-muted";
}

export function PersonalInfoDrawer({
  employeeId,
  onClose,
}: {
  employeeId: string | null;
  onClose: () => void;
}) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [state, setState] = useState<DrawerState>({ status: "closed" });
  const [uploadState, setUploadState] = useState<
    | { status: "idle" }
    | { status: "uploading"; message: string }
    | { status: "error"; message: string }
    | { status: "done" }
  >({ status: "idle" });

  const [previewModal, setPreviewModal] = useState<{
    open: boolean;
    title: string;
    imageUrl?: string;
    pageUrls?: string[];
    initialPage?: number;
  }>({ open: false, title: "" });

  useEffect(() => {
    if (!employeeId) {
      setState({ status: "closed" });
      setUploadState({ status: "idle" });
      return;
    }

    const employeeIdStr = employeeId;

    let cancelled = false;

    async function load() {
      setState({ status: "loading", employeeId: employeeIdStr });
      try {
        const url = `${window.location.origin}/api/masterlist/employee/${employeeIdStr}`;
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        const text = await res.text();
        if (!res.ok) throw new Error(text || res.statusText);
        const payload = JSON.parse(text);
        if (cancelled) return;
        setState({ status: "ready", employeeId: employeeIdStr, payload });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (cancelled) return;
        setState({ status: "error", employeeId: employeeIdStr, message: msg });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const open = !!employeeId && state.status !== "closed";

  async function onUploadPhoto(file: File) {
    if (!employeeId) return;
    const employeeIdStr = employeeId;

    try {
      setUploadState({ status: "uploading", message: "Uploading photo..." });

      const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
      const safeExt = (ext || "bin").toLowerCase();
      const filename = `${crypto.randomUUID()}.${safeExt}`;
      const path = `photos/${employeeIdStr}/${new Date().toISOString().slice(0, 10)}/${filename}`;

      const { error: uploadError } = await supabase.storage
        .from("hr-documents")
        .upload(path, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

      if (uploadError) throw new Error(uploadError.message);

      setUploadState({ status: "uploading", message: "Linking photo to employee..." });

      const res = await fetch(`${window.location.origin}/api/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          storage_bucket: "hr-documents",
          storage_path: path,
          mime_type: file.type || "application/octet-stream",
          original_filename: file.name,
          file_size_bytes: file.size,
          employee_id: employeeIdStr,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }

      setUploadState({ status: "done" });

      // Reload drawer data.
      const url = `${window.location.origin}/api/masterlist/employee/${employeeIdStr}`;
      const reload = await fetch(url, { credentials: "include", cache: "no-store" });
      const text = await reload.text();
      if (reload.ok) {
        setState({ status: "ready", employeeId: employeeIdStr, payload: JSON.parse(text) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadState({ status: "error", message: msg });
    }
  }

  const payload = state.status === "ready" ? state.payload : null;
  const employee = payload?.employee ?? null;
  const photo = payload?.photo ?? null;
  const documents = Array.isArray(payload?.documents) ? (payload.documents as any[]) : [];

  const fullName = employee
    ? `${employee.last_name || ""}, ${employee.first_name || ""}${employee.middle_name ? ` ${employee.middle_name}` : ""}${employee.name_extension ? ` ${employee.name_extension}` : ""}`.trim()
    : "";

  const tenure = useMemo(() => {
    const dateHired = employee?.date_hired ? String(employee.date_hired) : "";
    if (!dateHired) return null;
    const t = Date.parse(dateHired);
    if (!Number.isFinite(t)) return null;
    const now = Date.now();
    const days = Math.max(0, Math.floor((now - t) / (1000 * 60 * 60 * 24)));
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    const remDays = days - years * 365 - months * 30;
    return { years, months, days: remDays };
  }, [employee?.date_hired]);

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-black/30 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />

      <div
        className={`absolute right-0 top-0 h-full w-full max-w-[420px] border-l border-app-border bg-app-surface shadow-xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-app-text">Personal Info</div>
            <div className="text-xs text-app-muted">{employee ? fullName : ""}</div>
          </div>
          <button
            type="button"
            className="app-btn-secondary rounded-md px-2 py-1 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="h-[calc(100%-52px)] overflow-auto px-4 py-4">
          {state.status === "loading" ? (
            <div className="text-sm text-app-muted">Loading…</div>
          ) : null}

          {state.status === "error" ? (
            <div className="app-alert-danger rounded-md px-3 py-2 text-sm">
              {state.message}
            </div>
          ) : null}

          {state.status === "ready" && employee ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-app-border bg-app-surface-muted p-3">
                <div className="text-xs font-semibold text-app-text">Photo</div>
                <div className="mt-2">
                  {photo?.signed_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photo.signed_url}
                      alt="Employee photo"
                      className="h-40 w-40 rounded-lg border border-app-border object-cover"
                    />
                  ) : (
                    <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-app-border bg-app-surface text-xs text-app-muted">
                      No photo
                    </div>
                  )}
                </div>

                <div className="mt-3">
                  <label className="inline-block">
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        if (f) onUploadPhoto(f);
                        e.currentTarget.value = "";
                      }}
                    />
                    <span className="app-btn-secondary inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-xs font-semibold">
                      Upload photo
                    </span>
                  </label>
                </div>

                {uploadState.status === "uploading" ? (
                  <div className="mt-2 text-xs text-app-muted">{uploadState.message}</div>
                ) : null}
                {uploadState.status === "error" ? (
                  <div className="mt-2 text-xs text-app-danger">{uploadState.message}</div>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-2">
                <InfoRow label="Full name" value={fullName} />
                <InfoRow label="Birthdate" value={employee.date_of_birth_display || ""} />
                <InfoRow label="Age" value={employee.age_final ?? ""} />
                <InfoRow
                  label="Tenure"
                  value={tenure ? `${tenure.years}y ${tenure.months}m ${tenure.days}d` : employee?.date_hired ? "—" : ""}
                />
                <InfoRow label="Position title" value={employee.position_title || ""} />
                <InfoRow label="Office" value={employee.office_department || ""} />
                <InfoRow label="Salary Grade (SG)" value={employee.sg ?? ""} />
                <InfoRow label="Monthly salary" value={employee.monthly_salary ?? ""} />
                <InfoRow label="Annual salary" value={employee.annual_salary ?? ""} />
                <InfoRow label="Gender" value={employee.gender ?? ""} />
              </div>

              <div className="rounded-lg border border-app-border bg-app-surface-muted p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-app-text">Uploaded files</div>
                  {documents.length > 0 && (
                    <button
                      type="button"
                      className="app-btn-secondary inline-flex items-center rounded px-2 py-1 text-[10px]"
                      onClick={() => {
                        const url = `/api/documents/download?employee_id=${employeeId}&doc_type=all&format=zip`;
                        window.open(url, "_blank");
                      }}
                      title="Download all documents as ZIP"
                    >
                      ↓ All ZIP
                    </button>
                  )}
                </div>
                {documents.length === 0 ? (
                  <div className="mt-2 text-xs text-app-muted">No uploaded files linked to this employee yet.</div>
                ) : (
                  <div className="mt-2 flex flex-col gap-3">
                    {(() => {
                      // Group documents by document_set_id first
                      const setGroups = documents.reduce((acc: Record<string, CategorizedDocument[]>, d: CategorizedDocument) => {
                        const setId = d.document_set_id || `single_${d.id}`;
                        if (!acc[setId]) acc[setId] = [];
                        acc[setId].push(d);
                        return acc;
                      }, {} as Record<string, CategorizedDocument[]>);

                      // Convert to document set entries
                      interface DocSet {
                        id: string;
                        category: DocumentCategory;
                        docs: CategorizedDocument[];
                        pageCount: number;
                        isMultiPage: boolean;
                        firstDoc: CategorizedDocument;
                      }

                      const docSets: DocSet[] = Object.keys(setGroups).map((setId) => {
                        const docs = setGroups[setId];
                        const sorted = docs.sort((a: CategorizedDocument, b: CategorizedDocument) => (a.page_index ?? 0) - (b.page_index ?? 0));
                        const firstDoc = sorted[0];
                        const cat = getDocumentCategory(firstDoc);
                        return {
                          id: setId,
                          category: cat,
                          docs: sorted,
                          pageCount: sorted.length,
                          isMultiPage: sorted.length > 1,
                          firstDoc,
                        };
                      });

                      // Group by category
                      const byCategory = docSets.reduce((acc, set) => {
                        if (!acc[set.category]) acc[set.category] = [];
                        acc[set.category].push(set);
                        return acc;
                      }, {} as Record<DocumentCategory, typeof docSets>);

                      const categories: DocumentCategory[] = ["pds", "appointment", "oath", "assumption", "certification_lgu", "nosa", "nosi", "ipcr", "service_record", "training", "eligibility", "photo", "other"];

                      return categories
                        .filter((cat) => byCategory[cat]?.length > 0)
                        .map((cat) => (
                          <div key={cat} className={`rounded-lg border p-2 ${getCategoryColor(cat)}`}>
                            <div className="mb-2 flex items-center justify-between">
                              <div className="text-xs font-semibold text-app-text">{getCategoryLabel(cat)}</div>
                              <div className="flex items-center gap-2">
                                <div className="text-[10px] text-app-muted">{byCategory[cat].length} doc(s)</div>
                                <button
                                  type="button"
                                  className="app-btn-secondary inline-flex items-center rounded px-1.5 py-0.5 text-[10px]"
                                  onClick={() => {
                                    const url = `/api/documents/download?employee_id=${employeeId}&doc_type=${cat}&format=zip`;
                                    window.open(url, "_blank");
                                  }}
                                  title={`Download all ${getCategoryLabel(cat)} as ZIP`}
                                >
                                  ↓ ZIP
                                </button>
                              </div>
                            </div>
                            <div className="grid gap-2">
                              {byCategory[cat].map((set) => {
                                const extractionTypeBadgeClass = set.firstDoc.extraction?.document_type
                                  ? "rounded bg-app-primary/10 px-1 py-0.5 text-[9px] text-app-primary"
                                  : "";
                                const extractionStatusBadgeClass = set.firstDoc.extraction?.status === "committed"
                                  ? "rounded bg-app-success/10 px-1 py-0.5 text-[9px] text-app-success"
                                  : set.firstDoc.extraction?.status === "extracted"
                                    ? "rounded bg-app-warning-muted px-1 py-0.5 text-[9px] text-app-warning"
                                    : "rounded bg-app-surface px-1 py-0.5 text-[9px] text-app-muted";
                                return (
                                <div key={set.id} className="rounded-md border border-app-border bg-app-surface px-2 py-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-xs font-semibold text-app-text" title={set.firstDoc.original_filename}>
                                        {set.isMultiPage 
                                          ? `Document Set (${set.pageCount} pages)`
                                          : (set.firstDoc.original_filename || `Document ${set.firstDoc.id}`)
                                        }
                                      </div>
                                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-app-muted">
                                        <span>{set.firstDoc.mime_type ? String(set.firstDoc.mime_type).split("/")[1]?.toUpperCase() : "FILE"}</span>
                                        {set.isMultiPage && (
                                          <span className="rounded bg-app-surface px-1 py-0.5 text-[9px] text-app-muted">{set.pageCount} pages</span>
                                        )}
                                        {!set.isMultiPage && set.firstDoc.page_index !== null && (
                                          <span>• Page {Number(set.firstDoc.page_index) + 1}</span>
                                        )}
                                        {set.firstDoc.extraction?.document_type && (
                                          <span className={extractionTypeBadgeClass}>
                                            {set.firstDoc.extraction.document_type}
                                          </span>
                                        )}
                                        {set.firstDoc.extraction?.status && (
                                          <span className={extractionStatusBadgeClass}>
                                            {set.firstDoc.extraction.status}
                                          </span>
                                        )}
                                      </div>
                                      {set.firstDoc.extraction?.appointment_data && (
                                        <div className="mt-1 text-[9px] text-app-muted">
                                          {set.firstDoc.extraction.appointment_data.position_title && (
                                            <div>Position: {set.firstDoc.extraction.appointment_data.position_title}</div>
                                          )}
                                          {set.firstDoc.extraction.appointment_data.office_department && (
                                            <div>Office: {set.firstDoc.extraction.appointment_data.office_department}</div>
                                          )}
                                          {set.firstDoc.extraction.appointment_data.sg && (
                                            <div>SG: {set.firstDoc.extraction.appointment_data.sg}</div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {set.firstDoc.signed_url && (
                                      <>
                                        <button
                                          type="button"
                                          className="app-btn-primary inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold"
                                          onClick={() => {
                                            const isPdfSet = set.docs.every((d: CategorizedDocument) => String(d.mime_type || "").toLowerCase() === "application/pdf");
                                            const urls = set.docs.map((d: CategorizedDocument) => d.signed_url).filter(Boolean) as string[];
                                            if (isPdfSet && set.docs[0]?.download_url) {
                                              window.open(String(set.docs[0].download_url), "_blank", "noopener,noreferrer");
                                              return;
                                            }
                                            setPreviewModal({
                                              open: true,
                                              title: set.isMultiPage 
                                                ? `Document Preview (${set.pageCount} pages)`
                                                : (set.firstDoc.original_filename || "Document Preview"),
                                              pageUrls: set.isMultiPage ? urls : undefined,
                                              imageUrl: !set.isMultiPage ? urls[0] : undefined,
                                              initialPage: 0,
                                            });
                                          }}
                                        >
                                          {set.isMultiPage ? "View All" : "View"}
                                        </button>
                                        {!set.isMultiPage && (
                                          <a
                                            className="app-btn-secondary inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold"
                                            href={String(set.firstDoc.download_url || set.firstDoc.signed_url)}
                                            target="_blank"
                                            rel="noreferrer"
                                            download={set.firstDoc.original_filename}
                                          >
                                            Download
                                          </a>
                                        )}
                                        {set.isMultiPage && (
                                          <select
                                            className="rounded border border-app-border bg-app-surface px-1 py-1 text-[10px] text-app-text"
                                            onChange={(e) => {
                                              const idx = Number(e.target.value);
                                              if (!isNaN(idx) && (set.docs[idx]?.download_url || set.docs[idx]?.signed_url)) {
                                                const link = document.createElement("a");
                                                link.href = String(set.docs[idx].download_url || set.docs[idx].signed_url);
                                                link.download = set.docs[idx].original_filename || `page_${idx + 1}`;
                                                link.target = "_blank";
                                                link.rel = "noreferrer";
                                                link.click();
                                              }
                                            }}
                                            defaultValue=""
                                          >
                                            <option value="" disabled>Download page...</option>
                                            {set.docs.map((d: CategorizedDocument, i: number) => (
                                              <option key={d.id} value={i}>
                                                Page {i + 1}
                                              </option>
                                            ))}
                                          </select>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              )})}
                            </div>
                          </div>
                        ));
                    })()}
                  </div>
                )}
              </div>

              <DocumentPreviewModal
                open={previewModal.open}
                onClose={() => setPreviewModal({ open: false, title: "" })}
                title={previewModal.title}
                imageUrl={previewModal.imageUrl}
                pageUrls={previewModal.pageUrls}
                initialPage={previewModal.initialPage}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-lg border border-app-border bg-app-surface px-3 py-2">
      <div className="text-[11px] font-semibold text-app-text">{label}</div>
      <div className="mt-0.5 text-sm text-app-text">{value === null || value === undefined ? "" : String(value)}</div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

function isBlockedUploadFilename(name: string) {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".json") ||
    lower.endsWith(".env") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12")
  );
}

type UploadState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "done"; batchId: string; extractionIds: string[] }
  | { status: "error"; message: string };

type FileRow = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  extractionId?: string;
};

const DOCUMENT_TYPE_OPTIONS = [
  { value: "auto-detect", label: "Auto-detect (recommended)" },
  { value: "pds", label: "PDS (CS Form 212)" },
  { value: "appointment", label: "Appointment" },
  { value: "oath", label: "Oath" },
  { value: "assumption", label: "Assumption" },
  { value: "certification_lgu", label: "Certification for LGU Appointments" },
  { value: "service_record", label: "COE / Service Record" },
  { value: "training", label: "Trainings / L&D" },
  { value: "eligibility", label: "Eligibility" },
  { value: "ipcr", label: "IPCR" },
  { value: "nosa", label: "NOSA" },
  { value: "nosi", label: "NOSI" },
  { value: "other", label: "Other / Unknown" },
];

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const q = items.slice();
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (q.length > 0) {
      const next = q.shift();
      if (!next) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

function uploadOneWithProgress(opts: {
  file: File;
  batchId: string;
  pageIndex: number;
  extractionId?: string | null;
  documentSetId?: string | null;
  docTypeUserSelected: string | null;
  accessToken: string | null;
  onProgress: (p: number) => void;
}): Promise<{ extraction_id: string; document_set_id: string | null }>
{
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload/file");
    xhr.withCredentials = true;

    if (opts.accessToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${opts.accessToken}`);
    }

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const p = Math.max(0, Math.min(1, evt.loaded / Math.max(1, evt.total)));
      opts.onProgress(p);
    };

    xhr.onload = () => {
      try {
        const text = xhr.responseText || "";
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(text || `Upload failed (${xhr.status})`));
          return;
        }
        const json = JSON.parse(text);
        const extractionId = String(json.extraction_id || "");
        const documentSetId = json.document_set_id ? String(json.document_set_id) : null;
        if (!extractionId) {
          reject(new Error("Upload succeeded but no extraction_id returned"));
          return;
        }
        resolve({ extraction_id: extractionId, document_set_id: documentSetId });
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Failed to parse upload response"));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));

    const fd = new FormData();
    fd.append("file", opts.file);
    fd.append("batch_id", opts.batchId);
    fd.append("page_index", String(opts.pageIndex));
    if (opts.extractionId) fd.append("extraction_id", String(opts.extractionId));
    if (opts.documentSetId) fd.append("document_set_id", String(opts.documentSetId));
    if (opts.docTypeUserSelected) fd.append("doc_type_user_selected", opts.docTypeUserSelected);
    fd.append("original_filename", opts.file.name);
    fd.append("mime_type", opts.file.type || "application/octet-stream");
    fd.append("file_size_bytes", String(opts.file.size || 0));

    xhr.send(fd);
  });
}

export function UploadClient() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string>("");
  const [rows, setRows] = useState<FileRow[]>([]);
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [docTypeUserSelected, setDocTypeUserSelected] = useState<string>("auto-detect");
  const [separateExtractionPerFile, setSeparateExtractionPerFile] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setAccessToken(data.session?.access_token ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setAccessToken(session?.access_token ?? null);
    });

    return () => {
      cancelled = true;
      try {
        sub.subscription.unsubscribe();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    // Avoid hydration mismatch: generate UUID only after the component mounts.
    if (!batchId) setBatchId(crypto.randomUUID());
  }, [batchId]);

  useEffect(() => {
    // New selection batch when clearing selection.
    if (rows.length === 0) setBatchId(crypto.randomUUID());
  }, [rows.length]);

  const doneCount = rows.filter((r) => r.status === "done").length;
  const errorCount = rows.filter((r) => r.status === "error").length;
  const showAutoSplitHint = docTypeUserSelected === "auto-detect" && rows.length > 1;

  async function onUpload(e?: React.FormEvent) {
    e?.preventDefault();

    if (rows.length === 0) {
      setState({ status: "error", message: "Please choose a file first." });
      return;
    }

    try {
      setState({ status: "uploading" });

      if (!accessToken) {
        setState({ status: "error", message: "You are not logged in. Please log in, then try again." });
        setRows((prev) => prev.map((r) => ({ ...r, status: "error", error: "Unauthorized (not logged in)" })));
        return;
      }

      const effectiveBatchId = batchId || crypto.randomUUID();
      if (!batchId) setBatchId(effectiveBatchId);

      // Validate upfront (fast fail)
      const blocked = rows.filter((r) => isBlockedUploadFilename(r.file.name));
      if (blocked.length > 0) {
        setState({
          status: "error",
          message:
            "One or more selected files are blocked for security (possible credentials). Please upload scanned photos (JPG/PNG) or PDF.",
        });
        setRows((prev) =>
          prev.map((r) =>
            isBlockedUploadFilename(r.file.name)
              ? { ...r, status: "error", error: "Blocked file type" }
              : r
          )
        );
        return;
      }

      const allowed = rows.filter((r) => {
        const mt = (r.file.type || "").toLowerCase();
        return mt.startsWith("image/") || mt === "application/pdf";
      });

      const rejected = rows.filter((r) => !allowed.includes(r));
      if (rejected.length > 0) {
        setRows((prev) =>
          prev.map((r) =>
            rejected.some((x) => x.id === r.id)
              ? { ...r, status: "error", error: `Unsupported type: ${r.file.type || "(unknown)"}` }
              : r
          )
        );
      }

      const toUpload = allowed.filter((r) => r.status === "queued" || r.status === "error");
      const pageIndexById = new Map<string, number>();
      for (let i = 0; i < rows.length; i++) pageIndexById.set(rows[i].id, i + 1);
      const autoSegregateMixed = docTypeUserSelected === "auto-detect" && toUpload.length > 1;
      const shouldSeparatePerFile = separateExtractionPerFile || autoSegregateMixed;
      let batchExtractionId: string | null = null;
      let batchDocumentSetId: string | null = null;
      const extractionIds: string[] = [];

      const first = toUpload[0] ?? null;
      const rest = toUpload.slice(1);

      if (first) {
        setRows((prev) => prev.map((r) => (r.id === first.id ? { ...r, status: "uploading", progress: 0 } : r)));
        try {
          const idx = pageIndexById.get(first.id) ?? 1;
          const res = await uploadOneWithProgress({
            file: first.file,
            batchId: effectiveBatchId,
            pageIndex: idx,
            extractionId: null,
            documentSetId: null,
            docTypeUserSelected: docTypeUserSelected === "auto-detect" ? null : docTypeUserSelected,
            accessToken,
            onProgress: (p) => {
              setRows((prev) => prev.map((r) => (r.id === first.id ? { ...r, progress: p } : r)));
            },
          });
          batchExtractionId = res.extraction_id;
          batchDocumentSetId = res.document_set_id;
          extractionIds.push(res.extraction_id);
          setRows((prev) =>
            prev.map((r) => (r.id === first.id ? { ...r, status: "done", progress: 1, extractionId: res.extraction_id } : r))
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setRows((prev) => prev.map((r) => (r.id === first.id ? { ...r, status: "error", error: msg } : r)));
          setState({ status: "error", message: msg });
          return;
        }
      }

      await runWithConcurrency(rest, 5, async (row) => {
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "uploading", progress: 0 } : r)));
        try {
          const idx = pageIndexById.get(row.id) ?? 1;
          const res = await uploadOneWithProgress({
            file: row.file,
            batchId: effectiveBatchId,
            pageIndex: idx,
            extractionId: shouldSeparatePerFile ? null : batchExtractionId,
            documentSetId: shouldSeparatePerFile ? null : batchDocumentSetId,
            docTypeUserSelected: docTypeUserSelected === "auto-detect" ? null : docTypeUserSelected,
            accessToken,
            onProgress: (p) => {
              setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, progress: p } : r)));
            },
          });
          extractionIds.push(res.extraction_id);
          setRows((prev) =>
            prev.map((r) => (r.id === row.id ? { ...r, status: "done", progress: 1, extractionId: res.extraction_id } : r))
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "error", error: msg } : r)));
        }
      });

      setState({ status: "done", batchId: effectiveBatchId, extractionIds });
    } catch (err) {
      console.error(err);
      setState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to fetch. Check if /api/intake is reachable and you are logged in.",
      });
    }
  }

  return (
    <div className="app-card p-6 sm:p-8">
      <h2 className="text-base font-semibold text-app-text">Upload document</h2>
      <p className="app-prose-muted mt-1">Choose a document type, add files, then send them to the review queue.</p>

      <form className="mt-6 flex flex-col gap-4" onSubmit={onUpload}>
        {showAutoSplitHint ? (
          <div className="app-alert-info">
            Mixed uploads are detected automatically. Each file will be kept separate so the correct owner can be reviewed.
          </div>
        ) : null}

        <div className="rounded-xl border border-app-border bg-app-surface-muted p-4">
          <label className="block text-xs font-semibold uppercase tracking-wide text-app-muted">
            Document type <span className="text-app-danger">*</span>
          </label>
          <select
            value={docTypeUserSelected}
            onChange={(e) => setDocTypeUserSelected(e.target.value)}
            className="app-input mt-2"
            required
          >
            {DOCUMENT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="app-prose-muted mt-2 text-xs">
            {docTypeUserSelected === "auto-detect"
              ? "The system detects the document type automatically. Use for mixed or unknown files."
              : "Detection is skipped; fields are extracted for the selected type only."}
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-muted/80 p-4">
          <input
            type="checkbox"
            id="separate-extraction"
            checked={separateExtractionPerFile}
            onChange={(e) => setSeparateExtractionPerFile(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-app-border text-app-primary focus:ring-app-ring"
          />
          <label htmlFor="separate-extraction" className="text-sm text-app-text">
            <span className="font-medium">Keep each file separate</span>
            <span className="app-prose-muted mt-0.5 block text-xs">
              Turn this on if each uploaded file belongs to a different document record.
            </span>
          </label>
        </div>

        <div className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <label className="block text-xs font-semibold uppercase tracking-wide text-app-muted">Files</label>
            {rows.length > 0 ? (
              <button
                type="button"
                className="app-btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  setRows([]);
                  setState({ status: "idle" });
                }}
              >
                Clear selection
              </button>
            ) : null}
          </div>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,application/pdf"
            disabled={!docTypeUserSelected}
            onChange={(e) => {
              const files = Array.from(e.target.files || []).sort((a, b) =>
                String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" })
              );
              const next: FileRow[] = files.map((f) => ({
                id: crypto.randomUUID(),
                file: f,
                status: "queued",
                progress: 0,
              }));
              setRows(next);
              setState({ status: "idle" });
            }}
            className="mt-3 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-app-primary/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-app-primary hover:file:bg-app-primary/20 disabled:opacity-50"
          />
          {!docTypeUserSelected && <p className="mt-2 text-xs text-app-warning">Select a document type first.</p>}
        </div>

        <div className="app-table-wrap max-h-[min(18rem,50vh)] overflow-hidden">
          <div className="app-card-header flex items-center justify-between gap-3">
            <span>Selected files</span>
            <span className="text-xs font-medium text-app-muted">{rows.length}</span>
          </div>
          <div className="max-h-[240px] divide-y divide-app-border overflow-auto">
            {rows.length === 0 ? (
              <div className="px-4 py-4 text-sm text-app-muted">No files selected.</div>
            ) : (
              rows.map((r) => (
                <div key={r.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-app-text">{r.file.name}</div>
                      <div className="mt-0.5 text-xs text-app-muted">
                        {r.file.type || "(unknown type)"} · {formatBytes(r.file.size)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-medium capitalize text-app-muted">
                      {r.status === "uploading" ? `${Math.round(r.progress * 100)}%` : r.status}
                    </div>
                  </div>
                  {r.status === "uploading" ? (
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-app-surface-muted">
                      <div
                        className="h-full rounded-full bg-app-primary transition-[width]"
                        style={{ width: `${Math.round(r.progress * 100)}%` }}
                      />
                    </div>
                  ) : null}
                  {r.status === "error" && r.error ? (
                    <div className="mt-2 text-xs font-medium text-app-danger">{r.error}</div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-app-muted">
            {rows.length > 0 ? `${rows.length} file${rows.length === 1 ? "" : "s"} selected` : "Add files to start"}
            {doneCount > 0 ? ` · ${doneCount} ready` : ""}
            {errorCount > 0 ? ` · ${errorCount} issue${errorCount === 1 ? "" : "s"}` : ""}
          </div>
          <button
            type="submit"
            disabled={state.status === "uploading" || !docTypeUserSelected || rows.length === 0}
            className="app-btn-primary w-full py-3 sm:w-auto sm:min-w-[220px]"
          >
            {state.status === "uploading" ? "Uploading…" : "Upload files"}
          </button>
        </div>

        {state.status === "done" ? (
          <div className="rounded-xl border border-app-success/30 bg-app-success-muted px-4 py-3 text-sm text-app-success">
            <p>
              {state.extractionIds.length} extraction{state.extractionIds.length === 1 ? "" : "s"} ready for review.
            </p>
            <a className="app-link mt-2 inline-block text-sm" href="/review">
              Go to review queue →
            </a>
          </div>
        ) : null}

        {state.status === "error" ? <div className="app-alert-warning">{state.message}</div> : null}
      </form>
    </div>
  );
}

import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ExtractionRow } from "@/lib/types";

function statusBadgeClass(status: string) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "committed") return "bg-app-success/10 text-app-success";
  if (normalized === "pending") return "bg-app-warning-muted text-app-warning";
  if (normalized === "extracted") return "bg-app-primary/10 text-app-primary";
  if (normalized === "failed" || normalized === "error") return "bg-app-danger-muted text-app-danger";
  return "bg-app-surface text-app-muted";
}

export async function ReviewList() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("extractions")
    .select("id, document_id, status, quality_score, warnings, errors, created_at, updated_at, batch_id, document_set_id, created_by")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return <div className="app-alert-danger text-sm">Error: {error.message}</div>;
  }

  const rows = (data || []) as (ExtractionRow & { batch_id?: string | null; document_set_id?: string | null; created_by?: string | null })[];

  // Group by batch_id first so bulk uploads stay together in the queue,
  // otherwise fall back to document_set_id for single document groups.
  const byGroupKey = new Map<
    string,
    {
      kind: "document_set" | "batch";
      id: string;
      group: typeof rows;
    }
  >();
  const singles: typeof rows = [];

  for (const r of rows) {
    const ds = (r as any).document_set_id ? String((r as any).document_set_id) : "";
    const b = (r as any).batch_id ? String((r as any).batch_id) : "";

    if (b) {
      const k = `batch:${b}`;
      const existing = byGroupKey.get(k);
      if (existing) existing.group.push(r);
      else byGroupKey.set(k, { kind: "batch", id: b, group: [r] });
      continue;
    }

    if (ds) {
      const k = `ds:${ds}`;
      const existing = byGroupKey.get(k);
      if (existing) existing.group.push(r);
      else byGroupKey.set(k, { kind: "document_set", id: ds, group: [r] });
      continue;
    }

    singles.push(r);
  }

  // Compute page/file counts from employee_documents.
  const documentSetIds = Array.from(
    new Set(
      rows
        .filter((r) => !(r as any).batch_id)
        .map((r) => ((r as any).document_set_id ? String((r as any).document_set_id) : ""))
        .filter(Boolean)
    )
  );
  const batchIds = Array.from(
    new Set(
      rows.map((r) => ((r as any).batch_id ? String((r as any).batch_id) : "")).filter(Boolean)
    )
  );

  const countsByDs = new Map<string, number>();
  const countsByBatch = new Map<string, number>();

  if (documentSetIds.length > 0) {
    const { data: docs } = await supabase
      .from("employee_documents")
      .select("id, document_set_id")
      .in("document_set_id", documentSetIds);
    for (const d of docs || []) {
      const id = d.document_set_id ? String(d.document_set_id) : "";
      if (!id) continue;
      countsByDs.set(id, (countsByDs.get(id) || 0) + 1);
    }
  }

  if (batchIds.length > 0) {
    const { data: docs } = await supabase.from("employee_documents").select("id, batch_id").in("batch_id", batchIds);
    for (const d of docs || []) {
      const id = d.batch_id ? String(d.batch_id) : "";
      if (!id) continue;
      countsByBatch.set(id, (countsByBatch.get(id) || 0) + 1);
    }
  }

  const groups = Array.from(byGroupKey.values())
    .map((g) => ({
      ...g,
      group: g.group.slice().sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
      fileCount:
        g.kind === "document_set" ? countsByDs.get(g.id) || g.group.length : countsByBatch.get(g.id) || g.group.length,
    }))
    .sort((a, b) => {
      const aT = a.group[a.group.length - 1]?.updated_at || a.group[a.group.length - 1]?.created_at;
      const bT = b.group[b.group.length - 1]?.updated_at || b.group[b.group.length - 1]?.created_at;
      return +new Date(String(bT)) - +new Date(String(aT));
    });

  const totalGroups = groups.length + singles.length;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="app-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-app-muted">Queue groups</div>
          <div className="mt-2 text-2xl font-semibold text-app-text">{totalGroups}</div>
        </div>
        <div className="app-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-app-muted">Extractions</div>
          <div className="mt-2 text-2xl font-semibold text-app-text">{rows.length}</div>
        </div>
        <div className="app-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-app-muted">Latest activity</div>
          <div className="mt-2 text-sm text-app-text">
            {rows[0]?.updated_at ? new Date(rows[0].updated_at).toLocaleString() : "No activity yet"}
          </div>
        </div>
      </div>

      <div className="app-card overflow-hidden">
      <div className="app-card-header">Latest extractions</div>
      <div className="divide-y divide-app-border">
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-sm text-app-muted">No extractions yet.</div>
        ) : (
          <>
            {groups.map(({ kind, id, group, fileCount }: { kind: "document_set" | "batch"; id: string; group: typeof rows; fileCount: number }) => (
              <details key={`${kind}:${id}`} className="group px-4 py-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-app-text">
                          {kind === "document_set" ? "Document set" : "Batch upload"}
                        </div>
                        <span className="rounded-full bg-app-surface-muted px-2 py-0.5 text-[11px] font-medium text-app-muted">
                          {fileCount} file{fileCount === 1 ? "" : "s"}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(String(group[group.length - 1]?.status || "uploaded"))}`}>
                          {String(group[group.length - 1]?.status || "uploaded")}
                        </span>
                      </div>
                      <div className="text-xs text-app-muted">
                        Updated {new Date(group[group.length - 1].updated_at).toLocaleString()}
                      </div>
                    </div>
                    <Link className="app-btn-secondary shrink-0 px-3 py-2 text-sm" href={`/review/${group[0].id}`}>
                      Open
                    </Link>
                  </div>
                </summary>
                <div className="mt-4 overflow-hidden rounded-xl border border-app-border bg-app-surface-muted/50">
                  <div className="divide-y divide-app-border">
                    {group.map((r: (typeof rows)[number]) => (
                      <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusBadgeClass(String(r.status))}`}>{r.status}</div>
                          <div className="mt-1 text-[11px] text-app-muted">
                            {new Date(r.updated_at || r.created_at).toLocaleString()}
                          </div>
                        </div>
                        <Link className="app-link shrink-0 text-xs" href={`/review/${r.id}`}>
                          Open
                        </Link>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            ))}

            {singles.map((r: (typeof rows)[number]) => (
              <div key={r.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusBadgeClass(String(r.status))}`}>{r.status}</div>
                  <div className="text-xs text-app-muted">Uploaded {new Date(r.created_at).toLocaleString()}</div>
                </div>
                <Link className="app-btn-secondary shrink-0 px-3 py-2 text-sm" href={`/review/${r.id}`}>
                  Open
                </Link>
              </div>
            ))}
          </>
        )}
      </div>
      </div>
    </div>
  );
}

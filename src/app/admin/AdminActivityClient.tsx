"use client";

import { useEffect, useState } from "react";

type ExRow = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  created_by_email: string | null;
  updated_by_email: string | null;
  original_filename: string | null;
  batch_id: string | null;
};

type EmpRow = {
  id: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
};

export function AdminActivityClient() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; extractions: ExRow[]; employees: EmpRow[] }
  >({ status: "loading" });

  const extractionRowClassName = "grid grid-cols-[minmax(0,2fr)_0.9fr_1.1fr_1.1fr_1.3fr]";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/activity", { credentials: "include" });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(text || res.statusText);
        }
        const json = JSON.parse(text) as { extractions: ExRow[]; employees: EmpRow[] };
        if (!cancelled) setState({ status: "ok", extractions: json.extractions || [], employees: json.employees || [] });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <p className="text-sm text-app-muted">Loading activity…</p>;
  }
  if (state.status === "error") {
    return <div className="app-alert-danger text-sm">{state.message}</div>;
  }

  return (
    <div className="grid gap-10">
      <section>
        <h2 className="text-base font-semibold text-app-text">Recent uploads and OCR</h2>
        <p className="app-prose-muted mt-1">Which HR account started each extraction.</p>
        <div className="app-table-wrap mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="app-table-head">
              <tr className={extractionRowClassName}>
                <th className="px-3 py-3">File</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Started by</th>
                <th className="px-3 py-3">Updated by</th>
                <th className="px-3 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="block max-h-[264px] overflow-y-auto divide-y divide-app-border">
              {state.extractions.length === 0 ? (
                <tr className={extractionRowClassName}>
                  <td colSpan={5} className="px-3 py-8 text-center text-app-muted">
                    No extractions yet.
                  </td>
                </tr>
              ) : (
                state.extractions.map((r) => (
                  <tr key={r.id} className={`${extractionRowClassName} text-app-text`}>
                    <td className="max-w-[200px] truncate px-3 py-2.5">{r.original_filename || "—"}</td>
                    <td className="px-3 py-2.5 text-app-muted">{r.status}</td>
                    <td className="px-3 py-2.5 text-app-muted">{r.created_by_email || "—"}</td>
                    <td className="px-3 py-2.5 text-app-muted">{r.updated_by_email || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-app-muted">
                      {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold text-app-text">Employee records (audit)</h2>
        <p className="app-prose-muted mt-1">Recent masterlist changes when audit columns are present.</p>
        <div className="app-table-wrap mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="app-table-head">
              <tr>
                <th className="px-3 py-3">Employee</th>
                <th className="px-3 py-3">Created by</th>
                <th className="px-3 py-3">Updated by</th>
                <th className="px-3 py-3">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {state.employees.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-app-muted">
                    No employees yet.
                  </td>
                </tr>
              ) : (
                state.employees.map((r) => (
                  <tr key={r.id} className="text-app-text">
                    <td className="px-3 py-2.5 font-medium">{r.name || "—"}</td>
                    <td className="px-3 py-2.5 text-app-muted">{r.created_by_email || "—"}</td>
                    <td className="px-3 py-2.5 text-app-muted">{r.updated_by_email || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-app-muted">
                      {r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

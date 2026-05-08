"use client";

import { useEffect, useMemo, useState } from "react";
import { DeleteEmployeeButton } from "@/app/masterlist/DeleteEmployeeButton";
import { formatDateDdMmYyyy } from "@/lib/pds/validators";
import { PersonalInfoDrawer } from "@/app/masterlist/PersonalInfoDrawer";

type EmployeeRow = {
  id: string;
  last_name: string;
  first_name: string;
  middle_name: string | null;
  name_extension?: string | null;
  date_of_birth: string | null;
  date_hired?: string | null;
  appointment_date?: string | null;
  position_title: string | null;
  office_department: string | null;
  sg: number | null;
  step: number | null;
  monthly_salary: number | null;
  annual_salary: number | null;
  age: number | null;
  age_group: string | null;
  gender: string | null;
  tenure_years?: number | null;
  tenure_months?: number | null;
};

function tenureLabel(tenureYears?: number | null, tenureMonths?: number | null) {
  // Use pre-calculated tenure from database if available
  if (tenureYears !== null && tenureYears !== undefined) {
    const years = Math.floor(tenureYears);
    const months = tenureMonths ?? 0;
    return `${years}y ${months}m`;
  }
  return "";
}

function useDebouncedValue<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function MasterlistClient() {
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  const [page, setPage] = useState(1);
  const pageSize = 50;
  /** Bumped when the tab becomes visible again so the list refetches after Review → Save elsewhere. */
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [state, setState] = useState<
    | { status: "idle"; employees: EmployeeRow[]; total: number }
    | { status: "loading"; employees: EmployeeRow[]; total: number }
    | { status: "error"; message: string; employees: EmployeeRow[]; total: number }
  >({ status: "loading", employees: [] as EmployeeRow[], total: 0 });

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);

  function exportMasterlist() {
    const url = new URL(`${window.location.origin}/api/masterlist/export`);
    if (debouncedQ.trim()) {
      url.searchParams.set("q", debouncedQ.trim());
    }
    window.location.href = url.toString();
  }

  const pageCount = useMemo(() => {
    return Math.max(1, Math.ceil((state.total || 0) / pageSize));
  }, [state.total]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ]);

  useEffect(() => {
    const bump = () => {
      if (document.visibilityState === "visible") setRefreshNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", bump);
    return () => {
      document.removeEventListener("visibilitychange", bump);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState((s) => ({ status: "loading", employees: s.employees, total: s.total }));
      try {
        const url = new URL(`${window.location.origin}/api/masterlist/employees`);
        if (debouncedQ.trim()) url.searchParams.set("q", debouncedQ.trim());
        url.searchParams.set("page", String(page));
        url.searchParams.set("pageSize", String(pageSize));

        const res = await fetch(url.toString(), { credentials: "include", cache: "no-store" });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(text || res.statusText || `HTTP ${res.status}`);
        }
        const json = JSON.parse(text) as { employees: EmployeeRow[]; total: number };
        if (cancelled) return;
        setState({ status: "idle", employees: json.employees || [], total: Number(json.total || 0) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (cancelled) return;
        setState((s) => ({ status: "error", message: msg, employees: s.employees, total: s.total }));
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, page, refreshNonce]);

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="app-card p-4">
            <label className="text-sm font-medium text-app-text" htmlFor="masterlist-search">
              Search employees
            </label>
            <input
              id="masterlist-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by last name, first name, or middle name"
              className="app-input mt-2"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-app-muted">
              <span>
                Showing <span className="font-mono text-app-text">{state.employees.length}</span> of <span className="font-mono text-app-text">{state.total}</span>
              </span>
              {state.status === "loading" ? <span>Refreshing…</span> : null}
            </div>
            {state.status === "error" ? <div className="app-alert-danger mt-3 text-xs">{state.message}</div> : null}
          </div>

          <div className="flex shrink-0 items-center gap-2 self-start lg:self-auto">
            <button
              type="button"
              className="app-btn-primary px-3 py-2 text-sm"
              onClick={exportMasterlist}
            >
              Export Excel
            </button>
            <button
              type="button"
              className="app-btn-secondary px-3 py-2 text-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <div className="min-w-[5.5rem] text-center text-sm tabular-nums text-app-muted">
              <span className="font-mono text-app-text">{page}</span> / <span className="font-mono">{pageCount}</span>
            </div>
            <button
              type="button"
              className="app-btn-secondary px-3 py-2 text-sm"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
            </button>
          </div>
        </div>

        <div className="app-table-wrap overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead className="app-table-head">
                <tr>
                  <th className="px-3 py-3 text-left">Last name</th>
                  <th className="px-3 py-3 text-left">First name</th>
                  <th className="px-3 py-3 text-left">Middle name</th>
                  <th className="px-3 py-3 text-left">Date of birth</th>
                  <th className="px-3 py-3 text-left">Tenure</th>
                  <th className="px-3 py-3 text-left">Office</th>
                  <th className="px-3 py-3 text-left">Position</th>
                  <th className="px-3 py-3 text-left">Gender</th>
                  <th className="px-3 py-3 text-left">View</th>
                  <th className="px-3 py-3 text-left">Delete</th>
                </tr>
              </thead>
              <tbody>
                {state.employees.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer border-t border-app-border text-app-text transition-colors hover:bg-app-surface-muted"
                    onClick={() => setSelectedEmployeeId(e.id)}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">{e.last_name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{e.first_name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{e.middle_name || ""}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateDdMmYyyy((e as any).date_of_birth)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{tenureLabel(e.tenure_years, e.tenure_months)}</td>
                    <td className="px-3 py-2">{e.office_department || ""}</td>
                    <td className="px-3 py-2">{e.position_title || ""}</td>
                    <td className="px-3 py-2">{e.gender ?? ""}</td>
                    <td className="px-3 py-2" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        type="button"
                        className="app-btn-secondary px-2 py-1 text-xs"
                        onClick={() => setSelectedEmployeeId(e.id)}
                      >
                        View
                      </button>
                    </td>
                    <td className="px-3 py-2" onClick={(ev) => ev.stopPropagation()}>
                      <DeleteEmployeeButton employeeId={e.id} />
                    </td>
                  </tr>
                ))}
                {state.employees.length === 0 ? (
                  <tr className="border-t border-app-border">
                    <td className="px-3 py-10 text-center text-app-muted" colSpan={10}>
                      <p>No employees in the masterlist yet.</p>
                      <p className="mt-2 max-w-xl mx-auto text-xs leading-relaxed">
                        After OCR runs on a PDS (or similar), open <strong className="text-app-text">Review</strong> for that
                        extraction and use <strong className="text-app-text">Save to Masterlist</strong>. That creates the
                        employee record and links uploaded documents.
                      </p>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <PersonalInfoDrawer
        employeeId={selectedEmployeeId}
        onClose={() => setSelectedEmployeeId(null)}
      />
    </div>
  );
}

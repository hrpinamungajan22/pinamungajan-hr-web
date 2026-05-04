"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateDdMmYyyy } from "@/lib/pds/validators";
import { useRouter } from "next/navigation";

type Candidate = {
  id: string;
  last_name: string;
  first_name: string;
  middle_name: string | null;
  date_of_birth: string | null;
};

type SearchEmployee = {
  id: string;
  last_name: string;
  first_name: string;
  middle_name: string | null;
  date_of_birth: string | null;
};

function normalizeDisplayName(e: any) {
  const ln = String(e.last_name || "").trim();
  const fn = String(e.first_name || "").trim();
  const mn = String(e.middle_name || "").trim();
  return `${ln}, ${fn}${mn ? ` ${mn}` : ""}`.trim();
}

function useDebouncedValue<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function CommitEmployeePanel({
  extractionId,
  initialLinkedEmployeeId,
  owner,
}: {
  extractionId: string;
  initialLinkedEmployeeId: string | null;
  owner: {
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    date_of_birth: string | null;
  };
}) {
  const router = useRouter();

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(initialLinkedEmployeeId);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);

  const [searchResults, setSearchResults] = useState<SearchEmployee[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");

  const [commitState, setCommitState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "done"; employeeId: string }
    | { status: "needs_confirmation"; reason: string; candidates: Candidate[] }
    | { status: "error"; message: string }
  >({ status: "idle" });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const q = debouncedSearch.trim();
      if (!q) {
        setSearchResults([]);
        setSearchState("idle");
        return;
      }

      setSearchState("loading");
      try {
        const url = new URL(`${window.location.origin}/api/masterlist/employees`);
        url.searchParams.set("q", q);
        url.searchParams.set("page", "1");
        url.searchParams.set("pageSize", "10");

        const res = await fetch(url.toString(), { credentials: "include" });
        const text = await res.text();
        if (!res.ok) throw new Error(text || res.statusText);
        const json = JSON.parse(text) as { employees: SearchEmployee[] };
        if (cancelled) return;
        setSearchResults(json.employees || []);
        setSearchState("idle");
      } catch {
        if (cancelled) return;
        setSearchState("error");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch]);

  async function commit(opts?: { forceCreateNew?: boolean; employeeId?: string | null }) {
    try {
      setCommitState({ status: "saving" });

      const url = `${window.location.origin}/api/review/commit`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          extraction_id: extractionId,
          employee_id: opts?.employeeId ?? selectedEmployeeId ?? null,
          force_create_new: Boolean(opts?.forceCreateNew),
        }),
      });

      const text = await res.text();
      if (!res.ok) throw new Error(text || res.statusText);
      const json = JSON.parse(text) as any;

      if (json?.needs_confirmation) {
        setCommitState({
          status: "needs_confirmation",
          reason: String(json.reason || "needs_confirmation"),
          candidates: (json.candidates || []) as Candidate[],
        });
        return;
      }

      const employeeId = String(json.employee_id || "");
      if (!employeeId) throw new Error("Commit succeeded but no employee_id returned.");

      setSelectedEmployeeId(employeeId);
      setCommitState({ status: "done", employeeId });

      try {
        router.refresh();
      } catch {
        // ignore
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCommitState({ status: "error", message: msg });
    }
  }

  return (
    <div className="app-card p-4">
      <div className="text-sm font-semibold text-app-text">Save to Masterlist</div>
      <div className="mt-1 text-xs text-app-muted">
        This step links this document to an employee and ensures the employee appears in Masterlist.
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/45">
          <div className="text-[11px] font-semibold text-app-text">OCR owner</div>
          <div className="mt-1 text-sm text-app-text">{normalizeDisplayName(owner)}</div>
          <div className="mt-1 text-xs text-app-muted">DOB: {formatDateDdMmYyyy(owner.date_of_birth)}</div>
        </div>

        <div className="rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/45">
          <div className="text-[11px] font-semibold text-app-text">Link to existing employee (optional)</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees (name)"
            className="app-input mt-1 min-h-9 py-1.5 text-sm"
          />
          {searchState === "loading" ? <div className="mt-1 text-xs text-app-muted">Searching…</div> : null}
          {searchState === "error" ? <div className="mt-1 text-xs text-app-danger">Search failed</div> : null}

          {searchResults.length > 0 ? (
            <div className="mt-2 max-h-[160px] overflow-auto rounded-lg border border-app-border bg-app-surface">
              {searchResults.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs transition-colors hover:bg-app-surface-muted ${
                    selectedEmployeeId === e.id ? "bg-app-primary/10" : ""
                  }`}
                  onClick={() => {
                    setSelectedEmployeeId(e.id);
                    setCommitState({ status: "idle" });
                  }}
                >
                  <span className="text-app-text">{normalizeDisplayName(e)}</span>
                  <span className="font-mono text-app-muted">{formatDateDdMmYyyy((e as any).date_of_birth)}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-2 text-xs text-app-muted">
            Selected employee_id: <span className="font-mono text-app-text">{selectedEmployeeId || "(none)"}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => commit()}
          disabled={commitState.status === "saving"}
          className="inline-flex rounded-lg bg-app-primary px-3 py-1.5 text-xs font-semibold text-app-on-primary transition-colors hover:bg-app-primary-hover disabled:opacity-60"
        >
          {commitState.status === "saving" ? "Saving…" : "Save"}
        </button>

        <button
          type="button"
          onClick={() => {
            setSelectedEmployeeId(null);
            setCommitState({ status: "idle" });
          }}
          className="rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-app-text hover:bg-app-surface-muted"
        >
          Clear selection
        </button>

        {commitState.status === "done" ? (
          <span className="text-xs text-app-success">
            Saved. employee_id=<span className="font-mono">{commitState.employeeId}</span>
          </span>
        ) : null}

        {commitState.status === "error" ? <span className="text-xs text-app-danger">{commitState.message}</span> : null}
      </div>

      {commitState.status === "needs_confirmation" ? (
        <div className="app-alert-warning mt-3">
          <div className="text-xs font-semibold">Is this the same person?</div>
          <div className="mt-1 text-xs">
            We found possible existing employees that match the name
            {commitState.reason === "dob_missing"
              ? " (DOB missing)"
              : commitState.reason === "multiple_matches"
                ? " (multiple matches—choose one below)"
                : ""}
            .
          </div>

          <div className="mt-2 grid gap-2">
            {commitState.candidates.map((c) => (
              <div
                key={c.id}
                className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface px-2 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="text-xs text-app-text">
                  <div className="font-semibold">{normalizeDisplayName(c)}</div>
                  <div className="font-mono text-app-muted">DOB: {formatDateDdMmYyyy(c.date_of_birth)}</div>
                  <div className="font-mono text-app-muted">id: {c.id}</div>
                </div>
                <button
                  type="button"
                  className="inline-flex rounded-lg bg-app-primary px-2 py-1 text-xs font-semibold text-app-on-primary hover:bg-app-primary-hover"
                  onClick={() => commit({ employeeId: c.id })}
                >
                  Yes, link
                </button>
              </div>
            ))}
          </div>

          <div className="mt-2">
            <button
              type="button"
              className="rounded-lg border border-app-warning/45 bg-app-surface px-2 py-1 text-xs font-semibold text-app-warning hover:bg-app-surface-muted"
              onClick={() => commit({ forceCreateNew: true, employeeId: null })}
            >
              No, create new employee
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

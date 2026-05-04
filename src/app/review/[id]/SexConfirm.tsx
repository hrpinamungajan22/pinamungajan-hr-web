"use client";

import { useState } from "react";

export function SexConfirm({
  extractionId,
  canConfirm,
  initialValue,
  isConfirmed = false,
}: {
  extractionId: string;
  canConfirm: boolean;
  initialValue?: "Male" | "Female" | null;
  isConfirmed?: boolean;
}) {
  const [selected, setSelected] = useState<"Male" | "Female" | null>(initialValue ?? null);
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "done"; value: "Male" | "Female" }
    | { status: "error"; message: string }
  >({ status: "idle" });

  async function confirm() {
    if (!selected) return;
    try {
      setState({ status: "saving" });
      const res = await fetch("/api/extractions/sex-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ extraction_id: extractionId, value: selected }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }
      setState({ status: "done", value: selected });
      window.location.reload();
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (state.status === "done") {
    return (
      <div className="mt-2 rounded-lg border border-app-success/35 bg-app-success-muted px-3 py-2">
        <div className="text-xs font-semibold text-app-success">Confirmed: Sex at Birth = {state.value}</div>
      </div>
    );
  }

  return (
    <div className={`mt-2 rounded-lg border px-3 py-2 ${isConfirmed ? "border-app-border bg-app-surface-muted" : "border-app-warning/35 bg-app-warning-muted"}`}>
      <div className={`text-xs font-semibold ${isConfirmed ? "text-app-text" : "text-app-warning"}`}>
        {isConfirmed ? `Current: Sex at Birth = ${initialValue}` : "Needs manual confirmation"}
      </div>
      <div className={`mt-1 text-xs ${isConfirmed ? "text-app-muted" : "text-app-warning"}`}>
        {isConfirmed ? "Review/change if incorrect:" : "Select Sex at Birth:"}
      </div>
      
      <div className="mt-2 flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selected === "Male"}
            onChange={() => setSelected("Male")}
            disabled={!canConfirm || state.status === "saving"}
            className="h-4 w-4 rounded border-app-border text-app-primary focus:ring-app-ring"
          />
          <span className={`text-sm ${isConfirmed ? "text-app-text" : "text-app-warning"}`}>Male</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selected === "Female"}
            onChange={() => setSelected("Female")}
            disabled={!canConfirm || state.status === "saving"}
            className="h-4 w-4 rounded border-app-border text-app-primary focus:ring-app-ring"
          />
          <span className={`text-sm ${isConfirmed ? "text-app-text" : "text-app-warning"}`}>Female</span>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={!canConfirm || !selected || state.status === "saving"}
          className="rounded-md bg-app-primary px-3 py-1.5 text-xs font-semibold text-app-on-primary hover:bg-app-primary-hover disabled:opacity-60"
        >
          {state.status === "saving" ? "Saving..." : isConfirmed ? "Update" : "Confirm"}
        </button>
        {!canConfirm ? (
          <span className={`text-xs ${isConfirmed ? "text-app-muted" : "text-app-warning"}`}>
            No linked employee yet. Link owner first.
          </span>
        ) : selected !== initialValue ? (
          <span className="text-xs text-app-primary">
            {isConfirmed ? "Selection changed - click Update to save" : "Click Confirm to save"}
          </span>
        ) : null}
        {state.status === "error" ? <span className="text-xs text-app-danger">{state.message}</span> : null}
      </div>
    </div>
  );
}

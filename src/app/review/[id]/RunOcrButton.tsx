"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; commitHint?: string }
  | { status: "error"; message: string };

export function RunOcrButton({ extractionId }: { extractionId: string }) {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [state, setState] = useState<RunState>({ status: "idle" });

  useEffect(() => {
    if (state.status !== "running") {
      setElapsedMs(0);
      return;
    }

    const startedAt = Date.now();
    const t = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(t);
  }, [state.status]);

  async function readErrorMessage(res: Response) {
    try {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const j: any = await res.json();
        const parts: string[] = [];
        if (j?.error) parts.push(String(j.error));
        if (j?.details) parts.push(String(j.details));
        if (j?.suggestion) parts.push(String(j.suggestion));
        const msg = parts.filter(Boolean).join(" — ").trim();
        return msg || res.statusText;
      }
    } catch {
      // ignore
    }

    try {
      const text = await res.text();
      return text || res.statusText;
    } catch {
      return res.statusText;
    }
  }

  async function autoCommitToMasterlist(): Promise<string> {
    const cRes = await fetch(`${window.location.origin}/api/review/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ extraction_id: extractionId }),
    });

    const text = await cRes.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (cRes.ok && json?.needs_confirmation) {
      const reason = String(json.reason || "");
      if (reason === "multiple_matches") {
        return "OCR complete. Several masterlist matches — choose one under “Save to Masterlist”.";
      }
      if (reason === "dob_missing") {
        return "OCR complete. Confirm the correct employee under “Save to Masterlist” (DOB was missing).";
      }
      if (reason === "not_registered") {
        return "OCR complete. Owner was detected, but no registered employee matched — this record stays pending until HR links or creates the employee under “Save to Masterlist”.";
      }
      return "OCR complete. Finish linking under “Save to Masterlist”.";
    }

    if (cRes.ok && json?.ok && json?.employee_id) {
      const action = String(json.action || "");
      if (action === "already_linked" || action === "linked") {
        return "OCR complete. Document already linked to masterlist.";
      }
      return "OCR complete. Saved to masterlist.";
    }

    const err =
      (json && (json.message || json.error)) ||
      text ||
      cRes.statusText ||
      "Use “Save to Masterlist” below.";
    return `OCR complete. Masterlist: ${String(err).slice(0, 280)}`;
  }

  async function run() {
    try {
      setState({ status: "running" });

      const controller = new AbortController();
      // Server-side OCR may take several minutes (Document AI + retries + fallback OCR)
      const timeoutMs = 420_000;
      const t = window.setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`/api/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ extraction_id: extractionId }),
        signal: controller.signal,
      }).finally(() => window.clearTimeout(t));

      if (!res.ok) {
        const message = await readErrorMessage(res);
        setState({ status: "error", message });
        return;
      }

      let commitHint = "OCR complete.";
      try {
        commitHint = await autoCommitToMasterlist();
      } catch (e) {
        commitHint =
          "OCR complete. Could not auto-save to masterlist — use “Save to Masterlist” below." +
          (e instanceof Error ? ` (${e.message})` : "");
      }

      setState({ status: "done", commitHint });
      router.refresh();
    } catch (e) {
      console.error("Client OCR Error:", e);
      if (e instanceof DOMException && e.name === "AbortError") {
        setState({
          status: "error",
          message:
            "OCR is taking too long and the browser request timed out. Please retry. If this keeps happening, reduce pages or fix Google Document AI / Cloud Vision credentials.",
        });
        return;
      }
      setState({
        status: "error",
        message: e instanceof Error ? e.message : "Failed to run OCR",
      });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {state.status === "running" ? (
        <div className="w-full max-w-[420px]">
          <div className="h-1 w-full overflow-hidden rounded bg-app-surface-muted">
            <div className="h-full w-1/3 animate-pulse rounded bg-app-primary" />
          </div>
          <div className="mt-1 text-[11px] text-app-muted">
            Processing OCR… {Math.max(0, Math.round(elapsedMs / 1000))}s
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <button
          type="button"
          onClick={run}
          disabled={state.status === "running"}
          className="min-w-[96px] rounded-md bg-app-primary px-3 py-1.5 text-xs font-semibold text-app-on-primary hover:bg-app-primary-hover disabled:opacity-50"
        >
          {state.status === "running" ? "Running..." : "Run OCR"}
        </button>
        {state.status === "done" ? (
          <span className="text-xs text-app-success">Done</span>
        ) : null}
        {state.status === "error" ? (
          <span className="max-w-[420px] break-words text-xs text-app-danger" title={state.message}>
            {state.message || "OCR failed"}
          </span>
        ) : null}
      </div>
      {state.status === "done" && state.commitHint ? (
        <p className="max-w-[520px] text-[11px] leading-snug text-app-muted">{state.commitHint}</p>
      ) : null}
    </div>
  );
}

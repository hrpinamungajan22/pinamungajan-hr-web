"use client";

interface DocTypePanelProps {
  extractionId: string;
  docTypeUserSelected: string | null;
  docTypeDetected: string | null;
  docTypeFinal: string | null;
  docTypeMismatchWarning: boolean;
}

export function DocTypePanel({
  extractionId,
  docTypeUserSelected,
  docTypeDetected,
  docTypeFinal,
  docTypeMismatchWarning,
}: DocTypePanelProps) {
  void extractionId;
  return (
    <div className="app-card p-4 sm:p-5">
      <div className="text-sm font-semibold text-app-text">Document Type</div>
      <div className="mt-2 grid gap-2 text-sm">
        <div className="rounded-lg bg-app-surface-muted px-3 py-2 ring-1 ring-app-border/50">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
              <div className="text-[11px] font-semibold text-app-text">User Selected</div>
              <div className="mt-0.5 text-xs text-app-text">{docTypeUserSelected || "Auto-detect"}</div>
            </div>
            <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
              <div className="text-[11px] font-semibold text-app-text">Detected</div>
              <div className="mt-0.5 text-xs text-app-text">{docTypeDetected || "—"}</div>
            </div>
            <div className="rounded-md border border-app-border bg-app-surface px-2 py-1">
              <div className="text-[11px] font-semibold text-app-text">Final Type Used</div>
              <div className="mt-0.5 text-xs font-semibold capitalize text-app-primary">
                {docTypeFinal || "—"}
              </div>
            </div>
          </div>

          {docTypeMismatchWarning && (
            <div className="mt-3 rounded-md border border-app-warning/35 bg-app-warning-muted px-3 py-2">
              <div className="text-xs font-semibold text-app-warning">Type mismatch detected</div>
              <div className="mt-1 text-xs text-app-text">
                The system detected this document as{" "}
                <strong className="text-app-text">{docTypeDetected}</strong>, but you selected{" "}
                <strong className="text-app-text">{docTypeUserSelected}</strong>. Please review and confirm the correct
                type.
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-app-warning/50 bg-app-surface px-2 py-1 text-[11px] font-medium text-app-warning transition-colors hover:bg-app-surface-muted"
                  onClick={() => {
                    alert("Re-running OCR with detected type: " + docTypeDetected);
                  }}
                >
                  Use detected type
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-app-border bg-app-surface px-2 py-1 text-[11px] font-medium text-app-text transition-colors hover:bg-app-surface-muted"
                >
                  Keep selected type
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

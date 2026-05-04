"use client";

import { useState } from "react";

export function DebugExtractionPanel({
  rawExtractedJson,
  documentType,
  appointmentData,
  extractionDebug,
}: {
  rawExtractedJson: any;
  documentType: string | null;
  appointmentData: any;
  extractionDebug: any;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const detectionDebug = extractionDebug?.document_detection;
  const ownerDebug = rawExtractedJson?.debug?.owner;
  const photoDebug = rawExtractedJson?.debug?.photo;
  const dobDebug = rawExtractedJson?.debug?.dob;
  const sexDebug = rawExtractedJson?.debug?.sex;

  return (
    <div className="app-card p-4">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="text-sm font-semibold text-app-text">Debug / Diagnostics</div>
        <div className="text-xs text-app-muted">{isOpen ? "Hide ▼" : "Show ▶"}</div>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-app-surface-muted p-3 ring-1 ring-app-border/45">
            <div className="text-xs font-semibold text-app-text">Document Type Detection</div>
            <div className="mt-2 grid gap-2 text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-app-muted">Detected Type:</span>
                <span className="font-medium capitalize text-app-primary">{documentType || "unknown"}</span>
              </div>
              {detectionDebug && (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-app-muted">Confidence:</span>
                    <span className="font-medium text-app-text">{Math.round(detectionDebug.confidence * 100)}%</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-app-muted">Stage:</span>
                    <span className="font-medium text-app-text">{detectionDebug.evidence?.stage}</span>
                  </div>
                  {detectionDebug.evidence?.matched && detectionDebug.evidence.matched.length > 0 && (
                    <div>
                      <span className="text-app-muted">Matched Phrases:</span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {detectionDebug.evidence.matched.map((phrase: string) => (
                          <span
                            key={phrase}
                            className="rounded-md bg-app-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-app-primary"
                          >
                            {phrase}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {detectionDebug.evidence?.scores && (
                    <div>
                      <span className="text-app-muted">All Scores:</span>
                      <pre className="mt-1 max-h-[100px] overflow-auto rounded-lg border border-app-border bg-app-bg p-2 text-[10px] text-app-text">
                        {JSON.stringify(detectionDebug.evidence.scores, null, 2)}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {appointmentData && (
            <div className="rounded-lg border border-app-success/35 bg-app-success-muted p-3">
              <div className="text-xs font-semibold text-app-success">Extracted Appointment Data</div>
              <pre className="mt-2 max-h-[200px] overflow-auto rounded-lg border border-app-border bg-app-bg p-2 text-[10px] text-app-text">
                {JSON.stringify(appointmentData, null, 2)}
              </pre>
            </div>
          )}

          {ownerDebug && (
            <div className="rounded-lg border border-app-primary/25 bg-app-primary/5 p-3">
              <div className="text-xs font-semibold text-app-text">Owner Extraction</div>
              <div className="mt-2 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Method:</span>
                  <span className="font-medium text-app-text">{ownerDebug.methodUsed}</span>
                </div>
                {ownerDebug.validationReasons && ownerDebug.validationReasons.length > 0 && (
                  <div className="mt-1 text-app-danger">
                    Validation Issues: {ownerDebug.validationReasons.join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}

          {photoDebug && (
            <div className="rounded-lg bg-app-surface-muted p-3 ring-1 ring-app-border/45">
              <div className="text-xs font-semibold text-app-text">Photo Extraction</div>
              <div className="mt-2 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Method:</span>
                  <span className="font-medium text-app-text">{photoDebug.method}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Face Detected:</span>
                  <span className="font-medium text-app-text">{photoDebug.faceDetected ? "Yes" : "No"}</span>
                </div>
                {photoDebug.warnings && photoDebug.warnings.length > 0 && (
                  <div className="mt-1 text-app-warning">
                    Warnings: {photoDebug.warnings.join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}

          {dobDebug && (
            <div className="rounded-lg border border-app-warning/35 bg-app-warning-muted p-3">
              <div className="text-xs font-semibold text-app-warning">Date of Birth Parsing</div>
              <div className="mt-2 grid gap-1 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Raw:</span>
                  <span className="font-medium text-app-text">{dobDebug.raw}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Parsed ISO:</span>
                  <span className="font-medium text-app-text">{dobDebug.parsedIso}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Rule Used:</span>
                  <span className="font-medium text-app-text">{dobDebug.parseRuleUsed}</span>
                </div>
              </div>
            </div>
          )}

          {sexDebug && (
            <div className="rounded-lg border border-app-border bg-app-surface-muted p-3">
              <div className="text-xs font-semibold text-app-text">Sex/Gender Detection</div>
              <div className="mt-2 grid gap-1 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Method:</span>
                  <span className="font-medium text-app-text">{sexDebug.method}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-app-muted">Decision:</span>
                  <span className="font-medium text-app-text">{sexDebug.decision}</span>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-lg bg-app-surface-muted p-3 ring-1 ring-app-border/45">
            <div className="text-xs font-semibold text-app-text">Raw Extraction Debug</div>
            <pre className="mt-2 max-h-[300px] overflow-auto rounded-lg border border-app-border bg-app-bg p-2 text-[10px] text-app-text">
              {JSON.stringify(rawExtractedJson?.debug, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

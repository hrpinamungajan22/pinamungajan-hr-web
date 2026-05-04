"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

type State =
  | { status: "idle"; signedUrl: string | null }
  | { status: "loading"; signedUrl: string | null }
  | { status: "error"; message: string; signedUrl: string | null }
  | { status: "saving"; signedUrl: string | null }
  | { status: "saved"; signedUrl: string | null };

type NormBox = { x: number; y: number; w: number; h: number };

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampBox(b: NormBox): NormBox {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  const w = clamp01(b.w);
  const h = clamp01(b.h);
  return {
    x,
    y,
    w: Math.max(0.02, Math.min(w, 1 - x)),
    h: Math.max(0.02, Math.min(h, 1 - y)),
  };
}

export function ExtractedPhotoPanel({
  extractionId,
  initialEmployeeId,
  debugPhoto,
}: {
  extractionId: string;
  initialEmployeeId: string | null;
  debugPhoto: any;
}) {
  const storedPath = debugPhoto?.storedPath ? String(debugPhoto.storedPath) : "";
  const storedBucket = debugPhoto?.bucketUsed ? String(debugPhoto.bucketUsed) : "employee_photos";
  const faceDetected = debugPhoto?.faceDetected === true;
  const method = debugPhoto?.method ? String(debugPhoto.method) : null;
  const pageIndex = debugPhoto?.pageIndex === null || debugPhoto?.pageIndex === undefined ? null : Number(debugPhoto.pageIndex);
  const pageCount = debugPhoto?.pageCount === null || debugPhoto?.pageCount === undefined ? null : Number(debugPhoto.pageCount);
  const warnings = Array.isArray(debugPhoto?.warnings) ? (debugPhoto.warnings as any[]) : [];

  const initialRoi = (debugPhoto?.roi && typeof debugPhoto.roi === "object"
    ? {
        x: Number(debugPhoto.roi.x),
        y: Number(debugPhoto.roi.y),
        w: Number(debugPhoto.roi.w),
        h: Number(debugPhoto.roi.h),
      }
    : null) as NormBox | null;

  const [employeeId, setEmployeeId] = useState<string | null>(initialEmployeeId);
  const [state, setState] = useState<State>({ status: "idle", signedUrl: null });
  const [editOpen, setEditOpen] = useState(false);
  const [cropMode, setCropMode] = useState<"free" | "passport">("passport");
  const [zoom, setZoom] = useState(1);

  // Passport photo ratio: 35mm x 45mm = 7:9 aspect ratio
  const PASSPORT_ASPECT = 35 / 45; // width/height
  const PASSPORT_H_NORM = 0.28; // height as fraction of image (fixed size)
  const PASSPORT_W_NORM = PASSPORT_H_NORM * PASSPORT_ASPECT;

  // Initialize ROI - use fixed passport size or initial ROI
  const initialNormRoi: NormBox = initialRoi ?? { x: 0.58, y: 0.40, w: PASSPORT_W_NORM, h: PASSPORT_H_NORM };
  const [roi, setRoi] = useState<NormBox>(() => clampBox(initialNormRoi));
  const [pagePreviewUrl, setPagePreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageImgRef = useRef<HTMLImageElement | null>(null);
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  const dragRef = useRef<
    | null
    | {
        mode: "move" | "nw" | "ne" | "sw" | "se";
        startX: number;
        startY: number;
        startRoi: NormBox;
        wrapW: number;
        wrapH: number;
      }
  >(null);

  useEffect(() => {
    if (initialRoi) {
      if (cropMode === "passport") {
        // Keep position but use fixed passport size
        setRoi(clampBox({
          x: initialRoi.x,
          y: initialRoi.y,
          w: PASSPORT_W_NORM,
          h: PASSPORT_H_NORM
        }));
      } else {
        setRoi(clampBox(initialRoi));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugPhoto?.roi?.x, debugPhoto?.roi?.y, debugPhoto?.roi?.w, debugPhoto?.roi?.h, cropMode]);

  useEffect(() => {
    let cancelled = false;
    if (!editOpen) {
      setPagePreviewUrl(null);
      setPreviewError(null);
      return;
    }
    if (pageIndex === null || !Number.isFinite(pageIndex)) {
      setPagePreviewUrl(null);
      setPreviewError("Missing page_index for preview");
      return;
    }
    async function load() {
      try {
        const url = new URL(`${window.location.origin}/api/pds/page-preview`);
        url.searchParams.set("extraction_id", extractionId);
        url.searchParams.set("page_index", String(pageIndex));
        const res = await fetch(url.toString(), { method: "GET", credentials: "include" });
        if (!res.ok) {
          const msg = await res.text().catch(() => "");
          if (cancelled) return;
          setPagePreviewUrl(null);
          setPreviewError(msg || `Preview failed (${res.status})`);
          return;
        }
        const blob = await res.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        if (cancelled) {
          window.URL.revokeObjectURL(blobUrl);
          return;
        }
        setPagePreviewUrl(blobUrl);
        setPreviewError(null);
      } catch {
        if (cancelled) return;
        setPagePreviewUrl(null);
        setPreviewError("Preview failed (network error)");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [editOpen, extractionId, pageIndex]);

  useEffect(() => {
    return () => {
      if (pagePreviewUrl) window.URL.revokeObjectURL(pagePreviewUrl);
    };
  }, [pagePreviewUrl]);

  useEffect(() => {
    setEmployeeId(initialEmployeeId);
  }, [initialEmployeeId]);

  const canPreview = Boolean(storedPath);
  const canSave = Boolean(storedPath) && faceDetected && Boolean(employeeId);
  const canDebug = Boolean(debugPhoto);
  const canManualSave = Boolean(employeeId) && pageIndex !== null && Number.isFinite(pageIndex);

  // Live preview: draw cropped region to canvas whenever ROI changes
  const updateLivePreview = useCallback(() => {
    const canvas = canvasRef.current;
    const img = pageImgRef.current;
    if (!canvas || !img || !img.complete || img.naturalWidth === 0) return;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const cropX = Math.floor(roi.x * srcW);
    const cropY = Math.floor(roi.y * srcH);
    const cropW = Math.floor(roi.w * srcW);
    const cropH = Math.floor(roi.h * srcH);
    
    // Set canvas size to crop dimensions (capped for performance)
    const maxSize = 400;
    const scale = Math.min(1, maxSize / Math.max(cropW, cropH));
    canvas.width = Math.floor(cropW * scale);
    canvas.height = Math.floor(cropH * scale);
    
    // Draw cropped region
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    
    // Convert to data URL for display
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setLivePreviewUrl(dataUrl);
  }, [roi]);
  
  // Update live preview when ROI changes
  useEffect(() => {
    updateLivePreview();
  }, [updateLivePreview]);

  function beginDrag(mode: "move" | "nw" | "ne" | "sw" | "se", ev: React.PointerEvent) {
    if (cropMode === "passport" && mode !== "move") return; // Only allow move in passport mode
    const el = previewWrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    (ev.currentTarget as any).setPointerCapture?.(ev.pointerId);
    dragRef.current = {
      mode,
      startX: ev.clientX,
      startY: ev.clientY,
      startRoi: roi,
      wrapW: r.width,
      wrapH: r.height,
    };
  }

  function onDragMove(ev: React.PointerEvent) {
    const st = dragRef.current;
    if (!st) return;
    const dx = (ev.clientX - st.startX) / st.wrapW / zoom;
    const dy = (ev.clientY - st.startY) / st.wrapH / zoom;

    const sr = st.startRoi;
    let next: NormBox = sr;

    if (st.mode === "move") {
      if (cropMode === "passport") {
        // Fixed size, only move position
        next = { x: sr.x + dx, y: sr.y + dy, w: PASSPORT_W_NORM, h: PASSPORT_H_NORM };
      } else {
        next = { ...sr, x: sr.x + dx, y: sr.y + dy };
      }
    } else if (cropMode === "free") {
      // Resize only in free mode
      if (st.mode === "nw") {
        next = { x: sr.x + dx, y: sr.y + dy, w: sr.w - dx, h: sr.h - dy };
      } else if (st.mode === "ne") {
        next = { x: sr.x, y: sr.y + dy, w: sr.w + dx, h: sr.h - dy };
      } else if (st.mode === "sw") {
        next = { x: sr.x + dx, y: sr.y, w: sr.w - dx, h: sr.h + dy };
      } else if (st.mode === "se") {
        next = { x: sr.x, y: sr.y, w: sr.w + dx, h: sr.h + dy };
      }
    }

    setRoi(clampBox(next));
  }

  function endDrag() {
    dragRef.current = null;
  }

  async function downloadDebugOverlay() {
    const url = new URL(`${window.location.origin}/api/pds/photo-debug`);
    url.searchParams.set("extraction_id", extractionId);
    const res = await fetch(url.toString(), { method: "GET", credentials: "include" });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || "Failed to download debug overlay");
    }
    const blob = await res.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `photo-debug-${extractionId}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
  }

  async function saveAdjusted() {
    if (!employeeId) return;
    if (pageIndex === null || !Number.isFinite(pageIndex)) return;

    try {
      setState((s) => ({ status: "saving", signedUrl: s.signedUrl }));
      const res = await fetch(`${window.location.origin}/api/employees/save-photo-adjusted`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          extraction_id: extractionId,
          employee_id: employeeId,
          page_index: pageIndex,
          roi: clampBox(roi),
          force: true,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || res.statusText);
      
      // Parse response to get the new photo path
      const result = JSON.parse(text) as { ok: boolean; bucket?: string; path?: string };
      
      // Refresh signed URL to show the newly saved photo
      if (result.ok && result.bucket && result.path) {
        const signedRes = await fetch(`${window.location.origin}/api/files/signed-url`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ bucket: result.bucket, path: result.path, expiresIn: 60 * 10 }),
        });
        const signedText = await signedRes.text();
        if (signedRes.ok) {
          const json = JSON.parse(signedText) as any;
          const newSignedUrl = json?.signedUrl ? String(json.signedUrl) : null;
          setState({ status: "saved", signedUrl: newSignedUrl });
        } else {
          setState((s) => ({ status: "saved", signedUrl: s.signedUrl }));
        }
      } else {
        setState((s) => ({ status: "saved", signedUrl: s.signedUrl }));
      }
      
      setEditOpen(false);
    } catch (e) {
      setState((s) => ({ status: "error", message: e instanceof Error ? e.message : String(e), signedUrl: s.signedUrl }));
    }
  }

  const headerMeta = useMemo(() => {
    const parts: string[] = [];
    if (pageCount !== null && Number.isFinite(pageCount) && pageCount > 0) parts.push(`pages=${pageCount}`);
    if (pageIndex !== null && Number.isFinite(pageIndex)) parts.push(`page_index=${pageIndex}`);
    if (method) parts.push(`method=${method}`);
    if (faceDetected) parts.push("face=ok");
    else if (storedPath) parts.push("face=failed");
    return parts.join(" • ");
  }, [pageIndex, pageCount, method, faceDetected, storedPath]);

  useEffect(() => {
    let cancelled = false;

    async function loadSigned() {
      if (!canPreview) {
        setState({ status: "idle", signedUrl: null });
        return;
      }

      setState((s) => ({ status: "loading", signedUrl: s.signedUrl }));
      try {
        const res = await fetch(`${window.location.origin}/api/files/signed-url`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ bucket: storedBucket, path: storedPath, expiresIn: 60 * 10 }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text || res.statusText);
        const json = JSON.parse(text) as any;
        const signedUrl = json?.signedUrl ? String(json.signedUrl) : null;
        if (cancelled) return;
        setState({ status: "idle", signedUrl });
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e), signedUrl: null });
      }
    }

    loadSigned();
    return () => {
      cancelled = true;
    };
  }, [storedPath, storedBucket, canPreview]);

  async function save() {
    if (!employeeId) return;
    try {
      setState((s) => ({ status: "saving", signedUrl: s.signedUrl }));
      const res = await fetch(`${window.location.origin}/api/employees/save-photo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ extraction_id: extractionId, employee_id: employeeId, force: false }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || res.statusText);
      setState((s) => ({ status: "saved", signedUrl: s.signedUrl }));
    } catch (e) {
      setState((s) => ({ status: "error", message: e instanceof Error ? e.message : String(e), signedUrl: s.signedUrl }));
    }
  }

  return (
    <div className="app-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-app-text">Extracted ID Photo</div>
          <div className="mt-0.5 text-[11px] text-app-muted">{headerMeta || "Run OCR to attempt extraction."}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canDebug}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${canDebug ? "bg-app-surface-muted text-app-text hover:bg-app-border" : "bg-app-surface-muted text-app-muted"}`}
            onClick={() => {
              downloadDebugOverlay().catch((e) => {
                setState((s) => ({ status: "error", message: e instanceof Error ? e.message : String(e), signedUrl: s.signedUrl }));
              });
            }}
          >
            Debug Photo Overlay
          </button>
          <button
            type="button"
            disabled={!canSave || state.status === "saving"}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              canSave && state.status !== "saving" ? "bg-app-success text-app-on-primary hover:opacity-90" : "bg-app-surface-muted text-app-muted"
            }`}
            onClick={save}
          >
            Save photo to employee
          </button>
          <button
            type="button"
            disabled={!canManualSave || state.status === "saving"}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              canManualSave && state.status !== "saving"
                ? "bg-app-primary text-app-on-primary hover:bg-app-primary-hover"
                : "bg-app-surface-muted text-app-muted"
            }`}
            onClick={() => setEditOpen((v) => !v)}
          >
            {editOpen ? "Close adjust" : "Adjust crop"}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div>
          {state.signedUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={state.signedUrl} alt="Extracted ID photo" className="h-40 w-40 rounded-lg border object-cover" />
          ) : (
            <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-app-border bg-app-surface-muted text-xs text-app-muted">
              {canPreview ? "Loading…" : "No extracted photo"}
            </div>
          )}
        </div>

        <div className="flex-1">
          {!employeeId ? (
            <div className="text-xs text-app-warning">Link/commit an employee first to enable saving the extracted photo.</div>
          ) : null}

          {warnings.length > 0 ? (
            <div className="mt-2 rounded-md border border-app-warning/35 bg-app-warning-muted px-2 py-1 text-[11px] text-app-warning">
              {warnings.slice(0, 6).map((w, i) => (
                <div key={i}>{String(w)}</div>
              ))}
            </div>
          ) : null}

          {state.status === "error" ? (
            <div className="mt-2 rounded-md border border-app-danger/35 bg-app-danger-muted px-2 py-1 text-[11px] text-app-danger">
              {state.message}
            </div>
          ) : null}

          {state.status === "saved" ? (
            <div className="mt-2 text-xs font-semibold text-app-success">Saved to employee.</div>
          ) : null}

          {!faceDetected && storedPath ? (
            <div className="mt-2 text-[11px] text-app-muted">Face check failed; auto-save is disabled.</div>
          ) : null}

          {editOpen ? (
            <div className="mt-3 rounded-lg border border-app-border bg-app-surface-muted p-3">
              <div className="text-xs font-semibold text-app-text">Manual crop</div>
              <div className="mt-1 text-[11px] text-app-muted">
                {cropMode === "passport" 
                  ? "Drag the box to position over the face. Size is fixed (35x45mm passport ratio)." 
                  : "Drag to move, resize using handles."} Then save to override the Masterlist photo.
              </div>

              {/* Mode switcher and zoom */}
              <div className="mt-3 flex items-center gap-3">
                <div className="flex items-center gap-1 rounded-md border border-app-border bg-app-surface p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCropMode("passport");
                      // Reset to fixed passport size
                      setRoi(clampBox({ x: roi.x, y: roi.y, w: PASSPORT_W_NORM, h: PASSPORT_H_NORM }));
                    }}
                    className={`rounded px-2 py-1 text-[11px] font-medium ${
                      cropMode === "passport" ? "bg-app-primary/15 text-app-primary" : "text-app-muted hover:bg-app-surface-muted"
                    }`}
                  >
                    Passport (35×45)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCropMode("free")}
                    className={`rounded px-2 py-1 text-[11px] font-medium ${
                      cropMode === "free" ? "bg-app-primary/15 text-app-primary" : "text-app-muted hover:bg-app-surface-muted"
                    }`}
                  >
                    Free resize
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}
                    className="rounded border border-app-border bg-app-surface px-2 py-1 text-xs text-app-text hover:bg-app-surface-muted"
                  >
                    −
                  </button>
                  <span className="text-[11px] text-app-muted">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => setZoom(z => Math.min(3, z + 0.25))}
                    className="rounded border border-app-border bg-app-surface px-2 py-1 text-xs text-app-text hover:bg-app-surface-muted"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <div className="text-[11px] font-semibold text-app-text">
                  {cropMode === "passport" ? "Drag to position" : "Drag to move / resize"}
                </div>
                
                {/* Hidden canvas for live preview generation */}
                <canvas ref={canvasRef} style={{ display: "none" }} />
                
                <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                  {/* Crop area */}
                  <div
                    ref={previewWrapRef}
                    className="relative overflow-hidden rounded-lg border border-app-border bg-app-surface"
                    style={{ maxWidth: 360, height: Math.round(360 * (13/8.5) * zoom), overflow: "auto" }}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    {pagePreviewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img 
                        ref={pageImgRef}
                        src={pagePreviewUrl} 
                        alt="Page preview" 
                        className="block select-none" 
                        style={{ width: 360 * zoom, height: "auto" }}
                        draggable={false}
                        onLoad={updateLivePreview}
                      />
                    ) : previewError ? (
                      <div className="flex aspect-[8.5/13] w-full items-center justify-center p-4 text-center text-xs text-app-danger">
                        {previewError}
                      </div>
                    ) : (
                      <div className="flex aspect-[8.5/13] w-full items-center justify-center text-xs text-app-muted">Loading preview…</div>
                    )}

                    <div
                      role="presentation"
                      className="absolute border-2 border-app-primary bg-app-primary/10"
                      style={{
                        left: `${roi.x * 100}%`,
                        top: `${roi.y * 100}%`,
                        width: `${roi.w * 100}%`,
                        height: `${roi.h * 100}%`,
                        cursor: "move",
                      }}
                      onPointerDown={(ev) => beginDrag("move", ev)}
                    >
                      {cropMode === "free" && (
                        <>
                          <div
                            className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-sm border border-app-primary bg-app-surface"
                            style={{ cursor: "nwse-resize" }}
                            onPointerDown={(ev) => {
                              ev.stopPropagation();
                              beginDrag("nw", ev);
                            }}
                          />
                          <div
                            className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-sm border border-app-primary bg-app-surface"
                            style={{ cursor: "nesw-resize" }}
                            onPointerDown={(ev) => {
                              ev.stopPropagation();
                              beginDrag("ne", ev);
                            }}
                          />
                          <div
                            className="absolute -left-1.5 -bottom-1.5 h-3 w-3 rounded-sm border border-app-primary bg-app-surface"
                            style={{ cursor: "nesw-resize" }}
                            onPointerDown={(ev) => {
                              ev.stopPropagation();
                              beginDrag("sw", ev);
                            }}
                          />
                          <div
                            className="absolute -right-1.5 -bottom-1.5 h-3 w-3 rounded-sm border border-app-primary bg-app-surface"
                            style={{ cursor: "nwse-resize" }}
                            onPointerDown={(ev) => {
                              ev.stopPropagation();
                              beginDrag("se", ev);
                            }}
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {/* Live preview thumbnail */}
                  <div className="flex flex-col items-center">
                    <div className="text-[10px] font-semibold text-app-muted mb-1">Live Preview</div>
                    {livePreviewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img 
                        src={livePreviewUrl}
                        alt="Live crop preview"
                        className="rounded-lg border shadow-sm"
                        style={{ 
                          width: 120, 
                          height: Math.round(120 / (roi.w / roi.h)),
                          maxHeight: 160,
                          objectFit: "contain"
                        }}
                      />
                    ) : (
                      <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-app-border bg-app-surface-muted text-[10px] text-app-muted">
                        No preview
                      </div>
                    )}
                    <div className="mt-1 text-[9px] text-app-muted">
                      {Math.round(roi.w * 100)}% × {Math.round(roi.h * 100)}%
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-4 gap-2">
                <label className="text-[11px] text-app-text">
                  X
                  <input
                    className="mt-1 w-full rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs text-app-text"
                    value={roi.x.toFixed(3)}
                    type="number"
                    step="0.001"
                    min={0}
                    max={1}
                    onChange={(e) => setRoi((r: NormBox) => clampBox({ ...r, x: Number(e.target.value) }))}
                  />
                </label>
                <label className="text-[11px] text-app-text">
                  Y
                  <input
                    className="mt-1 w-full rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs text-app-text"
                    value={roi.y.toFixed(3)}
                    type="number"
                    step="0.001"
                    min={0}
                    max={1}
                    onChange={(e) => setRoi((r: NormBox) => clampBox({ ...r, y: Number(e.target.value) }))}
                  />
                </label>
                <label className="text-[11px] text-app-text">
                  W
                  <input
                    className="mt-1 w-full rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs text-app-text"
                    value={roi.w.toFixed(3)}
                    type="number"
                    step="0.001"
                    min={0}
                    max={1}
                    disabled={cropMode === "passport"}
                    onChange={(e) => setRoi((r: NormBox) => clampBox({ ...r, w: Number(e.target.value) }))}
                  />
                </label>
                <label className="text-[11px] text-app-text">
                  H
                  <input
                    className="mt-1 w-full rounded-md border border-app-border bg-app-surface px-2 py-1 text-xs text-app-text"
                    value={roi.h.toFixed(3)}
                    type="number"
                    step="0.001"
                    min={0}
                    max={1}
                    disabled={cropMode === "passport"}
                    onChange={(e) => setRoi((r: NormBox) => clampBox({ ...r, h: Number(e.target.value) }))}
                  />
                </label>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={!canManualSave || state.status === "saving"}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                    canManualSave && state.status !== "saving" ? "bg-app-primary text-app-on-primary hover:bg-app-primary-hover" : "bg-app-surface-muted text-app-muted"
                  }`}
                  onClick={saveAdjusted}
                >
                  Save adjusted photo
                </button>
                <span className="text-[11px] text-app-muted">This will replace the Masterlist photo.</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

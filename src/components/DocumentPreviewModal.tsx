"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";

interface DocumentPreviewModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  // For single image/PDF
  imageUrl?: string | null;
  // For multi-page documents (PDS sets)
  pageUrls?: string[];
  initialPage?: number;
}

export function DocumentPreviewModal({
  open,
  onClose,
  title = "Document Preview",
  imageUrl,
  pageUrls = [],
  initialPage = 0,
}: DocumentPreviewModalProps) {
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const urls = useMemo(() => {
    if (pageUrls.length > 0) return pageUrls;
    if (imageUrl) return [imageUrl];
    return [];
  }, [imageUrl, pageUrls]);

  const currentUrl = urls[page] || null;
  const totalPages = urls.length;

  useEffect(() => {
    if (open) {
      setPage(initialPage);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [open, initialPage]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft") {
        setPage((p) => Math.max(0, p - 1));
      } else if (e.key === "ArrowRight") {
        setPage((p) => Math.min(totalPages - 1, p + 1));
      } else if (e.key === "+" || e.key === "=") {
        setZoom((z) => Math.min(5, z + 0.25));
      } else if (e.key === "-" || e.key === "_") {
        setZoom((z) => Math.max(0.25, z - 0.25));
      } else if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, totalPages]);

  // Wheel zoom with non-passive listener
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !open) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.max(0.25, Math.min(5, z + delta)));
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [open]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }, [zoom, pan]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || zoom <= 1) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  }, [isDragging, dragStart, zoom]);

  const onMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/80">
      {/* Header */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between border-b border-app-border bg-app-surface px-4 py-3 text-app-text shadow-sm">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold">{title}</div>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="app-btn-secondary rounded px-2 py-1 text-xs disabled:opacity-50"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page <= 0}
              >
                ← Prev
              </button>
              <span className="text-xs">
                Page {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                className="app-btn-secondary rounded px-2 py-1 text-xs disabled:opacity-50"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                Next →
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="app-btn-secondary rounded px-2 py-1 text-xs"
              onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            >
              −
            </button>
            <span className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className="app-btn-secondary rounded px-2 py-1 text-xs"
              onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
            >
              +
            </button>
            <button
              type="button"
              className="app-btn-secondary ml-1 rounded px-2 py-1 text-xs"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              Fit
            </button>
          </div>
          <button
            type="button"
            className="app-btn-secondary ml-2 rounded px-3 py-1 text-xs font-semibold"
            onClick={onClose}
          >
            Close (Esc)
          </button>
        </div>
      </div>

      {/* Image container */}
      <div
        ref={containerRef}
        className="absolute bottom-0 left-0 right-0 top-[52px] flex items-center justify-center overflow-hidden"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default" }}
      >
        {currentUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentUrl}
            alt={`Page ${page + 1}`}
            className="max-h-full max-w-full select-none object-contain transition-transform"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
            draggable={false}
          />
        ) : (
          <div className="text-sm text-app-muted">No preview available</div>
        )}
      </div>

      {/* Keyboard hints */}
      <div className="absolute bottom-4 left-4 rounded border border-app-border bg-app-surface/95 px-3 py-2 text-xs text-app-muted shadow-sm backdrop-blur-sm">
        <div className="font-semibold">Keyboard shortcuts</div>
        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
          <span>← →</span>
          <span>Navigate pages</span>
          <span>+ −</span>
          <span>Zoom in/out</span>
          <span>0</span>
          <span>Reset zoom</span>
          <span>Esc</span>
          <span>Close</span>
        </div>
      </div>

      {/* Page thumbnails (if multiple pages) */}
      {totalPages > 1 && (
        <div className="absolute bottom-4 right-4 flex max-w-[200px] flex-col gap-1 rounded border border-app-border bg-app-surface/95 p-2 shadow-sm backdrop-blur-sm">
          <div className="text-xs font-semibold text-app-text">Pages</div>
          <div className="flex flex-wrap gap-1">
            {urls.map((url, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                className={`h-8 w-8 rounded text-xs ${
                  i === page
                    ? "bg-app-primary text-app-on-primary"
                    : "border border-app-border bg-app-surface text-app-muted hover:bg-app-surface-muted"
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

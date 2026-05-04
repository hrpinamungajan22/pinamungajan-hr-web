import type { DocToken } from "@/lib/pds/documentAiTokens";
import type { NormBox } from "@/lib/pds2025/mappingSchema";

export type PhotoExtractMethod = "map" | "anchor" | "vision";

export type PhotoExtractTier = "A" | "B" | "C";

export type CoarseWindow = NormBox;

export type PhotoCandidateDebug = {
  roi: NormBox;
  score: number;
  frameScore?: number;
  contrastScore?: number;
  faceScore?: number;
  reasons: string[];
  faceDetected: boolean;
  rejected?: boolean;
  rejectionReasons?: string[];
};

export type PhotoExtractDebug = {
  pageIndex: number | null;
  method: PhotoExtractMethod | null;
  tierUsed?: PhotoExtractTier | null;
  tierAFailedReasons?: string[];
  tierBFailedReasons?: string[];
  roi: NormBox | null;
  faceDetected: boolean | null;
  storedPath: string | null;
  bucketUsed?: string | null;
  bucketReason?: string | null;
  overlayPath?: string | null;
  overlayBucketUsed?: string | null;
  warnings: string[];
  photoLabelBox?: NormBox | null;
  thumbmarkLabelBox?: NormBox | null;
  coarseWindow?: NormBox | null;
  candidates?: PhotoCandidateDebug[];
  chosen?: { roi: NormBox; method: PhotoExtractMethod; faceDetected: boolean } | null;
  trim?: { applied: boolean; percentCut: number } | null;
  pageScores?: Array<{ pageIndex: number | null; score: number; reasons: string[] }>;
};

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sanitizeBox(b: NormBox): NormBox {
  const x1 = clamp01(b.x);
  const y1 = clamp01(b.y);
  const x2 = clamp01(b.x + b.w);
  const y2 = clamp01(b.y + b.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

function clampBoxToPage(b: NormBox): NormBox {
  return sanitizeBox(b);
}

function aspectRatio(b: NormBox) {
  const w = Math.max(1e-6, b.w);
  const h = Math.max(1e-6, b.h);
  return w / h;
}

function area(b: NormBox) {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

function centerOf(b: NormBox) {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

function insetBox(b: NormBox, frac: number): NormBox {
  const dx = b.w * frac;
  const dy = b.h * frac;
  return clampBoxToPage({ x: b.x + dx, y: b.y + dy, w: Math.max(0, b.w - dx * 2), h: Math.max(0, b.h - dy * 2) });
}

async function getGrayscaleRaw(png: Buffer, roi: NormBox, targetW: number) {
  let sharp: any;
  sharp = (await import("sharp")).default;
  const meta = await sharp(png).metadata();
  const W = Number(meta.width || 0);
  const H = Number(meta.height || 0);
  const left = Math.max(0, Math.floor(roi.x * W));
  const top = Math.max(0, Math.floor(roi.y * H));
  const width = Math.max(1, Math.floor(roi.w * W));
  const height = Math.max(1, Math.floor(roi.h * H));
  const img = sharp(png).extract({ left, top, width, height }).grayscale().resize({ width: targetW });
  const out = await img.raw().toBuffer({ resolveWithObject: true });
  return { data: out.data as Buffer, w: out.info.width, h: out.info.height, src: { W, H, left, top, width, height } };
}

function sobelEdgeMap(gray: Buffer, w: number, h: number) {
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + w] - gray[i - w]);
      const mag = gx + gy;
      edge[i] = mag;
    }
  }
  return edge;
}

function pickPeaks(arr: number[], topN: number, minDist: number) {
  const idxs = arr.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out: number[] = [];
  for (const it of idxs) {
    if (out.length >= topN) break;
    if (out.some((j) => Math.abs(j - it.i) < minDist)) continue;
    out.push(it.i);
  }
  return out.sort((a, b) => a - b);
}

function borderScore(edge: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  x0 = clamp(x0, 0, w - 1);
  x1 = clamp(x1, 0, w - 1);
  y0 = clamp(y0, 0, h - 1);
  y1 = clamp(y1, 0, h - 1);
  if (x1 <= x0 || y1 <= y0) return 0;

  const th = 45;
  let hit = 0;
  let total = 0;
  for (let x = x0; x <= x1; x++) {
    total += 2;
    if (edge[y0 * w + x] > th) hit++;
    if (edge[y1 * w + x] > th) hit++;
  }
  for (let y = y0; y <= y1; y++) {
    total += 2;
    if (edge[y * w + x0] > th) hit++;
    if (edge[y * w + x1] > th) hit++;
  }
  return total ? hit / total : 0;
}

export async function findPhotoFrameCandidatesByVision(input: {
  png: Buffer;
  coarseWindow: NormBox;
  photoLabelBox?: NormBox | null;
  thumbmarkLabelBox?: NormBox | null;
}): Promise<Array<{ roi: NormBox; score: number; reasons: string[] }>> {
  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return [];
  }

  const coarse = clampBoxToPage(input.coarseWindow);
  const raw = await getGrayscaleRaw(input.png, coarse, 520);
  const edge = sobelEdgeMap(raw.data, raw.w, raw.h);

  const rowSum: number[] = new Array(raw.h).fill(0);
  const colSum: number[] = new Array(raw.w).fill(0);
  const th = 45;
  for (let y = 0; y < raw.h; y++) {
    let rs = 0;
    const off = y * raw.w;
    for (let x = 0; x < raw.w; x++) {
      const v = edge[off + x] > th ? 1 : 0;
      rs += v;
      colSum[x] += v;
    }
    rowSum[y] = rs;
  }

  const topRows = pickPeaks(rowSum, 6, 18);
  const topCols = pickPeaks(colSum, 6, 18);

  const candidates: Array<{ roi: NormBox; score: number; reasons: string[] }> = [];

  const pageArea = 1;
  const minArea = 0.01 * pageArea;
  const maxArea = 0.15 * pageArea;

  for (const y0 of topRows) {
    for (const y1 of topRows) {
      if (y1 <= y0 + 40) continue;
      for (const x0 of topCols) {
        for (const x1 of topCols) {
          if (x1 <= x0 + 40) continue;

          const bs = borderScore(edge, raw.w, raw.h, x0, y0, x1, y1);
          if (bs < 0.25) continue;

          const rx = coarse.x + (x0 / raw.w) * coarse.w;
          const ry = coarse.y + (y0 / raw.h) * coarse.h;
          const rw = ((x1 - x0) / raw.w) * coarse.w;
          const rh = ((y1 - y0) / raw.h) * coarse.h;
          const roi = clampBoxToPage({ x: rx, y: ry, w: rw, h: rh });

          const a = area(roi);
          if (a < minArea || a > maxArea) continue;

          const ar = aspectRatio(roi);
          if (ar < 0.65 || ar > 1.05) continue;

          let score = 0;
          const reasons: string[] = [];
          score += bs * 3;
          reasons.push(`border:${bs.toFixed(2)}`);

          const c = centerOf(roi);

          // Prefer above PHOTO label.
          if (input.photoLabelBox) {
            const label = centerOf(input.photoLabelBox);
            const dx = Math.abs(c.cx - label.cx);
            const dy = (label.cy - c.cy);
            if (dy > 0 && dy < 0.25 && dx < 0.25) {
              score += 2.0;
              reasons.push("near_label");
            }
          }

          // Prefer above thumbmark label (thumb is usually below photo).
          if (input.thumbmarkLabelBox) {
            const t = centerOf(input.thumbmarkLabelBox);
            if (c.cy < t.cy - 0.03) {
              score += 0.7;
              reasons.push("above_thumbmark");
            } else {
              score -= 0.5;
              reasons.push("below_thumbmark");
            }
          }

          candidates.push({ roi, score, reasons });
        }
      }
    }
  }

  // Sort and de-dup by approximate box.
  candidates.sort((a, b) => b.score - a.score);
  const out: Array<{ roi: NormBox; score: number; reasons: string[] }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const k = `${c.roi.x.toFixed(3)}:${c.roi.y.toFixed(3)}:${c.roi.w.toFixed(3)}:${c.roi.h.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= 8) break;
  }
  return out;
}

async function maybeTrimNameStrip(input: { jpegOrPng: Buffer; maxCutPercent: number[] }) {
  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return { buffer: input.jpegOrPng, applied: false, percentCut: 0 };
  }
  const meta = await sharp(input.jpegOrPng).metadata();
  const w = Number(meta.width || 0);
  const h = Number(meta.height || 0);
  if (!w || !h) return { buffer: input.jpegOrPng, applied: false, percentCut: 0 };

  const gray = await sharp(input.jpegOrPng).grayscale().raw().toBuffer({ resolveWithObject: true });
  const data = gray.data as Buffer;
  const W = gray.info.width;
  const H = gray.info.height;

  function inkDensity(y0: number, y1: number) {
    let ink = 0;
    let total = 0;
    for (let y = y0; y < y1; y++) {
      const off = y * W;
      for (let x = 0; x < W; x++) {
        total++;
        if (data[off + x] < 200) ink++;
      }
    }
    return total ? ink / total : 0;
  }

  const mid0 = Math.floor(H * 0.40);
  const mid1 = Math.floor(H * 0.70);
  const base = inkDensity(mid0, mid1);

  for (const pct of input.maxCutPercent) {
    const cut = Math.floor(H * pct);
    const bottom0 = H - cut;
    const bottomDensity = inkDensity(bottom0, H);
    if (bottomDensity > base * 1.8 && bottomDensity > 0.06) {
      const outH = H - cut;
      const buf = await sharp(input.jpegOrPng).extract({ left: 0, top: 0, width: W, height: Math.max(1, outH) }).toBuffer();
      return { buffer: buf, applied: true, percentCut: pct };
    }
  }

  return { buffer: input.jpegOrPng, applied: false, percentCut: 0 };
}

export async function cropPhotoFromFrameNormalizedPng(input: {
  png: Buffer;
  frameRoi: NormBox;
  insetFrac?: number;
}): Promise<{
  jpeg: Buffer;
  debug: {
    faceLike: boolean;
    warnings: string[];
    trim: { applied: boolean; percentCut: number };
    avgMean?: number;
    avgStdev?: number;
  };
}> {
  const warnings: string[] = [];
  const inset = insetBox(input.frameRoi, typeof input.insetFrac === "number" ? input.insetFrac : 0.04);

  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error("sharp_missing");
  }
  const meta = await sharp(input.png).metadata();
  const W = Number(meta.width || 0);
  const H = Number(meta.height || 0);
  if (!W || !H) throw new Error("invalid_image_metadata");

  const left = Math.max(0, Math.floor(inset.x * W));
  const top = Math.max(0, Math.floor(inset.y * H));
  const width = Math.max(1, Math.floor(inset.w * W));
  const height = Math.max(1, Math.floor(inset.h * H));

  let img = sharp(input.png).extract({ left, top, width, height });
  try {
    img = img.trim({ threshold: 12 });
  } catch {
    warnings.push("trim_failed");
  }

  // Pre-resize working buffer
  let working = await img.jpeg({ quality: 92 }).toBuffer();
  const strip = await maybeTrimNameStrip({ jpegOrPng: working, maxCutPercent: [0.22, 0.18, 0.14] });
  working = strip.buffer;

  const resized = await sharp(working)
    .resize(512, 512, { fit: "cover", position: "centre" })
    .jpeg({ quality: 85 })
    .toBuffer();

  let faceLike = false;
  let avgMean: number | undefined;
  let avgStdev: number | undefined;
  try {
    const stats = await sharp(resized).stats();
    const ch = stats.channels || [];
    const means = ch.map((c: any) => Number(c.mean || 0));
    const stdevs = ch.map((c: any) => Number(c.stdev || 0));
    avgMean = means.length ? means.reduce((a: number, b: number) => a + b, 0) / means.length : 0;
    avgStdev = stdevs.length ? stdevs.reduce((a: number, b: number) => a + b, 0) / stdevs.length : 0;
    faceLike = (avgStdev || 0) > 18 && (avgMean || 0) > 30 && (avgMean || 0) < 235;
  } catch {
    warnings.push("facecheck_failed");
    faceLike = false;
  }

  return { jpeg: resized, debug: { faceLike, warnings, trim: { applied: strip.applied, percentCut: strip.percentCut }, avgMean, avgStdev } };
}

function countMatches(haystack: string, needleUpper: string) {
  const u = haystack.toUpperCase();
  let idx = 0;
  let count = 0;
  while (true) {
    const i = u.indexOf(needleUpper, idx);
    if (i === -1) break;
    count += 1;
    idx = i + needleUpper.length;
  }
  return count;
}

export function scorePhotoPageFromTextAndTokens(input: {
  fullText: string;
  tokens: DocToken[];
}): { score: number; reasons: string[]; photoTokenCandidates: DocToken[] } {
  const reasons: string[] = [];
  const t = String(input.fullText || "");

  const photoCount = countMatches(t, "PHOTO");
  const thumbCount = countMatches(t, "THUMB");
  const swornCount = countMatches(t, "SUBSCRIBED") + countMatches(t, "SWORN") + countMatches(t, "OATH");
  const administeringCount = countMatches(t, "ADMINISTERING") + countMatches(t, "ADMINISTER");

  let score = 0;
  if (photoCount > 0) {
    score += 120 + Math.min(3, photoCount) * 10;
    reasons.push(`text:PHOTO x${photoCount}`);
  }
  if (thumbCount > 0) {
    score += 60;
    reasons.push("text:THUMB");
  }
  if (swornCount > 0) {
    score += 35;
    reasons.push("text:OATH/SWORN");
  }
  if (administeringCount > 0) {
    score += 25;
    reasons.push("text:ADMINISTERING");
  }

  const photoTokenCandidates = input.tokens
    .filter((tok) => String(tok.text || "").trim().toUpperCase() === "PHOTO")
    // Prefer lower-right label tokens.
    .sort((a, b) => {
      const aBias = (a.box.midX - 0.5) + (a.box.midY - 0.5);
      const bBias = (b.box.midX - 0.5) + (b.box.midY - 0.5);
      return bBias - aBias;
    });

  const best = photoTokenCandidates[0] || null;
  if (best) {
    const lr = best.box.midX > 0.55 && best.box.midY > 0.55;
    score += lr ? 80 : 30;
    reasons.push(lr ? "token:PHOTO lower-right" : "token:PHOTO");
  }

  return { score, reasons, photoTokenCandidates };
}

export function roiFromPhotoToken(tok: DocToken): NormBox {
  return roiCandidatesFromPhotoToken(tok)[0];
}

export function roiCandidatesFromPhotoToken(tok: DocToken): NormBox[] {
  // Robust anchor geometry:
  // - PHOTO label sits directly below the photo frame.
  // - Never include pixels below the PHOTO label line (avoid handwritten name strip).
  // - Typical photo frame ratio ~ 0.75..0.9 (w/h) depending on scan; we allow broader.
  const labelLeft = tok.box.minX;
  const labelRight = tok.box.maxX;
  const labelTop = tok.box.minY;

  const bottom = clamp01(labelTop - 0.006);

  const candidates: NormBox[] = [];

  const presets = [
    { w: 0.30, h: 0.34, xPadL: 0.12, xPadR: 0.10 },
    { w: 0.32, h: 0.36, xPadL: 0.14, xPadR: 0.12 },
    { w: 0.28, h: 0.32, xPadL: 0.10, xPadR: 0.08 },
  ];

  for (const p of presets) {
    const left = clamp01(labelLeft - p.xPadL);
    const right = clamp01(labelRight + p.xPadR);
    const w = Math.max(right - left, p.w);
    const h = p.h;
    const top = clamp01(bottom - h);
    const box = clampBoxToPage({ x: left, y: top, w, h: bottom - top });

    // Ratio clamp: prefer ~0.7..1.05 (close to portrait/square-ish)
    const ar = aspectRatio(box);
    if (ar < 0.55 || ar > 1.25) continue;
    if (box.w < 0.12 || box.h < 0.12) continue;
    candidates.push(box);
  }

  // Fallback if all rejected: return a conservative default.
  if (candidates.length === 0) {
    const left = clamp01(labelLeft - 0.12);
    const w = 0.32;
    const h = 0.35;
    const top = clamp01(bottom - h);
    candidates.push(clampBoxToPage({ x: left, y: top, w, h: bottom - top }));
  }

  // De-dup approx
  const uniq: NormBox[] = [];
  for (const c of candidates) {
    const key = `${c.x.toFixed(3)}:${c.y.toFixed(3)}:${c.w.toFixed(3)}:${c.h.toFixed(3)}`;
    if (!uniq.some((u) => `${u.x.toFixed(3)}:${u.y.toFixed(3)}:${u.w.toFixed(3)}:${u.h.toFixed(3)}` === key)) uniq.push(c);
  }
  return uniq;
}

export async function cropPhotoFromNormalizedPng(input: {
  png: Buffer;
  roi: NormBox;
}): Promise<{ jpeg: Buffer; debug: { faceLike: boolean; warnings: string[]; avgMean?: number; avgStdev?: number } }> {
  const warnings: string[] = [];

  let sharp: any;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error("sharp_missing");
  }

  const meta = await sharp(input.png).metadata();
  const w = Number(meta.width || 0);
  const h = Number(meta.height || 0);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error("invalid_image_metadata");
  }

  const left = Math.max(0, Math.floor(input.roi.x * w));
  const top = Math.max(0, Math.floor(input.roi.y * h));
  const width = Math.max(1, Math.floor(input.roi.w * w));
  const height = Math.max(1, Math.floor(input.roi.h * h));

  // Crop from normalized page.
  let img = sharp(input.png).extract({ left, top, width, height });

  // Trim uniform borders (frame/background). If trimming fails, proceed.
  try {
    img = img.trim({ threshold: 12 });
  } catch {
    warnings.push("trim_failed");
  }

  // Resize to standard avatar.
  const resized = await img
    .resize(512, 512, {
      fit: "cover",
      position: "centre",
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  // Lightweight “face-like” check (no OpenCV dependency): ensure the crop is not blank/low-entropy.
  let faceLike = false;
  let avgMean: number | undefined;
  let avgStdev: number | undefined;
  try {
    const stats = await sharp(resized).stats();
    const ch = stats.channels || [];
    const means = ch.map((c: any) => Number(c.mean || 0));
    const stdevs = ch.map((c: any) => Number(c.stdev || 0));
    avgMean = means.length ? means.reduce((a: number, b: number) => a + b, 0) / means.length : 0;
    avgStdev = stdevs.length ? stdevs.reduce((a: number, b: number) => a + b, 0) / stdevs.length : 0;

    // Heuristic: non-trivial variance and not too dark/light.
    faceLike = (avgStdev || 0) > 12 && (avgMean || 0) > 20 && (avgMean || 0) < 245;
  } catch {
    warnings.push("facecheck_failed");
    faceLike = false;
  }

  return { jpeg: resized, debug: { faceLike, warnings, avgMean, avgStdev } };
}

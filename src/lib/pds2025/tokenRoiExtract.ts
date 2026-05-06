import { PDS2025_PAGE1_ROIS, type Roi } from "@/lib/pds2025/templateMap";
import { getDocumentAiTokens, type DocToken, type TokenBox } from "@/lib/pds/documentAiTokens";
import { validateDobToIso, validatePersonName } from "@/lib/pds/validators";

export type OwnerCandidate = {
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  name_extension?: string | null;
  date_of_birth: string | null;
  gender?: string | null;
  confidence: number;
};

export type RoiExtractDebug = {
  used: "roi";
  tokensUsed: {
    surname: number;
    first_name: number;
    middle_name: number;
    name_extension: number;
    date_of_birth: number;
  };
  avgTokenConfidence: {
    surname: number | null;
    first_name: number | null;
    middle_name: number | null;
    name_extension: number | null;
    date_of_birth: number | null;
  };
  rejected: Record<string, string[]>;
};

const LABEL_WORDS = new Set([
  "SURNAME", "FIRST", "MIDDLE", "NAME", "DATE", "OF", "BIRTH", "DOB",
  "MIDDLLE", "MIDLE", "MIDDL", "SURNAM", "SURNANE", "F1RST", "F1RSTNAME",
  "B1RTH", "DAT", "BIRTHDATE", "EXTENSION", "JR", "SR", "III", "IV"
]);

function clean(s: string) {
  return String(s || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/[^0-9A-Za-z\-\/\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAndRemoveLabels(s: string): string {
  const cleaned = clean(s);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const filtered = words.filter(w => !LABEL_WORDS.has(w.toUpperCase()));
  return filtered.join(" ").trim();
}

function firstNameToken(s: string): string {
  const words = s.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (/^[A-Za-z\-]{2,}$/.test(w) && !LABEL_WORDS.has(w.toUpperCase())) return w;
  }
  return s;
}

function lastNameToken(s: string, avoidUpper: Set<string> = new Set()): string {
  const words = s.split(/\s+/).filter(Boolean);
  const candidates = words.filter((w) => /^[A-Za-z\-]{2,}$/.test(w) && !LABEL_WORDS.has(w.toUpperCase()));
  const filtered = candidates.filter((w) => !avoidUpper.has(w.toUpperCase()));
  const pool = filtered.length > 0 ? filtered : candidates;
  return pool.sort((a, b) => b.length - a.length)[0] || s;
}

function pickNamePartFromTokenText(
  tokenText: string,
  which: "last" | "first" | "middle",
  avoidUpper: Set<string> = new Set()
) {
  const parts = cleanAndRemoveLabels(clean(tokenText)).split(/\s+/).filter(Boolean);
  const candidates = parts.filter((part) => {
    const upper = part.toUpperCase();
    if (!/^[A-Za-z\-]{2,}$/.test(part)) return false;
    if (LABEL_WORDS.has(upper)) return false;
    if (avoidUpper.has(upper)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  if (which === "last") return candidates.sort((a, b) => b.length - a.length)[0] || null;
  if (which === "middle") return candidates[candidates.length - 1] || null;
  return candidates[candidates.length - 1] || null;
}

function pickTokenFromRoi(tokens: DocToken[], prefer: "leftmost" | "rightmost", avoidUpper: Set<string> = new Set()): string | null {
  const ordered = tokens
    .slice()
    .sort((a, b) => prefer === "leftmost" ? a.box.minX - b.box.minX : b.box.maxX - a.box.maxX);

  for (const token of ordered) {
    const picked = pickNamePartFromTokenText(token.text, prefer === "rightmost" ? "middle" : "first", avoidUpper);
    if (picked) return picked;
  }

  return null;
}

function insideRoi(box: TokenBox, roi: Roi) {
  return box.midX >= roi.x && box.midX <= roi.x + roi.w && box.midY >= roi.y && box.midY <= roi.y + roi.h;
}

function avgConfidence(tokens: DocToken[]) {
  const vals = tokens
    .map((t) => (typeof t.confidence === "number" ? t.confidence : null))
    .filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function joinTokensLinewise(tokens: DocToken[]) {
  // Simple join sorted by x.
  const joined = tokens
    .slice()
    .sort((a, b) => a.box.minX - b.box.minX)
    .map((t) => clean(t.text))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return joined;
}

export function extractOwnerFromTokensRoi(document: any): { owner: OwnerCandidate | null; debug: RoiExtractDebug } {
  const tokensRaw = getDocumentAiTokens(document);

  const rejected: Record<string, string[]> = {
    surname: [],
    first_name: [],
    middle_name: [],
    name_extension: [],
    date_of_birth: [],
  };

  const pageIndex = 0;
  const page0 = tokensRaw.filter((t) => t.pageIndex === pageIndex);

  // Helper: expand an ROI vertically by a delta (for adaptive fallback).
  function expandRoiY(roi: Roi, dy: number): Roi {
    return { x: roi.x, y: Math.max(0, roi.y - dy), w: roi.w, h: roi.h + dy * 2 };
  }

  // Y-adaptive fallback: find the SURNAME label token to locate the name row Y.
  // All three name columns (SURNAME / FIRST NAME / MIDDLE NAME) are on the SAME Y row.
  function adaptiveRois(): typeof PDS2025_PAGE1_ROIS {
    const norm = (t: string) => String(t || "").toUpperCase().replace(/\s+/g, "");

    // SURNAME label is leftmost (x < 0.22); FIRST NAME is middle (x ~0.28-0.58); MIDDLE is right (x > 0.58).
    const surTok  = page0.find((t) => norm(t.text).includes("SURNAME")  && t.box.midX < 0.25);
    const firstTok= page0.find((t) => norm(t.text).includes("FIRST")    && t.box.midX >= 0.28 && t.box.midX < 0.60);
    const midTok  = page0.find((t) => norm(t.text).includes("MIDDLE")   && t.box.midX >= 0.58);
    const dobTok  = page0.find((t) => norm(t.text).includes("DATE")     && t.box.midX < 0.30);

    const anchor  = surTok ?? firstTok ?? midTok;
    if (!anchor) return PDS2025_PAGE1_ROIS;

    const rowY   = anchor.box.midY;
    const halfH  = 0.022;
    const dobY   = dobTok?.box.midY ?? rowY + 0.048;

    return {
      surname:        { x: 0.18, y: rowY - halfH, w: 0.24, h: halfH * 2 },
      first_name:     { x: 0.43, y: rowY - halfH, w: 0.21, h: halfH * 2 },
      middle_name:    { x: 0.74, y: rowY - halfH, w: 0.10, h: halfH * 2 },
      name_extension: { x: 0.85, y: rowY - halfH, w: 0.10, h: halfH * 2 },
      date_of_birth:  { x: 0.18, y: dobY - halfH, w: 0.24, h: halfH * 2 },
    };
  }

  let rois = PDS2025_PAGE1_ROIS;
  let surnameTokens = page0.filter((t) => insideRoi(t.box, rois.surname));

  // If nothing found in fixed ROI, try adaptive (label-anchored) ROI.
  if (surnameTokens.length === 0) {
    rois = adaptiveRois();
    surnameTokens = page0.filter((t) => insideRoi(t.box, rois.surname));
  }

  // If still nothing, try a wider vertical sweep of the fixed X columns.
  if (surnameTokens.length === 0) {
    rois = {
      ...PDS2025_PAGE1_ROIS,
      surname:     expandRoiY(PDS2025_PAGE1_ROIS.surname,     0.06),
      first_name:  expandRoiY(PDS2025_PAGE1_ROIS.first_name,  0.06),
      middle_name: expandRoiY(PDS2025_PAGE1_ROIS.middle_name, 0.06),
    };
    surnameTokens = page0.filter((t) => insideRoi(t.box, rois.surname));
  }

  const firstTokens  = page0.filter((t) => insideRoi(t.box, rois.first_name));
  const middleTokens = page0.filter((t) => insideRoi(t.box, rois.middle_name));
  const extTokens    = page0.filter((t) => insideRoi(t.box, rois.name_extension));
  const dobTokens    = page0.filter((t) => insideRoi(t.box, rois.date_of_birth));

  const surnameRaw = pickNamePartFromTokenText(joinTokensLinewise(surnameTokens), "last")
    ?? lastNameToken(cleanAndRemoveLabels(joinTokensLinewise(surnameTokens)));
  const firstRaw   = pickTokenFromRoi(firstTokens, "leftmost", new Set([String(surnameRaw || "").toUpperCase()].filter(Boolean)))
    ?? pickNamePartFromTokenText(cleanAndRemoveLabels(joinTokensLinewise(firstTokens)), "first", new Set([String(surnameRaw || "").toUpperCase()].filter(Boolean)))
    ?? firstNameToken(cleanAndRemoveLabels(joinTokensLinewise(firstTokens)));
  const middleAvoid = new Set([String(firstRaw || "").toUpperCase(), String(surnameRaw || "").toUpperCase()].filter(Boolean));
  const middleRaw  = pickTokenFromRoi(middleTokens, "rightmost", middleAvoid)
    ?? pickNamePartFromTokenText(cleanAndRemoveLabels(joinTokensLinewise(middleTokens)), "middle", middleAvoid)
    ?? firstNameToken(cleanAndRemoveLabels(joinTokensLinewise(middleTokens)));
  const extRaw = joinTokensLinewise(extTokens);
  const dobRaw = joinTokensLinewise(dobTokens);

  console.log("[ROI2025] rois:", JSON.stringify({sur:rois.surname, first:rois.first_name, mid:rois.middle_name}));
  console.log("[ROI2025] raw tokens - sur:", surnameTokens.map(t=>t.text+"@"+t.box.midX.toFixed(3)+","+t.box.midY.toFixed(3)));
  console.log("[ROI2025] raw tokens - first:", firstTokens.map(t=>t.text+"@"+t.box.midX.toFixed(3)+","+t.box.midY.toFixed(3)));
  console.log("[ROI2025] raw tokens - mid:", middleTokens.map(t=>t.text+"@"+t.box.midX.toFixed(3)+","+t.box.midY.toFixed(3)));
  console.log("[ROI2025] cleaned - sur:", surnameRaw, "first:", firstRaw, "mid:", middleRaw);

  const lastRes = validatePersonName(surnameRaw, "last");
  if (!lastRes.ok) rejected.surname.push(...lastRes.reasons);
  const firstRes = validatePersonName(firstRaw, "first");
  if (!firstRes.ok) rejected.first_name.push(...firstRes.reasons);
  const middleRes = validatePersonName(middleRaw, "middle");
  if (!middleRes.ok) rejected.middle_name.push(...middleRes.reasons);
  console.log("[ROI2025] validation - sur:", lastRes.ok, firstRes.ok, middleRes.ok, "reasons:", lastRes.reasons, firstRes.reasons);

  const last_name = lastRes.ok ? lastRes.value : null;
  const first_name = firstRes.ok ? firstRes.value : null;
  const middle_name = middleRes.ok ? middleRes.value : null;

  const name_extension = (() => {
    const cleaned = clean(extRaw);
    if (!cleaned) return null;
    const tok = cleaned.split(" ").find((t) => /^[A-Za-z]{1,4}$/.test(t));
    return tok ? tok.toUpperCase() : null;
  })();

  const dobRes = validateDobToIso(dobRaw, { templateVersion: "2025" });
  if (!dobRes.ok) rejected.date_of_birth.push(...dobRes.reasons);
  const date_of_birth = dobRes.ok ? dobRes.value : null;

  const owner: OwnerCandidate | null = last_name && first_name
    ? {
        last_name,
        first_name,
        middle_name,
        name_extension,
        date_of_birth,
        gender: null,
        confidence: 0.96,
      }
    : null;

  const debug: RoiExtractDebug = {
    used: "roi",
    tokensUsed: {
      surname: surnameTokens.length,
      first_name: firstTokens.length,
      middle_name: middleTokens.length,
      name_extension: extTokens.length,
      date_of_birth: dobTokens.length,
    },
    avgTokenConfidence: {
      surname: avgConfidence(surnameTokens),
      first_name: avgConfidence(firstTokens),
      middle_name: avgConfidence(middleTokens),
      name_extension: avgConfidence(extTokens),
      date_of_birth: avgConfidence(dobTokens),
    },
    rejected,
  };

  return { owner, debug };
}

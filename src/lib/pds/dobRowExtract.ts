import { getDocumentAiTokens, type DocToken, type TokenBox } from "@/lib/pds/documentAiTokens";
import { truncatePdsDobValueAtIntrusion } from "@/lib/pds/ocrTextNormalize";
import type { PdsTemplateVersion } from "@/lib/pds/templateDetect";
import { parsePdsDobToIso } from "@/lib/pds/validators";

export type NormalizedRect = { x: number; y: number; w: number; h: number };

export type DobRowDebug = {
  labelFound: boolean;
  labelLineText: string | null;
  roi: NormalizedRect | null;
  rawTokensInRoi: Array<{ text: string; box: NormalizedRect }>;
  rawDateMatch: string | null;
  parsedIso: string | null;
  usedRule: "ddmm" | null;
  reasonsIfNull: string[];
};

function rectFromBox(b: TokenBox): NormalizedRect {
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

function tokenTextNorm(s: string) {
  return String(s || "")
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase()
    .trim();
}

function unionBox(tokens: DocToken[]): TokenBox | null {
  if (tokens.length === 0) return null;
  const minX = Math.min(...tokens.map((t) => t.box.minX));
  const maxX = Math.max(...tokens.map((t) => t.box.maxX));
  const minY = Math.min(...tokens.map((t) => t.box.minY));
  const maxY = Math.max(...tokens.map((t) => t.box.maxY));
  return { minX, maxX, minY, maxY, midX: (minX + maxX) / 2, midY: (minY + maxY) / 2 };
}

function groupTokensIntoLines(tokens: DocToken[]) {
  const sorted = tokens.slice().sort((a, b) => a.box.midY - b.box.midY);
  const lines: DocToken[][] = [];

  for (const t of sorted) {
    const h = Math.max(0.0001, t.box.maxY - t.box.minY);
    const tol = Math.max(0.012, h * 0.88);

    const last = lines[lines.length - 1];
    if (!last) {
      lines.push([t]);
      continue;
    }

    const lastMidY = last.reduce((acc, x) => acc + x.box.midY, 0) / last.length;
    if (Math.abs(t.box.midY - lastMidY) <= tol) last.push(t);
    else lines.push([t]);
  }

  for (const line of lines) line.sort((a, b) => a.box.minX - b.box.minX);
  return lines;
}

function lineTextNorm(line: DocToken[]) {
  return line.map((t) => tokenTextNorm(t.text)).filter(Boolean).join(" ");
}

const DEFAULT_PERSONAL_INFO_TOP_Y = 0.12;

function findPersonalInfoYRange(lines: DocToken[][]) {
  let personal: TokenBox | null = null;
  let family: TokenBox | null = null;

  for (const line of lines) {
    const txt = lineTextNorm(line);
    if (!txt) continue;
    const b = unionBox(line);
    if (!b) continue;
    if (!personal && txt.includes("PERSONAL") && txt.includes("INFORMATION")) {
      personal = b;
      continue;
    }
  }

  if (personal) {
    for (const line of lines) {
      const txt = lineTextNorm(line);
      if (!txt) continue;
      const b = unionBox(line);
      if (!b) continue;
      if (b.midY <= personal.midY) continue;
      if (txt.includes("FAMILY") && txt.includes("BACKGROUND")) {
        family = b;
        break;
      }
    }
  }

  const start = personal?.minY ?? DEFAULT_PERSONAL_INFO_TOP_Y;
  const end = family?.minY ?? Math.min(1, start + 0.45);
  return { start, end };
}

function yOverlapRatio(a: TokenBox, b: TokenBox) {
  const top = Math.max(a.minY, b.minY);
  const bot = Math.min(a.maxY, b.maxY);
  const inter = Math.max(0, bot - top);
  const ha = Math.max(1e-6, a.maxY - a.minY);
  const hb = Math.max(1e-6, b.maxY - b.minY);
  return inter / Math.min(ha, hb);
}

function tokensInRoiSameRow(tokens: DocToken[], roi: NormalizedRect, rowBox: TokenBox) {
  const x2 = roi.x + roi.w;
  const y2 = roi.y + roi.h;
  return tokens.filter((t) => {
    const inRoi = t.box.midX >= roi.x && t.box.midX <= x2 && t.box.midY >= roi.y && t.box.midY <= y2;
    if (!inRoi) return false;
    return yOverlapRatio(t.box, rowBox) >= 0.45;
  });
}

function joinTokensSmart(tokens: DocToken[]) {
  const sorted = tokens.slice().sort((a, b) => a.box.minX - b.box.minX);
  let out = "";
  for (let i = 0; i < sorted.length; i++) {
    const t = String(sorted[i].text || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (!out) {
      out = t;
      continue;
    }
    const prev = sorted[i - 1];
    const gap = sorted[i].box.minX - prev.box.maxX;
    if (gap >= 0 && gap <= 0.014) out = `${out}${t}`;
    else out = `${out} ${t}`;
  }
  return out.replace(/\s+/g, " ").trim();
}

function parseDobFromMatch(match: string): { iso: string | null; rule: "ddmm" | null; reasons: string[] } {
  const parsed = parsePdsDobToIso(match, "PDS_DDMMYYYY");
  return { iso: parsed.iso, rule: parsed.iso ? "ddmm" : null, reasons: parsed.reasons };
}

export function extractDobFromPersonalInfoRow(
  document: any,
  opts: { templateVersion: PdsTemplateVersion }
): { iso: string | null; debug: DobRowDebug } {
  const pageIndex = 0;
  const tokens = getDocumentAiTokens(document).filter((t) => t.pageIndex === pageIndex);
  const lines = groupTokensIntoLines(tokens);
  const yRange = findPersonalInfoYRange(lines);

  const debug: DobRowDebug = {
    labelFound: false,
    labelLineText: null,
    roi: null,
    rawTokensInRoi: [],
    rawDateMatch: null,
    parsedIso: null,
    usedRule: null,
    reasonsIfNull: [],
  };

  const personalLines = lines.filter((ln) => {
    const b = unionBox(ln);
    return b ? b.midY >= yRange.start && b.midY < yRange.end : false;
  });

  // Find DOB label line.
  const dobLine = personalLines
    .map((ln) => ({ ln, txt: lineTextNorm(ln), box: unionBox(ln) }))
    .filter((x) => x.box && x.txt.includes("DATE") && x.txt.includes("BIRTH"))
    .sort((a, b) => {
      // Prefer numbered "3" row when present
      const aHas3 = /(^|\s)3($|\s)/.test(a.txt);
      const bHas3 = /(^|\s)3($|\s)/.test(b.txt);
      if (aHas3 !== bHas3) return aHas3 ? -1 : 1;
      return (a.box as TokenBox).midY - (b.box as TokenBox).midY;
    })[0];

  if (!dobLine?.box) {
    debug.reasonsIfNull.push("dob_label_not_found");
    return { iso: null, debug };
  }

  debug.labelFound = true;
  debug.labelLineText = dobLine.txt;

  const norms = dobLine.ln.map((t) => tokenTextNorm(t.text));
  const dateIdx = norms.findIndex((n) => n === "DATE");
  const birthIdx = norms.findIndex((n) => n === "BIRTH");
  const labelTokens = dateIdx >= 0 && birthIdx >= 0
    ? dobLine.ln.slice(Math.min(dateIdx, birthIdx), Math.max(dateIdx, birthIdx) + 1)
    : dobLine.ln;

  const labelBox = unionBox(labelTokens) ?? dobLine.box;
  const citizenshipIdx = norms.findIndex((n) => n === "CITIZENSHIP");
  const citizenshipBox = citizenshipIdx >= 0 ? unionBox([dobLine.ln[citizenshipIdx]]) : null;

  const padX = 0.012;
  const xStart = Math.min(0.98, (labelBox?.maxX ?? 0) + padX);
  const xEnd = citizenshipBox ? Math.max(xStart, citizenshipBox.minX - padX) : Math.min(0.98, xStart + 0.22);

  const rowH = Math.max(0.01, dobLine.box.maxY - dobLine.box.minY);
  const yStart = Math.max(0, dobLine.box.minY - rowH * 0.06);
  const yEnd = Math.min(1, dobLine.box.maxY + rowH * 0.06);

  const roi: NormalizedRect = { x: xStart, y: yStart, w: Math.max(0, xEnd - xStart), h: Math.max(0, yEnd - yStart) };
  debug.roi = roi;

  const selected = tokensInRoiSameRow(tokens, roi, dobLine.box);
  debug.rawTokensInRoi = selected.map((t) => ({ text: String(t.text || "").trim(), box: rectFromBox(t.box) }));

  const rawJoined = truncatePdsDobValueAtIntrusion(joinTokensSmart(selected));
  const dateRegex = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/;
  const match = rawJoined.match(dateRegex);

  if (!match) {
    debug.reasonsIfNull.push("date_regex_not_found_in_roi");
    return { iso: null, debug };
  }

  debug.rawDateMatch = match[0];

  const parsed = parseDobFromMatch(match[0]);
  debug.parsedIso = parsed.iso;
  debug.usedRule = parsed.rule;

  if (!parsed.iso) {
    debug.reasonsIfNull.push(...parsed.reasons);
    return { iso: null, debug };
  }

  return { iso: parsed.iso, debug };
}

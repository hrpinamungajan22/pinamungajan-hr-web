import { getDocumentAiTokens, type TokenBox } from "@/lib/pds/documentAiTokens";
import { validateDobToIso, validatePersonName } from "@/lib/pds/validators";
import { PDS2018_PAGE1_ROIS, type Roi } from "@/lib/pds2018/templateMap";

export type OwnerCandidate = {
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  date_of_birth: string | null;
  confidence: number;
};

export type RoiExtractDebug = {
  used: "roi";
  tokensUsed: { surname: number; first_name: number; middle_name: number; date_of_birth: number };
  rejected: Record<string, string[]>;
};

const LABEL_WORDS = new Set([
  "SURNAME", "FIRST", "MIDDLE", "NAME", "DATE", "OF", "BIRTH", "DOB",
  "MIDDLLE", "MIDLE", "MIDDL", "SURNAM", "SURNANE", "F1RST", "F1RSTNAME",
  "B1RTH", "DAT", "BIRTHDATE"
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

function insideRoi(box: TokenBox, roi: Roi) {
  return box.midX >= roi.x && box.midX <= roi.x + roi.w && box.midY >= roi.y && box.midY <= roi.y + roi.h;
}

function join(tokens: Array<{ text: string; box: TokenBox }>) {
  const joined = tokens
    .slice()
    .sort((a, b) => a.box.minX - b.box.minX)
    .map((t) => clean(t.text))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanAndRemoveLabels(joined);
}

function pickToken(tokens: Array<{ text: string; box: TokenBox }>, prefer: "leftmost" | "rightmost", avoidUpper: Set<string> = new Set()) {
  const ordered = tokens
    .slice()
    .sort((a, b) => prefer === "leftmost" ? a.box.minX - b.box.minX : b.box.maxX - a.box.maxX);

  for (const token of ordered) {
    const picked = pickNamePartFromTokenText(token.text, prefer === "rightmost" ? "middle" : "first", avoidUpper);
    if (picked) return picked;
  }

  return null;
}

export function extractOwnerFromTokensRoi2018(document: any): { owner: OwnerCandidate | null; debug: RoiExtractDebug } {
  const tokens = getDocumentAiTokens(document);
  const pageIndex = 0;
  const pageTokens = tokens.filter((t) => t.pageIndex === pageIndex);

  const rejected: Record<string, string[]> = {
    surname: [],
    first_name: [],
    middle_name: [],
    date_of_birth: [],
  };

  const surnameTokens = pageTokens.filter((t) => insideRoi(t.box, PDS2018_PAGE1_ROIS.surname));
  const firstTokens = pageTokens.filter((t) => insideRoi(t.box, PDS2018_PAGE1_ROIS.first_name));
  const middleTokens = pageTokens.filter((t) => insideRoi(t.box, PDS2018_PAGE1_ROIS.middle_name));
  const dobTokens = pageTokens.filter((t) => insideRoi(t.box, PDS2018_PAGE1_ROIS.date_of_birth));

  const surnameRaw = pickNamePartFromTokenText(join(surnameTokens), "last")
    ?? lastNameToken(join(surnameTokens));
  const firstRaw = pickToken(firstTokens, "leftmost", new Set([String(surnameRaw || "").toUpperCase()].filter(Boolean)))
    ?? pickNamePartFromTokenText(join(firstTokens), "first", new Set([String(surnameRaw || "").toUpperCase()].filter(Boolean)))
    ?? firstNameToken(join(firstTokens));
  const middleAvoid = new Set([String(firstRaw || "").toUpperCase(), String(surnameRaw || "").toUpperCase()].filter(Boolean));
  const middleRaw = pickToken(middleTokens, "rightmost", middleAvoid)
    ?? pickNamePartFromTokenText(join(middleTokens), "middle", middleAvoid)
    ?? firstNameToken(join(middleTokens));
  const dobRaw = join(dobTokens);

  const lastRes = validatePersonName(surnameRaw, "last");
  if (!lastRes.ok) rejected.surname.push(...lastRes.reasons);
  const firstRes = validatePersonName(firstRaw, "first");
  if (!firstRes.ok) rejected.first_name.push(...firstRes.reasons);
  const middleRes = validatePersonName(middleRaw, "middle");
  if (!middleRes.ok) rejected.middle_name.push(...middleRes.reasons);

  const dobRes = validateDobToIso(dobRaw, { templateVersion: "2018" });
  if (!dobRes.ok) rejected.date_of_birth.push(...dobRes.reasons);

  const owner: OwnerCandidate | null = lastRes.ok && firstRes.ok
    ? {
        last_name: lastRes.value,
        first_name: firstRes.value,
        middle_name: middleRes.ok ? middleRes.value : null,
        date_of_birth: dobRes.ok ? dobRes.value : null,
        confidence: 0.94,
      }
    : null;

  return {
    owner,
    debug: {
      used: "roi",
      tokensUsed: {
        surname: surnameTokens.length,
        first_name: firstTokens.length,
        middle_name: middleTokens.length,
        date_of_birth: dobTokens.length,
      },
      rejected,
    },
  };
}

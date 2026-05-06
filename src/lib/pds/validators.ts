const LABEL_WORDS = [
  "CITIZENSHIP",
  "PERSONAL",
  "INFORMATION",
  "VIOLATION",
  "YES",
  "NO",
  "DATE",
  "BIRTH",
  "SEX",
  "SINGLE",
  "MARRIED",
  "WIDOWED",
  "SEPARATED",
  "MALE",
  "FEMALE",
  "READ",
  "THE",
  "AND",
  "FOR",
  "TO",
  "IN",
  "ON",
  "AT",
  "A",
  "AN",
  "ATTACHED",
  "GUIDE",
  "ABBREVIATE",
  "APPLICABLE",
  "NECESSARY",
  "SURNAME",
  "LAST",
  "FIRST",
  "MIDDLE",
  "NAME",
  "PLACE",
  "OF",
  "ADDRESS",
  "RESIDENTIAL",
  "PERMANENT",
  "TELEPHONE",
  "MOBILE",
  "EMAIL",
  "ID",
  "NO",
  "N/A",
  "NA",
];

const LABEL_SET = new Set(LABEL_WORDS);

const ALLOWED_SHORT = new Set(["JR", "SR", "II", "III", "IV"]);

export type DobParseOptions = {
  templateVersion?: "2018" | "2025" | "unknown";
};

export type ValidationResult = {
  ok: boolean;
  value: string | null;
  reasons: string[];
};

export type PdsDobParseResult = {
  iso: string | null;
  reasons: string[];
};

export type SafeDateDetectedFormat = "dd/mm" | "mm/dd" | "iso" | "unknown";

export type SafeDateParseResult = {
  iso: string | null;
  detectedFormat: SafeDateDetectedFormat;
  confidence: number;
  reasonsIfNull: string[];
};

export type SafeDateParseOptions = {
  templateVersion?: "2018" | "2025" | "unknown";
  isPds?: boolean;
  pdsLabelSuggestsDdMm?: boolean;
  evidenceDatesRaw?: string[];
};

function clean(s: string) {
  return String(s || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/[^0-9A-Za-z\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countLabelWords(value: string) {
  const u = value.toUpperCase();
  const toks = u.split(/\s+/g).filter(Boolean);
  let hits = 0;
  for (const t of toks) {
    if (LABEL_SET.has(t)) hits++;
  }
  return hits;
}

export function validatePersonName(raw: string, which: "last" | "first" | "middle"): ValidationResult {
  const reasons: string[] = [];
  const cleaned = clean(raw);
  if (!cleaned) return { ok: false, value: null, reasons: ["empty"] };

  const upper = cleaned.toUpperCase();
  const labelHits = countLabelWords(cleaned);

  if (LABEL_SET.has(upper)) reasons.push("equals_label_word");
  if (labelHits >= 2) reasons.push("contains_multiple_label_words");

  // Reject values that look like status rows / checkbox legends.
  if (/(SINGLE|MARRIED|WIDOWED|SEPARATED).*(MALE|FEMALE)/i.test(cleaned)) {
    reasons.push("looks_like_status_row");
  }

  // Must contain at least one letter and be short-ish.
  if (!/[A-Za-z]/.test(cleaned)) reasons.push("no_letters");
  if (cleaned.length > 60) reasons.push("too_long");

  // Token-level rules.
  const toks = cleaned.split(" ").filter(Boolean);
  if (toks.length === 1) {
    const t = toks[0].toUpperCase();
    if (LABEL_SET.has(t)) reasons.push("stopword_or_label_single_token");
    if (which === "last") {
      if (t.length <= 1 && !ALLOWED_SHORT.has(t)) reasons.push("too_short_single_token");
    } else if (which !== "middle") {
      if (t.length <= 3 && !ALLOWED_SHORT.has(t)) reasons.push("too_short_single_token");
    }
  }

  const stopTok = toks.find((t) => LABEL_SET.has(t.toUpperCase()));
  if (stopTok) reasons.push("contains_stopword_or_label_token");

  const badTok = toks.find((t) => !/^[A-Za-z\-]{1,}$/.test(t));
  if (badTok) reasons.push("invalid_token_chars");

  // Names are usually 1-5 tokens. Allow more for compound surnames but penalize.
  if (toks.length > 6) reasons.push("too_many_tokens");

  // If it includes common field headers, reject.
  if (/(DATE\s+OF\s+BIRTH|PLACE\s+OF\s+BIRTH|CITIZENSHIP|PERSONAL\s+INFORMATION)/i.test(cleaned)) {
    reasons.push("contains_header_phrase");
  }

  if (reasons.length > 0) return { ok: false, value: null, reasons };

  // Normalization: preserve original casing but collapse spaces.
  const normalized = cleaned.replace(/\s+/g, " ");

  // For last names, prefer ALL CAPS but do not force.
  if (which === "last") return { ok: true, value: normalized, reasons: [] };
  return { ok: true, value: normalized, reasons: [] };
}

export function validateDobToIso(raw: string, opts?: DobParseOptions): ValidationResult {
  const templateVersion: "2018" | "2025" | "unknown" = opts?.templateVersion ?? "unknown";

  const parsed = safeParseDateToIso(raw, {
    templateVersion,
    isPds: true,
    pdsLabelSuggestsDdMm: true,
  });
  if (!parsed.iso) return { ok: false, value: null, reasons: parsed.reasonsIfNull };
  return { ok: true, value: parsed.iso, reasons: [] };
}

export function parsePdsDobToIso(raw: string, mode: "PDS_DDMMYYYY"): PdsDobParseResult {
  void mode;
  const parsed = safeParseDateToIso(raw, {
    isPds: true,
    pdsLabelSuggestsDdMm: true,
  });
  return { iso: parsed.iso, reasons: parsed.iso ? [] : parsed.reasonsIfNull };
}

function inferPreferredOrderFromEvidence(evidence: string[]) {
  let ddMm = 0;
  let mmDd = 0;
  for (const raw of evidence) {
    const s = String(raw || "")
      .replace(/[Oo]/g, "0")
      .replace(/[Il]/g, "1")
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
      .trim();

    const m = s.replace(/\s+/g, "").match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) ddMm++;
    if (b > 12 && a <= 12) mmDd++;
  }
  if (ddMm > 0 && mmDd === 0) return "dd/mm" as const;
  if (mmDd > 0 && ddMm === 0) return "mm/dd" as const;
  return null;
}

export function safeParseDateToIso(raw: string, opts?: SafeDateParseOptions): SafeDateParseResult {
  const templateVersion: "2018" | "2025" | "unknown" = opts?.templateVersion ?? "unknown";
  const isPds = Boolean(opts?.isPds);
  const pdsLabelSuggestsDdMm = Boolean(opts?.pdsLabelSuggestsDdMm);
  const evidenceDatesRaw = Array.isArray(opts?.evidenceDatesRaw) ? opts?.evidenceDatesRaw : [];

  const reasons: string[] = [];
  const nowYear = new Date().getFullYear();

  const cleaned = String(raw || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il]/g, "1")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return { iso: null, detectedFormat: "unknown", confidence: 0, reasonsIfNull: ["empty"] };
  }

  const upper = cleaned.toUpperCase();
  if (/(^|\b)(MM|DD|YYYY)(\b|$)/.test(upper)) {
    return { iso: null, detectedFormat: "unknown", confidence: 0, reasonsIfNull: ["placeholder_tokens"] };
  }

  const normalizeIso = (y: number, month: number, day: number): SafeDateParseResult => {
    const localReasons: string[] = [];
    if (!(y >= 1900 && y <= nowYear + 1)) localReasons.push("year_out_of_range");
    if (!(month >= 1 && month <= 12)) localReasons.push("month_out_of_range");
    if (!(day >= 1 && day <= 31)) localReasons.push("day_out_of_range");
    if (localReasons.length > 0) {
      return { iso: null, detectedFormat: "unknown", confidence: 0, reasonsIfNull: localReasons };
    }
    return {
      iso: `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      detectedFormat: "unknown",
      confidence: 1,
      reasonsIfNull: [],
    };
  };

  const mIso = cleaned.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (mIso) {
    const y = Number(mIso[1]);
    const month = Number(mIso[2]);
    const day = Number(mIso[3]);
    const normalized = normalizeIso(y, month, day);
    if (!normalized.iso) return normalized;
    return { ...normalized, detectedFormat: "iso", confidence: 1 };
  }

  const m = cleaned.replace(/\s+/g, "").match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) {
    return { iso: null, detectedFormat: "unknown", confidence: 0, reasonsIfNull: ["no_date_match"] };
  }

  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(y)) {
    return { iso: null, detectedFormat: "unknown", confidence: 0, reasonsIfNull: ["no_date_match"] };
  }

  const evidencePref = inferPreferredOrderFromEvidence(evidenceDatesRaw);
  const pdsBoost = isPds && pdsLabelSuggestsDdMm && (templateVersion === "2018" || templateVersion === "2025") ? 2 : 0;

  if (a > 12 && b <= 12) {
    const normalized = normalizeIso(y, b, a);
    if (!normalized.iso) return normalized;
    return { ...normalized, detectedFormat: "dd/mm", confidence: 0.95 };
  }
  if (b > 12 && a <= 12) {
    const normalized = normalizeIso(y, a, b);
    if (!normalized.iso) return normalized;
    return { ...normalized, detectedFormat: "mm/dd", confidence: 0.95 };
  }

  // Ambiguous a<=12 && b<=12
  let ddMmScore = 0;
  let mmDdScore = 0;
  if (isPds) ddMmScore += 1;
  ddMmScore += pdsBoost;
  if (evidencePref === "dd/mm") ddMmScore += 2;
  if (evidencePref === "mm/dd") mmDdScore += 2;

  if (ddMmScore >= mmDdScore + 2) {
    const normalized = normalizeIso(y, b, a);
    if (!normalized.iso) return normalized;
    return { ...normalized, detectedFormat: "dd/mm", confidence: 0.7 };
  }

  if (mmDdScore >= ddMmScore + 2) {
    const normalized = normalizeIso(y, a, b);
    if (!normalized.iso) return normalized;
    return { ...normalized, detectedFormat: "mm/dd", confidence: 0.7 };
  }

  reasons.push("ambiguous_date_format");
  return { iso: null, detectedFormat: "unknown", confidence: 0, reasonsIfNull: reasons };
}

export function formatDateDdMmYyyy(iso: string | null | undefined) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function formatIsoToDdMmYyyy(iso: string | null | undefined) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

import { parsePdsDobToIso } from "@/lib/pds/validators";

export type OwnerCandidate = {
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  confidence: number;
};

const LABEL_WORDS_TO_FILTER = new Set([
  "NAME", "SURNAME", "FIRST", "MIDDLE", "LAST", "DATE", "BIRTH", "OF",
  "MIDDLLE", "MIDLE", "SURNAM", "SURNANE", "F1RST", "B1RTH"
]);

function cleanToken(s: string) {
  const cleaned = s
    .replace(/[^A-Za-z\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Filter out label words
  const words = cleaned.split(" ").filter(Boolean);
  const filtered = words.filter(w => !LABEL_WORDS_TO_FILTER.has(w.toUpperCase()));
  return filtered.join(" ").trim();
}

// Aggressive post-processing to remove any remaining label words from final result
function removeLabelWordsFromResult(result: string | null): string | null {
  if (!result) return null;
  
  // First, try to separate concatenated words like "AbeNAME" -> "Abe NAME"
  let cleaned = result
    .replace(/([a-z])(NAME|SURNAME|FIRST|MIDDLE|BIRTH)/gi, '$1 $2')
    .replace(/(NAME|SURNAME|FIRST|MIDDLE|BIRTH)([a-z])/gi, '$1 $2');
  
  const words = cleaned.split(/\s+/).filter(Boolean);
  const filtered = words.filter(w => {
    const upper = w.toUpperCase();
    // Skip pure label words
    if (LABEL_WORDS_TO_FILTER.has(upper)) return false;
    // Skip words that contain label substrings
    if (upper.includes("NAME") && upper.length <= 8) return false;
    if (upper === "SURNAM" || upper === "SURNAME" || upper === "SURNANE") return false;
    if (upper === "FIRST" || upper === "F1RST") return false;
    if (upper === "MIDDLE" || upper === "MIDDLLE" || upper === "MIDLE") return false;
    if (upper === "BIRTH" || upper === "B1RTH") return false;
    if (upper === "DATE" || upper === "OF") return false;
    return true;
  });
  
  return filtered.join(" ").trim() || null;
}

function isJunkFieldValue(cleaned: string) {
  const upper = cleaned.toUpperCase();
  if (!cleaned) return true;
  if (upper.includes("MM") || upper.includes("DD") || upper.includes("YYYY")) return true;
  if (upper.includes("(MM") || upper.includes("(DD") || upper.includes("(YYYY")) return true;
  if (upper.includes("NOT APPLICABLE")) return true;
  if (upper.includes("DO NOT ABBREVIATE")) return true;
  if (upper.includes("INDICATE")) return true;
  if (upper.includes("PLEASE")) return true;
  return false;
}

function isPlausibleNameValue(cleaned: string) {
  if (isJunkFieldValue(cleaned)) return false;
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  // Avoid grabbing generic words like NAME / SURNAME.
  const bad = new Set(["NAME", "SURNAME", "LAST", "FIRST", "MIDDLE", "DATE", "BIRTH"]);
  const meaningful = tokens.filter((t) => !bad.has(t.toUpperCase()));
  if (meaningful.length === 0) return false;
  // At least one token should have length >= 2.
  if (!meaningful.some((t) => t.length >= 2)) return false;
  return true;
}

const PDS_INSTRUCTION_IGNORE = new Set([
  "APPROPRIATE",
  "INFORMATION",
  "BOX",
  "BOXES",
  "CHECK",
  "TICK",
  "INDICATE",
  "THROUGH",
  "ACCOMPLISHED",
  "HANDWRITING",
  "SEPARATE",
  "SHEET",
  "FILLING",
  "OUT",
  "PERSONAL",
  "DATA",
  "BEFORE",
  "ACCOMPLISHING",
  "FORM",
  "READ",
  "ATTACHED",
  "GUIDE",
  "PRINT",
  "LEGIBLY",
  "WORK",
  "EXPERIENCE",
  "DO",
  "NOT",
  "ABBREVIATE",
  "APPLICABLE",
  "NA",
  "N/A",
  "NECESSARY",
]);

function trimToNameTokens(value: string, maxTokens: number) {
  const STOP = new Set([
    "NAME",
    "SURNAME",
    "LAST",
    "FIRST",
    "MIDDLE",
    "CITIZENSHIP",
    "FILIPINO",
    "DUAL",
    "CITIZEN",
    "CITIZENSHIP",
    "BIRTH",
    "DATE",
    "PLACE",
    "SEX",
    "MALE",
    "FEMALE",
    "ADDRESS",
  ]);

  const cleaned = cleanToken(value);
  if (!cleaned) return null;
  const tokens = cleaned.split(" ").filter(Boolean);

  const picked: string[] = [];
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (STOP.has(up)) break;
    if (PDS_INSTRUCTION_IGNORE.has(up)) continue;
    // Keep only likely name tokens (letters and hyphen) and avoid single-letter noise.
    if (!/^[A-Za-z\-]{2,}$/.test(tok)) continue;
    picked.push(tok);
    if (picked.length >= maxTokens) break;
  }

  if (picked.length === 0) return null;
  const out = picked.join(" ");
  return isPlausibleNameValue(out) ? out : null;
}

function chooseNamePart(value: string | null, which: "last" | "first" | "middle") {
  if (!value) return null;
  const toks = value.split(" ").filter(Boolean);
  if (toks.length <= 1) return value;
  // In some scans, OCR merges adjacent name cells so multiple tokens spill into one field.
  // Heuristic: surname should be the most "substantial" token (often the longest);
  // first name tends to be the last token; middle name tends to be the first token.
  if (which === "last") {
    const best = toks
      .filter((t) => /^[A-Za-z\-]{2,}$/.test(t))
      .sort((a, b) => b.length - a.length)[0];
    return best || toks[0] || null;
  }
  if (which === "middle") return toks[0] || null;
  return toks[toks.length - 1] || null;
}

function trimToDob(value: string) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[^0-9A-Za-z\/\-\.\s]/g, " ")
    .trim();
  if (!cleaned) return null;
  
  // Try multiple date patterns
  // Pattern 1: dd/mm/yyyy or dd-mm-yyyy
  const m1 = cleaned.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const month = m1[2].padStart(2, '0');
    const year = m1[3];
    // Validate reasonable date
    const d = parseInt(day);
    const m = parseInt(month);
    const y = parseInt(year);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
      return `${year}-${month}-${day}`;
    }
  }
  
  // Pattern 2: yyyy/mm/dd
  const m2 = cleaned.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (m2) {
    const year = m2[1];
    const month = m2[2].padStart(2, '0');
    const day = m2[3].padStart(2, '0');
    const d = parseInt(day);
    const m = parseInt(month);
    const y = parseInt(year);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
      return `${year}-${month}-${day}`;
    }
  }
  
  // Fallback to original parser
  const parsed = parsePdsDobToIso(cleaned, "PDS_DDMMYYYY");
  return parsed.iso;
}
 
function cleanDateToken(s: string) {
  return s.replace(/[^0-9A-Za-z\/\-\s]/g, " ").replace(/\s+/g, " ").trim();
}

function cutAtNextLabel(valueWindow: string, stopLabels: string[]) {
  const upper = valueWindow.toUpperCase();
  let cut = valueWindow.length;
  for (const lbl of stopLabels) {
    const i = upper.indexOf(lbl.toUpperCase());
    if (i !== -1 && i < cut) cut = i;
  }
  return valueWindow.slice(0, cut);
}

function toIsoDateFromLoose(s: string) {
  const cleaned = cleanDateToken(s);
  if (!cleaned) return null;
  return parsePdsDobToIso(cleaned, "PDS_DDMMYYYY").iso;
}

function pickValueAfterLabel(text: string, label: string, stopLabels: string[]) {
  // Prefer regex capture that tolerates punctuation/spacing and keeps values on the same line.
  const re = new RegExp(`${label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*[:\-]?\\s*([^\n\r]{0,120})`, "i");
  const m = text.match(re);
  if (m && m[1]) {
    const line = cutAtNextLabel(m[1], stopLabels);
    const cleaned = cleanToken(line);
    if (isPlausibleNameValue(cleaned)) {
      const tokens = cleaned.split(" ").filter(Boolean);
      if (tokens.length > 0) return tokens.slice(0, 3).join(" ");
    }
  }

  // Line-based parsing: common OCR output puts the label on its own line and the value on the next line.
  // This avoids accidentally capturing the previous field's value (e.g., SURNAME value reused for FIRST NAME).
  const labelUpper = label.toUpperCase();
  const stopSet = new Set(stopLabels.map((s) => s.toUpperCase()));
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    const normalized = raw
      .toUpperCase()
      .replace(/^\s*\d+\s*[\.|\)]\s*/, "")
      .replace(/[^A-Z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) continue;
    if (!normalized.startsWith(labelUpper)) continue;

    for (let j = i + 1; j < Math.min(i + 8, rawLines.length); j++) {
      const candidateRaw = rawLines[j] ?? "";
      const clipped = cutAtNextLabel(candidateRaw, stopLabels);
      const cleaned = cleanToken(clipped);
      if (!isPlausibleNameValue(cleaned)) continue;

      const cUpper = cleaned.toUpperCase();
      // Skip if OCR put another label where the value should be.
      if (stopSet.has(cUpper) || stopLabels.some((s) => cUpper.startsWith(s.toUpperCase()))) continue;

      const tokens = cleaned.split(" ").filter(Boolean);
      if (tokens.length === 0) continue;
      return tokens.slice(0, 3).join(" ");
    }
  }

  const upper = text.toUpperCase();
  const idx = upper.indexOf(label.toUpperCase());
  if (idx === -1) return null;

  // Larger window because OCR often loses line breaks / pushes values farther away.
  const window = text.slice(idx + label.length, idx + label.length + 320);
  const lines = window.split(/\r?\n/).slice(0, 6);
  for (const ln of lines) {
    const clipped = cutAtNextLabel(ln, stopLabels);
    const cleaned = cleanToken(clipped);
    if (!isPlausibleNameValue(cleaned)) continue;
    const tokens = cleaned.split(" ").filter(Boolean);
    if (tokens.length === 0) continue;
    return tokens.slice(0, 3).join(" ");
  }

  // As a last fallback, attempt to clean the whole window and cut at the next stop label.
  const clippedAll = cutAtNextLabel(window, stopLabels);
  const cleanedAll = cleanToken(clippedAll);
  if (!isPlausibleNameValue(cleanedAll)) return null;
  const tokensAll = cleanedAll.split(" ").filter(Boolean);
  if (tokensAll.length === 0) return null;
  return tokensAll.slice(0, 3).join(" ");
}

function pickDobAfterLabel(text: string, label: string, stopLabels: string[]) {
  const upper = text.toUpperCase();
  const idx = upper.indexOf(label.toUpperCase());
  if (idx === -1) return null;
  const window = text.slice(idx + label.length, idx + label.length + 120);
  const clipped = cutAtNextLabel(window, stopLabels);
  return toIsoDateFromLoose(clipped);
}

function pickSexAtBirth(text: string) {
  const checkedMark = "(?:\\[X\\]|\\(X\\)|X|✓|✔|☑|☒|■|▣|◼|█)";
  const uncheckedMark = "(?:\\[\\s\\]|\\(\\s\\)|\\[\\s*\\]|\\(\\s*\\)|□|☐|▢)";
  const checkedRe = (label: string) =>
    new RegExp(`(?:\\b${label}\\b\\s*${checkedMark}|${checkedMark}\\s*\\b${label}\\b)`, "i");
  const uncheckedRe = (label: string) =>
    new RegExp(`(?:\\b${label}\\b\\s*${uncheckedMark}|${uncheckedMark}\\s*\\b${label}\\b)`, "i");

  const labelMatch = text.match(/SEX\s*(?:AT\s*)?BIR?TH/i) || text.match(/SEX\s*\/\s*BIR?TH/i);
  const idx = labelMatch && typeof labelMatch.index === "number" ? labelMatch.index : -1;

  const window = idx >= 0 ? text.slice(idx, idx + 380) : text.slice(0, 2000);
  const wUpper = window.toUpperCase();

  const maleChecked = checkedRe("MALE").test(window);
  const femaleChecked = checkedRe("FEMALE").test(window);

  if (maleChecked && !femaleChecked) return "Male";
  if (femaleChecked && !maleChecked) return "Female";

  const maleUnchecked = uncheckedRe("MALE").test(window);
  const femaleUnchecked = uncheckedRe("FEMALE").test(window);
  if (femaleUnchecked && !maleUnchecked) return "Male";
  if (maleUnchecked && !femaleUnchecked) return "Female";

  // Fallback: if we cannot see the check mark, look for a section where both MALE and FEMALE
  // appear near each other and one of them has a check mark close by.
  const maleIdx = wUpper.indexOf("MALE");
  const femaleIdx = wUpper.indexOf("FEMALE");
  if (maleIdx !== -1 && femaleIdx !== -1 && Math.abs(maleIdx - femaleIdx) <= 140) {
    const start = Math.max(0, Math.min(maleIdx, femaleIdx) - 40);
    const end = Math.min(window.length, Math.max(maleIdx, femaleIdx) + 80);
    const tight = window.slice(start, end);
    const maleTight = checkedRe("MALE").test(tight);
    const femaleTight = checkedRe("FEMALE").test(tight);
    if (maleTight && !femaleTight) return "Male";
    if (femaleTight && !maleTight) return "Female";

    const maleUTight = uncheckedRe("MALE").test(tight);
    const femaleUTight = uncheckedRe("FEMALE").test(tight);
    if (femaleUTight && !maleUTight) return "Male";
    if (maleUTight && !femaleUTight) return "Female";
  }

  const hasMale = wUpper.includes("MALE");
  const hasFemale = wUpper.includes("FEMALE");
  if (hasMale && !hasFemale) return "Male";
  if (hasFemale && !hasMale) return "Female";

  // If both appear but we can't reliably detect the check mark, return null.
  return null;
}

function pickFirstNameBlockWindow(scopedText: string) {
  const upper = scopedText.toUpperCase();
  const candidates = ["SURNAME", "LAST NAME"]
    .map((lbl) => {
      const i = upper.indexOf(lbl);
      return i === -1 ? null : { lbl, i };
    })
    .filter(Boolean) as Array<{ lbl: string; i: number }>;

  if (candidates.length === 0) return scopedText;
  candidates.sort((a, b) => a.i - b.i);
  const start = candidates[0].i;
  return scopedText.slice(start, Math.min(scopedText.length, start + 1600));
}

function pickBetweenOrderedLabels(text: string, startLabel: string, endLabels: string[]) {
  const upper = text.toUpperCase();
  const startIdx = upper.indexOf(startLabel.toUpperCase());
  if (startIdx === -1) return null;

  const afterStart = startIdx + startLabel.length;
  let endIdx = -1;
  for (const e of endLabels) {
    const i = upper.indexOf(e.toUpperCase(), afterStart);
    if (i !== -1 && (endIdx === -1 || i < endIdx)) endIdx = i;
  }

  const raw = endIdx === -1 ? text.slice(afterStart, afterStart + 180) : text.slice(afterStart, endIdx);
  const clipped = cutAtNextLabel(raw, endLabels);
  const cleaned = cleanToken(clipped);
  if (!isPlausibleNameValue(cleaned)) return null;
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).join(" ");
}

function normalizeTokenText(s: string) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9\-\/]/g, "")
    .trim();
}

function tokenBox(layout: any, pageDim: any) {
  const poly = layout?.boundingPoly || layout?.bounding_poly;
  const normalized = (poly?.normalizedVertices || poly?.normalized_vertices || []) as any[];
  const absolute = (poly?.vertices || []) as any[];
  const hasNormalized = Array.isArray(normalized) && normalized.length > 0;
  const vertices = hasNormalized ? normalized : absolute;
  if (!Array.isArray(vertices) || vertices.length === 0) return null;

  const w = Number(pageDim?.width ?? 1) || 1;
  const h = Number(pageDim?.height ?? 1) || 1;

  const points = vertices
    .map((v: any) => {
      const x = v?.x !== undefined ? Number(v.x) : NaN;
      const y = v?.y !== undefined ? Number(v.y) : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return hasNormalized ? { x, y } : { x: x / w, y: y / h };
    })
    .filter(Boolean) as Array<{ x: number; y: number }>;

  if (points.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY, midY: (minY + maxY) / 2 };
}

function detectPdsOwnerCandidateSpatial(document: any): OwnerCandidate | null {
  const fullText = String(document?.text || "");
  const pages = (document?.pages || []) as any[];
  if (!Array.isArray(pages) || pages.length === 0) return null;

  type Tok = { t: string; u: string; pageIndex: number; box: { minX: number; maxX: number; minY: number; maxY: number; midY: number } };
  const all: Tok[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const p = pages[pageIndex];
    const dim = (p as any).dimension || {};
    const tokens = ((p as any).tokens || []) as any[];
    if (!Array.isArray(tokens) || tokens.length === 0) continue;

    for (const tok of tokens) {
      const anchored = tok?.layout?.textAnchor || tok?.layout?.text_anchor;
      const fromAnchor = anchored ? ((): string => {
        const segs = anchored?.textSegments || anchored?.text_segments || [];
        if (!Array.isArray(segs) || segs.length === 0) return "";
        return segs
          .map((seg: any) => {
            const start = Number(seg.startIndex ?? seg.start_index ?? 0);
            const end = Number(seg.endIndex ?? seg.end_index ?? 0);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
            return fullText.slice(start, end);
          })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      })() : "";
      const raw = fromAnchor || (tok?.text ?? "");
      const t = String(raw || "").replace(/\s+/g, " ").trim();
      const u = normalizeTokenText(t).toUpperCase();
      if (!u) continue;
      const box = tokenBox(tok?.layout, dim);
      if (!box) continue;
      all.push({ t, u, pageIndex, box });
    }
  }

  if (all.length === 0) return null;

  // Stabilize ordering for row/column queries.
  all.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (a.box.midY !== b.box.midY) return a.box.midY - b.box.midY;
    return a.box.minX - b.box.minX;
  });

  // PDS: owner name rows are near the top of page 1 inside the Personal Information table.
  // Keep this tight; otherwise OCR may match PLACE OF BIRTH / CIVIL STATUS rows.
  const NAME_LABEL_MAX_MIDY = 0.32;
  const DOB_LABEL_MAX_MIDY = 0.40;
  const NAME_LABEL_MIN_MIDY = 0.12;
  // Labels span the full width: SURNAME(x<0.18), FIRST NAME(x~0.42), MIDDLE NAME(x~0.65)
  const LABEL_COL_MAX_X = 0.90;

  function tokenMatches(tokenUpper: string, wantUpper: string) {
    if (!tokenUpper || !wantUpper) return false;
    if (tokenUpper === wantUpper) return true;
    // Tolerate punctuation/number prefixes/suffixes, e.g. "2" + "SURNAME" or "SURNAME:".
    if (tokenUpper.includes(wantUpper)) return true;
    return false;
  }

  function findLabelRowPhrase(labelTokens: string[], maxMidY: number) {
    const upperTokens = labelTokens.map((s) => s.toUpperCase());
    const rowBand = 0.03;
    const maxGap = 0.14;

    let best: { pageIndex: number; midY: number; rightX: number; leftX: number } | null = null;
    const first = upperTokens[0];
    for (const startTok of all) {
      if (startTok.pageIndex !== 0) continue;
      // Only consider label tokens in the left label column of the Personal Information table.
      if (startTok.box.minX > LABEL_COL_MAX_X) continue;
      if (startTok.box.midY < NAME_LABEL_MIN_MIDY) continue;
      if (startTok.box.midY > maxMidY) continue;
      if (!tokenMatches(startTok.u, first)) continue;

      let ok = true;
      let leftX = startTok.box.minX;
      let rightX = startTok.box.maxX;
      const midY = startTok.box.midY;
      let prev = startTok;

      for (let k = 1; k < upperTokens.length; k++) {
        const want = upperTokens[k];
        // Find the next matching token on same row, to the right.
        const next = all
          .filter((t) => t.pageIndex === 0)
          .filter((t) => Math.abs(t.box.midY - midY) <= rowBand)
          .filter((t) => t.box.minX >= prev.box.minX)
          .filter((t) => tokenMatches(t.u, want))
          .sort((a, b) => a.box.minX - b.box.minX)[0];

        if (!next) {
          ok = false;
          break;
        }
        if (next.box.minX - prev.box.maxX > maxGap) {
          ok = false;
          break;
        }

        leftX = Math.min(leftX, next.box.minX);
        rightX = Math.max(rightX, next.box.maxX);
        prev = next;
      }

      if (!ok) continue;
      const candidate = { pageIndex: 0, midY, rightX, leftX };
      if (!best || candidate.midY < best.midY) best = candidate;
    }

    return best;
  }

  const surnameRow =
    findLabelRowPhrase(["SURNAME"], NAME_LABEL_MAX_MIDY) ||
    findLabelRowPhrase(["LAST", "NAME"], NAME_LABEL_MAX_MIDY);
  const firstRow = findLabelRowPhrase(["FIRST", "NAME"], NAME_LABEL_MAX_MIDY);
  const middleRow = findLabelRowPhrase(["MIDDLE", "NAME"], NAME_LABEL_MAX_MIDY);
  const dobRow =
    findLabelRowPhrase(["DATE", "OF", "BIRTH"], DOB_LABEL_MAX_MIDY) ||
    findLabelRowPhrase(["BIRTHDATE"], DOB_LABEL_MAX_MIDY);

  // If label detection fails, we still try template regions below.

  function readRightOf(row: { pageIndex: number; midY: number; rightX: number }, field: "surname" | "first" | "middle") {
    // Tight Y-band: only 0.02 to prevent adjacent-row token bleeding.
    const band = 0.02;
    const minX = Math.max(row.rightX + 0.008, 0.16);
    // Per-column caps: each name field occupies its own X column.
    // SURNAME value: 0.17-0.42 | FIRST NAME value: 0.57-0.65 | MIDDLE NAME value: 0.80-0.88
    const minXOverride = field === "middle" ? Math.max(minX, 0.72) : minX;
    const maxX = field === "surname" ? 0.42 : field === "first" ? 0.65 : 0.84;

    // Filter out tokens that are likely label words
    const isLabelWord = (t: string) => {
      const u = t.toUpperCase();
      if (LABEL_WORDS_TO_FILTER.has(u)) return true;
      if (u === "NAME" || u === "SURNAME" || u === "FIRST" || u === "MIDDLE" || u === "BIRTH") return true;
      if (u.includes("NAME") && u.length <= 8) return true;
      return false;
    };

    const candidates = all
      .filter((t) => t.pageIndex === row.pageIndex)
      .filter((t) => Math.abs(t.box.midY - row.midY) <= band)
      .filter((t) => t.box.minX >= minXOverride)
      .filter((t) => t.box.minX <= maxX)
      .filter((t) => !isLabelWord(t.t)) // Exclude label tokens
      .sort((a, b) => a.box.minX - b.box.minX);

    // Read a contiguous cluster of tokens to avoid concatenating other far-away tokens.
    const picked: typeof candidates = [];
    let prevX = -1;
    for (const c of candidates) {
      if (picked.length === 0) {
        picked.push(c);
        prevX = c.box.maxX;
        continue;
      }
      const gap = c.box.minX - prevX;
      if (gap > 0.05) break;
      picked.push(c);
      prevX = c.box.maxX;
    }

    const joined = picked.map((c) => cleanToken(c.t)).join(" ").replace(/\s+/g, " ").trim();

    if (field === "surname") {
      const surnameToken = picked
        .map((c) => cleanToken(c.t))
        .filter(Boolean)
        .filter((t) => /^[A-Za-z\-]{2,}$/.test(t))
        .filter((t) => t === t.toUpperCase())
        .filter((t) => {
          const u = t.toUpperCase();
          // Reuse the same ignore list used by the name trimmer (instruction/header words).
          if (PDS_INSTRUCTION_IGNORE.has(u)) return false;
          // Extra safety: avoid common instruction words ending in -ING being picked as surname.
          if (/ING$/.test(u) && u.length > 6) return false;
          return true;
        })
        .sort((a, b) => b.length - a.length)[0];
      if (surnameToken) return surnameToken;
      return trimToNameTokens(joined, 3);
    }

    // First name: single word only
    if (field === "first") {
      return trimToNameTokens(joined, 1);
    }

    // Middle name: up to 2 words (e.g., "MARIA CRUZ" or single initial)
    if (field === "middle") {
      return trimToNameTokens(joined, 2);
    }

    return trimToNameTokens(joined, 2);
  }

  function readRightOfRaw(
    row: { pageIndex: number; midY: number; rightX: number },
    opts?: { minX?: number; maxX?: number }
  ) {
    const band = 0.03;
    const minX = opts?.minX ?? row.rightX + 0.012;
    const maxX = opts?.maxX ?? 0.62;

    const candidates = all
      .filter((t) => t.pageIndex === row.pageIndex)
      .filter((t) => Math.abs(t.box.midY - row.midY) <= band)
      .filter((t) => t.box.minX >= minX)
      .filter((t) => t.box.minX <= maxX)
      .sort((a, b) => a.box.minX - b.box.minX);

    const picked: typeof candidates = [];
    let prevX = -1;
    for (const c of candidates) {
      if (picked.length === 0) {
        picked.push(c);
        prevX = c.box.maxX;
        continue;
      }
      const gap = c.box.minX - prevX;
      if (gap > 0.06) break;
      picked.push(c);
      prevX = c.box.maxX;
    }

    const joined = picked.map((c) => cleanDateToken(cleanToken(c.t))).join(" ").replace(/\s+/g, " ").trim();
    return joined || null;
  }

  const lastFromLabel = surnameRow ? readRightOf(surnameRow, "surname") : null;
  const firstFromLabel = firstRow ? readRightOf(firstRow, "first") : null;
  const middleFromLabel = middleRow ? readRightOf(middleRow, "middle") : null;
  const dobFromLabel = dobRow
    ? trimToDob(
        String(
          // DOB label line often includes "(mm/dd/yyyy)" which can push rightX past the actual value.
          // Use a fixed value-cell range instead.
          readRightOfRaw(dobRow, { minX: 0.22, maxX: 0.40 }) ?? ""
        )
      )
    : null;

  function pickBestNameTokenFromRegion(
    pageIndex: number,
    region: { minX: number; maxX: number; minY: number; maxY: number },
    avoidUpper: Set<string>
  ) {
    const candidates = all
      .filter((t) => t.pageIndex === pageIndex)
      .filter((t) => t.box.minX >= region.minX && t.box.maxX <= region.maxX)
      .filter((t) => t.box.minY >= region.minY && t.box.maxY <= region.maxY)
      .map((t) => cleanToken(t.t))
      .filter(Boolean)
      .filter((t) => /^[A-Za-z\-]{2,}$/.test(t))
      .filter((t) => {
        const u = t.toUpperCase();
        if (avoidUpper.has(u)) return false;
        if (PDS_INSTRUCTION_IGNORE.has(u)) return false;
        if (/ING$/.test(u) && u.length > 6) return false;
        return true;
      });

    if (candidates.length === 0) return null;
    // Prefer longer and uppercase-looking tokens.
    const scored = candidates
      .map((t) => {
        const upperish = t === t.toUpperCase() ? 2 : 0;
        return { t, score: t.length + upperish };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0]?.t ?? null;
  }

  function readRegion(
    pageIndex: number,
    region: { minX: number; maxX: number; minY: number; maxY: number }
  ) {
    const candidates = all
      .filter((t) => t.pageIndex === pageIndex)
      .filter((t) => t.box.minX >= region.minX && t.box.maxX <= region.maxX)
      .filter((t) => t.box.minY >= region.minY && t.box.maxY <= region.maxY)
      .sort((a, b) => a.box.minX - b.box.minX);
    const joined = candidates.map((c) => cleanToken(c.t)).join(" ").replace(/\s+/g, " ").trim();
    return trimToNameTokens(joined, 2);
  }

  // Template region fallback: all three name fields are on the SAME Y row (horizontal columns).
  // SURNAME value: x 0.17-0.42 | FIRST NAME value: x 0.57-0.65 | MIDDLE NAME value: x 0.80-0.88
  const nameRowY = surnameRow?.midY ?? firstRow?.midY ?? middleRow?.midY ?? 0.242;
  const regionLast   = readRegion(0, { minX: 0.17, maxX: 0.42, minY: Math.max(0, nameRowY - 0.022), maxY: Math.min(1, nameRowY + 0.022) });
  const regionFirst  = readRegion(0, { minX: 0.57, maxX: 0.65, minY: Math.max(0, nameRowY - 0.022), maxY: Math.min(1, nameRowY + 0.022) });
  const regionMiddle = readRegion(0, { minX: 0.72, maxX: 0.84, minY: Math.max(0, nameRowY - 0.022), maxY: Math.min(1, nameRowY + 0.022) });

  function readRegionRaw(
    pageIndex: number,
    region: { minX: number; maxX: number; minY: number; maxY: number }
  ) {
    const candidates = all
      .filter((t) => t.pageIndex === pageIndex)
      .filter((t) => t.box.minX >= region.minX && t.box.maxX <= region.maxX)
      .filter((t) => t.box.minY >= region.minY && t.box.maxY <= region.maxY)
      .sort((a, b) => a.box.minX - b.box.minX);
    const joined = candidates
      .map((c) => cleanDateToken(cleanToken(c.t)))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return joined || null;
  }

  // DOB field: approximately 0.048 below name row on legal-normalized page.
  const regionDobRaw = readRegionRaw(0, { minX: 0.17, maxX: 0.42, minY: Math.max(0, nameRowY + 0.026), maxY: Math.min(1, nameRowY + 0.072) });
  const dobFromRegion = regionDobRaw ? trimToDob(regionDobRaw) : null;

  const lowQualitySurname = (v: string | null) => {
    if (!v) return true;
    const t = v.trim();
    if (t.length < 4) return true;
    if (/^(IAN|JAN|MGA|UNG|MUNG|PINAMUNG|PINAMUNGAJAN)$/i.test(t)) return true;
    return false;
  };

  // Prefer label-anchored reads; fall back to regions if missing.
  const finalLast = lastFromLabel || regionLast;
  const finalFirst = firstFromLabel || regionFirst;
  const finalMiddle = middleFromLabel || regionMiddle;
  const dob = dobFromLabel || dobFromRegion;

  const duplicate =
    Boolean(finalLast && finalFirst && finalLast === finalFirst) ||
    Boolean(finalLast && finalMiddle && finalLast === finalMiddle);

  const strongerLast = regionLast && (!finalLast || duplicate) ? regionLast : finalLast;
  const strongerFirst = regionFirst && (!finalFirst || duplicate) ? regionFirst : finalFirst;
  const strongerMiddle = regionMiddle && (!finalMiddle || duplicate) ? regionMiddle : finalMiddle;

  const finalOutLast = trimToNameTokens(strongerLast || "", 3);
  const finalOutFirst = trimToNameTokens(strongerFirst || "", 1);
  const finalOutMiddle = strongerMiddle ? trimToNameTokens(strongerMiddle, 2) : null;
  if (!finalOutLast || !finalOutFirst) return null;

  const chosenLast = chooseNamePart(finalOutLast, "last");
  const chosenFirst = chooseNamePart(finalOutFirst, "first");
  const chosenMiddle = chooseNamePart(finalOutMiddle, "middle");

  // If surname is still low quality (common when SURNAME label is missed), recover it from the band above FIRST NAME.
  const lastUpper = (chosenLast || "").toUpperCase();
  const avoidUpper = new Set<string>([(chosenFirst || "").toUpperCase(), (chosenMiddle || "").toUpperCase(), "THROUGH"]);
  const recoveredLast =
    (!chosenLast || lastUpper === "THROUGH" || lastUpper.length < 4) && firstRow?.midY != null
      ? pickBestNameTokenFromRegion(
          0,
          {
            minX: 0.22,
            maxX: 0.52,
            minY: Math.max(0, firstRow.midY - 0.08),
            maxY: Math.max(0, firstRow.midY - 0.015),
          },
          avoidUpper
        )
      : null;

  // If surname tokens include the same token as first/middle (spillover), prefer a different token.
  const upFirst = (chosenFirst || "").toUpperCase();
  const upMiddle = (chosenMiddle || "").toUpperCase();
  const lastToks = (finalOutLast || "").split(" ").filter(Boolean);
  const betterLast = lastToks
    .filter((t) => {
      const u = t.toUpperCase();
      if (!/^[A-Za-z\-]{2,}$/.test(t)) return false;
      if (u === upFirst) return false;
      if (upMiddle && u === upMiddle) return false;
      return true;
    })
    .sort((a, b) => b.length - a.length)[0];

  return {
    first_name: removeLabelWordsFromResult(chosenFirst),
    middle_name: removeLabelWordsFromResult(chosenMiddle),
    last_name: removeLabelWordsFromResult(recoveredLast || betterLast || chosenLast),
    date_of_birth: dob || null,
    gender: null,
    confidence: 0.97,
  };
}

export function detectPdsOwnerCandidateFromDocument(document: any): OwnerCandidate {
  const spatial = detectPdsOwnerCandidateSpatial(document);
  if (spatial) {
    const fullText = String(document?.text || "");
    const fallback = detectPdsOwnerCandidate(fullText);
    return {
      ...fallback,
      ...spatial,
      date_of_birth: fallback.date_of_birth,
      gender: fallback.gender,
      confidence: Math.max(spatial.confidence, fallback.confidence),
    };
  }
  return detectPdsOwnerCandidate(String(document?.text || ""));
}

/**
 * Fallback text-based regex extraction for PDS fields
 * Used when anchor/ROI methods fail to find name fields
 */
export function extractPdsOwnerFromTextFallback(fullText: string): OwnerCandidate | null {
  const text = fullText || "";
  const upper = text.toUpperCase();
  
  // Find the Personal Information section
  const personalSectionMatch = text.match(/PERSONAL\s+INFORMATION[\s\S]{0,2000}/i);
  if (!personalSectionMatch) return null;
  
  const section = personalSectionMatch[0];
  
  // Extract surname - more restrictive: single word or hyphenated
  const surnameMatch = section.match(/SURNAME[:\s]*\n?\s*([A-Za-z\-']+)/i) ||
                       section.match(/(?:^|\n)\s*\d*\.?\s*SURNAME[:\s]+([A-Za-z\-']+)/im) ||
                       section.match(/SUR(?:\s*NAME)?[:\s]*\n?\s*([A-Za-z']{2,})/i) ||
                       section.match(/SURN[A-Z]{1}E[:\s]*\n?\s*([A-Za-z']{2,})/i);
  
  // Extract first name - more restrictive: single word or hyphenated, not multiple words
  const firstNameMatch = section.match(/FIRST\s*NAME[:\s]*\n?\s*([A-Za-z\-']+)/i) ||
                         section.match(/(?:^|\n)\s*\d*\.?\s*FIRST\s*NAME[:\s]+([A-Za-z\-']+)/im) ||
                         section.match(/FIRST(?:\s*NAME)?[:\s]*\n?\s*([A-Za-z']{2,})/i);
  
  // Extract middle name - can be empty or single initial
  const middleNameMatch = section.match(/MIDDLE\s*NAME[:\s]*\n?\s*([A-Za-z\-']*)/i) ||
                          section.match(/(?:^|\n)\s*\d*\.?\s*MIDDLE\s*NAME[:\s]+([A-Za-z\-']*)/im) ||
                          section.match(/MIDDLE(?:\s*NAME)?[:\s]*\n?\s*([A-Za-z\-']*)/i);
  
  // Extract date of birth - look for dd/mm/yyyy or mm/dd/yyyy pattern near date of birth label
  // Also try to find any date pattern in the section as fallback
  const dobMatch = section.match(/DATE\s*OF\s*BIRTH[:\s]*\n?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i) ||
                   section.match(/(?:^|\n)\s*\d*\.?\s*DATE\s*OF\s*BIRTH[:\s]+(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/im) ||
                   section.match(/BIRTH(?:\s*DATE)?[:\s]*\n?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i) ||
                   section.match(/D\.?O\.?B\.?[:\s]*\n?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i) ||
                   // More flexible: date pattern after BIRTH or DOB anywhere in section
                   section.match(/(?:BIRTH|DOB)[^\n]{0,30}(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i) ||
                   section.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})[^\n]{0,20}(?:BIRTH|DOB)/i) ||
                   // Just find any date pattern in the first 1000 chars of section
                   section.slice(0, 1000).match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/);
  
  let surname = surnameMatch?.[1]?.trim() || null;
  let firstName = firstNameMatch?.[1]?.trim() || null;
  let middleName = middleNameMatch?.[1]?.trim() || null;
  let dob = dobMatch?.[1]?.trim() || null;
  
  // Clean up common OCR errors
  if (surname) {
    surname = surname.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim();
    // Remove if it's a label word
    if (/^(SURNAME|LAST|NAME|FIRST|MIDDLE|DATE|BIRTH)$/i.test(surname)) surname = null;
  }
  if (firstName) {
    firstName = firstName.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim();
    if (/^(SURNAME|LAST|NAME|FIRST|MIDDLE|DATE|BIRTH)$/i.test(firstName)) firstName = null;
  }
  if (middleName) {
    middleName = middleName.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim();
    if (/^(SURNAME|LAST|NAME|FIRST|MIDDLE|DATE|BIRTH)$/i.test(middleName)) middleName = null;
  }
  
  // Convert DOB to ISO format
  let dobIso: string | null = null;
  if (dob) {
    const dobClean = dob.replace(/[\-.]/g, '/');
    const parts = dobClean.split('/');
    if (parts.length === 3) {
      const [a, b, year] = parts;
      const day = a.padStart(2, '0');
      const month = b.padStart(2, '0');
      dobIso = `${year}-${month}-${day}`;
    }
  }
  
  if (!surname || !firstName) return null;

  // Apply label filtering to final results
  surname = removeLabelWordsFromResult(surname);
  firstName = removeLabelWordsFromResult(firstName);
  middleName = removeLabelWordsFromResult(middleName);

  return {
    first_name: firstName,
    middle_name: middleName,
    last_name: surname,
    date_of_birth: dobIso,
    confidence: 0.75,
    gender: null,
  };
}

function sliceSection(source: string, startMarkers: string[], endMarkers: string[]) {
  const upper = source.toUpperCase();
  let start = -1;
  for (const s of startMarkers) {
    const i = upper.indexOf(s.toUpperCase());
    if (i !== -1) {
      start = i;
      break;
    }
  }
  if (start === -1) return source;

  let end = source.length;
  for (const e of endMarkers) {
    const i = upper.indexOf(e.toUpperCase(), start + 10);
    if (i !== -1 && i < end) end = i;
  }
  return source.slice(start, end);
}

export function detectPdsOwnerCandidate(fullText: string): OwnerCandidate {
  const text = fullText || "";
  const scopedText = sliceSection(
    text,
    ["PERSONAL INFORMATION", "I. PERSONAL INFORMATION"],
    [
      "FAMILY BACKGROUND",
      "II. FAMILY BACKGROUND",
      "EDUCATIONAL BACKGROUND",
      "II. EDUCATIONAL BACKGROUND",
      "III.",
    ]
  );

  const COMMON_STOPS = [
    "SURNAME",
    "LAST NAME",
    "FIRST NAME",
    "MIDDLE NAME",
    "DATE OF BIRTH",
    "BIRTHDATE",
    "SEX",
    "GENDER",
    "APPOINTMENT",
    "APPOINTMENT DATE",
    "POSITION",
  ];

  // Template-based anchoring: find the first occurrence of the name block labels and
  // only parse within a local window near that block. This avoids picking repeated labels
  // later in the document and reduces swapped first/middle issues caused by OCR ordering.
  const nameWindow = pickFirstNameBlockWindow(scopedText);

  const last =
    pickBetweenOrderedLabels(nameWindow, "SURNAME", ["FIRST NAME", "MIDDLE NAME", "DATE OF BIRTH", "BIRTHDATE", "SEX"]) ||
    pickBetweenOrderedLabels(nameWindow, "LAST NAME", ["FIRST NAME", "MIDDLE NAME", "DATE OF BIRTH", "BIRTHDATE", "SEX"]) ||
    pickValueAfterLabel(nameWindow, "SURNAME", COMMON_STOPS) ||
    pickValueAfterLabel(nameWindow, "LAST NAME", COMMON_STOPS);

  const first =
    pickBetweenOrderedLabels(nameWindow, "FIRST NAME", ["MIDDLE NAME", "DATE OF BIRTH", "BIRTHDATE", "SEX"]) ||
    pickValueAfterLabel(nameWindow, "FIRST NAME", COMMON_STOPS);

  const middle =
    pickBetweenOrderedLabels(nameWindow, "MIDDLE NAME", ["DATE OF BIRTH", "BIRTHDATE", "SEX"]) ||
    pickValueAfterLabel(nameWindow, "MIDDLE NAME", COMMON_STOPS);
  const dob =
    pickDobAfterLabel(scopedText, "DATE OF BIRTH", COMMON_STOPS) ||
    pickDobAfterLabel(scopedText, "BIRTHDATE", COMMON_STOPS);

  const gender = pickSexAtBirth(scopedText);

  const hasAll = Boolean(last && first);
  const confidence = hasAll ? 0.8 : last || first ? 0.5 : 0.0;

  return {
    first_name: first || null,
    middle_name: middle || null,
    last_name: last || null,
    date_of_birth: dob || null,
    gender: gender || null,
    confidence,
  };
}

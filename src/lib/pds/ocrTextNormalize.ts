/**
 * Light-weight cleanup for PDS fields before validation.
 * Improves accuracy when Cloud Vision / Document AI splits or mis-reads glyphs.
 */
export function normalizePdsOcrPersonField(raw: string): string {
  let s = String(raw || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\|/g, "I")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[,;:._]+$/g, "")
    .trim();

  // Common Vision substitutions adjacent to letters (conservative).
  s = s.replace(/\b1([A-Za-z])/g, "I$1").replace(/([A-Za-z])1\b/g, "$1I");

  return s;
}

/** Cut name reads when OCR merged the next block (Family Background / Spouse / IDs). */
export function truncatePdsNameValueAtIntrusion(raw: string): string {
  let s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return s;

  const patterns: RegExp[] = [
    /\s+SPOUS(E|ES)\b/i,
    /\s+OCCUPATION\b/i,
    /\s+HOUSEWIFE\b/i,
    /\s+CHILD(REN)?\b/i,
    /\s+FATHERS?\b/i,
    /\s+MOTHERS?\b/i,
    /\s+MAIDEN\b/i,
    /\s+EMPLOYER\b/i,
    /\s+TELEPHONE\b/i,
    /\s+BUSINESS\b/i,
    /\s+ADDRESS\b/i,
    /\s+NAME\s+EXTENSION\b/i,
    /\s+LIST\s+ALL\b/i,
    /\bFULL\s+NAME\b/i,
    /\s+DATE\s+MM\b/i,
    /\sMM\s*\/\s*DD\b/i,
    /\s+OF\s+DD\b/i,
    /\bDD\s+OF\b/i,
    /\s+GSIS\b/i,
    /\s+PAG[\-\s]*IBIG\b/i,
    /\s+PHILHEALTH\b/i,
    /\s+CITIZENSHIP\b/i,
    /\s+RESIDENTIAL\b/i,
    /\s+PERMANENT\b/i,
    /\s+ZIP\b/i,
    /\s+MOBILE\b/i,
    /\s+E-?MAIL\b/i,
    /\s+SEX\b/i,
    /\s+CIVIL\b/i,
    /\s+HEIGHT\b/i,
    /\s+WEIGHT\b/i,
    /\s+BLOOD\b/i,
  ];

  let cut = s.length;
  for (const re of patterns) {
    const m = re.exec(s);
    if (m && typeof m.index === "number" && m.index > 0 && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut).trim();
}

/** Prevent DOB cell from swallowing "Place of birth" / "Sex" line. */
export function truncatePdsDobValueAtIntrusion(raw: string): string {
  let s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return s;

  const patterns: RegExp[] = [
    /\s+PLACE\s+OF\s+BIRTH\b/i,
    /\s+PLACE\s+OF\b/i,
    /\s+SEX\b/i,
    /\s+CIVIL\b/i,
    /\s+CITIZENSHIP\b/i,
    /\s+HEIGHT\b/i,
    /\s+WEIGHT\b/i,
  ];

  let cut = s.length;
  for (const re of patterns) {
    const m = re.exec(s);
    if (m && typeof m.index === "number" && m.index > 0 && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut).trim();
}

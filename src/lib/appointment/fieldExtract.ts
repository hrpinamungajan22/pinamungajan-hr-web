import { findSGAndStepFromSalary, validateSGWithSalary } from "../salaryGradeTable";
import { findMatchingOffice, normalizeOfficeName } from "./offices";
import { extractPositionFromPredefined } from "./positions";

/**
 * Appointment Form (CS Form No. 33-A) Field Extraction
 * Uses anchor-based ROI extraction to find values next to labels
 */

export type NormBox = { x: number; y: number; w: number; h: number };

export type AppointmentExtractResult = {
  owner: {
    last_name: string;
    first_name: string;
    middle_name?: string | null;
  } | null;
  position_title: string | null;
  office_department: string | null;
  sg: number | null;
  step: number | null; // NEW: Salary step 1-8
  monthly_salary: number | null;
  annual_salary: number | null;
  appointment_date: string | null; // ISO YYYY-MM-DD
  date_received: string | null; // ISO YYYY-MM-DD
  date_approved: string | null; // ISO YYYY-MM-DD
  plantilla_item_no: string | null;
  nature_of_appointment: "Original" | "Promotion" | "Transfer" | "Reassignment" | "Reinstatement" | "Detail" | null;
  status: "Permanent" | "Temporary" | "Co-terminus" | "Contractual" | "Casual" | "Job Order" | null;
  sg_from_salary: boolean; // NEW: indicates if SG was derived from salary lookup
  debug: AppointmentExtractDebug;
};

export type AppointmentExtractDebug = {
  foundLabels: Array<{ label: string; position: { x: number; y: number } }>;
  chosenRois: Array<{ field: string; roi: NormBox; confidence: number }>;
  extractedRawStrings: Record<string, string>;
  parsedValues: Record<string, any>;
  validationReasons: string[];
  pageIndex: number | null;
};

type Token = {
  text: string;
  box: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    midX: number;
    midY: number;
  };
  pageIndex: number;
};

function tokenTextUpper(t: Token): string {
  return String(t?.text || "").trim().toUpperCase();
}

function normalizeText(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[\u2013\u2014]/g, "-") // em/en dash to hyphen
    .trim();
}

function normalizeDisplayToken(token: string): string {
  const upper = String(token || "").toUpperCase();
  if (!upper) return "";
  if (/^[IVX]+$/.test(upper) || upper === "JR" || upper === "SR") return upper;
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

function normalizeDisplayText(value: string): string {
  return normalizeText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => normalizeDisplayToken(token.replace(/\.$/, "")))
    .join(" ");
}

function normalizedLines(fullText: string): string[] {
  return String(fullText || "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function parseOwnerCandidateLine(line: string): {
  last_name: string;
  first_name: string;
  middle_name?: string;
} | null {
  const cleanedLine = normalizeText(line)
    .replace(/^(MR|MRS|MS|MISS|DR|ATTY|ENGR|HON)\.?\s+/i, "")
    .replace(/,\s*(M\.?D\.?|PH\.?D\.?|JR\.?|SR\.?)\s*$/i, "")
    .trim();
  if (!cleanedLine) return null;

  const upperLine = cleanedLine.toUpperCase();
  if (/\b(REPUBLIC|PHILIPPINES|PROVINCE|MUNICIPALITY|OFFICE|MAYOR|NOTICE|SALARY|ADJUSTMENT|POSITION|TITLE|GRADE|MONTHLY|ANNUAL|COPY|FURNISHED|LOCAL|BUDGET|CIRCULAR|EXECUTIVE|CHIEF|VERY|YOURS|SIR|MADAM)\b/.test(upperLine)) {
    return null;
  }

  const parseTokens = (tokensInput: string[]) => {
    const tokens = tokensInput
      .map((token) => token.replace(/[^A-Za-z'.-]/g, "").trim())
      .filter(Boolean)
      .filter((token) => /^[A-Za-z][A-Za-z'.-]*$/.test(token));
    if (tokens.length < 2) return null;

    const firstName = normalizeDisplayText(tokens[0]);
    const lastName = normalizeDisplayText(tokens[tokens.length - 1]);
    const middleName = normalizeDisplayText(tokens.slice(1, -1).join(" ")) || undefined;
    if (!firstName || !lastName) return null;

    return {
      last_name: lastName,
      first_name: firstName,
      middle_name: middleName,
    };
  };

  if (cleanedLine.includes(",")) {
    const [lastPart, restPart] = cleanedLine.split(",", 2).map((part) => normalizeText(part));
    const restTokens = restPart.split(/\s+/).filter(Boolean);
    if (lastPart && restTokens.length >= 1) {
      const parsed = parseTokens([restTokens[0], ...restTokens.slice(1), lastPart]);
      if (parsed) return parsed;
    }
  }

  return parseTokens(cleanedLine.split(/\s+/));
}

function parseLabeledLineValue(fullText: string, labelPattern: RegExp): string | null {
  const lineMatch = String(fullText || "").match(labelPattern);
  return lineMatch ? normalizeText(lineMatch[1] || "") || null : null;
}

function cleanPositionCandidate(value: string): string | null {
  const cleaned = normalizeText(value)
    .replace(/\bSALARY\s+GRADE\b.*$/i, "")
    .replace(/\bITEM\s+NO\.?\b.*$/i, "")
    .replace(/\bSG\s*\d{1,2}.*$/i, "")
    .replace(/[,:;.-]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length < 3 || cleaned.length > 80) return null;
  if (/\b(RECEIVED|MUNICIPALITY|OFFICE|SALARY|ADJUSTMENT|NOTICE)\b/i.test(cleaned)) return null;
  return normalizeDisplayText(cleaned);
}

function cleanOfficeCandidate(value: string): string | null {
  const cleaned = normalizeOfficeName(
    normalizeText(value)
      .replace(/\(\s*OFFICE\s*\/\s*DEPARTMENT\s*\/\s*UNIT\s*\)/gi, "")
      .replace(/\bWITH\s+A\s+COMPENSATION\b.*$/i, "")
      .replace(/[,:;.-]+$/g, "")
      .toUpperCase()
  ).trim();
  if (!cleaned || cleaned.length < 5 || cleaned.length > 120) return null;
  return cleaned;
}

function extractCurrencyValues(text: string): number[] {
  const matches = String(text || "").match(/(?:[₱P]\s*)?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|(?:[₱P]\s*)?\d{4,6}(?:\.\d{2})?/gi) || [];
  const values = matches
    .map((raw) => parseCurrency(raw).value)
    .filter((value): value is number => Number.isFinite(value) && value !== null && value > 0);
  return Array.from(new Set(values));
}

function extractStepFromText(fullText: string): number | null {
  const text = String(fullText || "").toUpperCase();

  const stepPatterns = [
    /SALARY\s+SCHEDULE\s*:\s*SG\s*\d{1,2}\s*,\s*STEP\s*(\d)/i,
    /SG\s*\d{1,2}\s*[,.;-]?\s*STEP\s*(\d)/i,
    /STEP\s*[:\-]?\s*(\d)\b/i,
  ];

  for (const pattern of stepPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 8) return num;
  }

  return null;
}

/**
 * Find tokens matching a pattern within a region
 */
function findTokensInRegion(
  tokens: Token[],
  region: NormBox,
  pattern: RegExp,
  maxResults: number = 10
): Token[] {
  const results: Token[] = [];
  for (const t of tokens) {
    const cx = t.box.midX;
    const cy = t.box.midY;
    if (cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h) {
      if (pattern.test(t.text)) {
        results.push(t);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results;
}

/**
 * Find a label token and return its position
 */
function findLabelToken(tokens: Token[], patterns: RegExp[], region?: NormBox): Token | null {
  for (const t of tokens) {
    const cx = t.box.midX;
    const cy = t.box.midY;
    if (region && !(cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h)) {
      continue;
    }
    const upper = tokenTextUpper(t);
    for (const pattern of patterns) {
      if (pattern.test(upper)) {
        return t;
      }
    }
  }
  return null;
}

/**
 * Extract text to the right of a label within a row band
 */
function extractValueToRight(
  tokens: Token[],
  labelToken: Token,
  maxWidth: number = 0.4,
  yTolerance: number = 0.02
): string {
  const labelY = labelToken.box.midY;
  const labelX = labelToken.box.maxX;

  // Find tokens to the right within y-tolerance
  const candidates = tokens.filter((t) => {
    const cy = t.box.midY;
    const cx = t.box.minX;
    return cx > labelX && Math.abs(cy - labelY) <= yTolerance && cx < labelX + maxWidth;
  });

  // Sort by x position
  candidates.sort((a, b) => a.box.minX - b.box.minX);

  return normalizeText(candidates.map((t) => t.text).join(" "));
}

/**
 * Extract text within a region below a label
 */
function extractValueBelow(
  tokens: Token[],
  labelToken: Token,
  regionHeight: number = 0.05,
  maxWidth: number = 0.5
): string {
  const labelY = labelToken.box.maxY;
  const labelX = labelToken.box.minX;
  const centerX = labelToken.box.midX;

  const region: NormBox = {
    x: centerX - maxWidth / 2,
    y: labelY,
    w: maxWidth,
    h: regionHeight,
  };

  const candidates = tokens.filter((t) => {
    const cx = t.box.midX;
    const cy = t.box.midY;
    return cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h;
  });

  candidates.sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX);

  return normalizeText(candidates.map((t) => t.text).join(" "));
}

/**
 * Parse currency value from text (handles "Fifteen Thousand Five Hundred Seventeen Pesos" and "P 15,517.00")
 */
function parseCurrency(text: string): { value: number | null; raw: string } {
  const raw = String(text || "").trim();

  if (!raw) return { value: null, raw };

  // Check for peso symbol + number format: P 15,517.00 or ₱15,517.00
  const pesoMatch = raw.match(/[₱P]\s*([\d,]+\.?\d*)/i);
  if (pesoMatch) {
    const num = parseFloat(pesoMatch[1].replace(/,/g, ""));
    if (Number.isFinite(num) && num > 0) {
      return { value: num, raw };
    }
  }

  // Check for plain number with comma separators
  const numMatch = raw.match(/([\d,]+\.?\d*)\s*(?:PESOS?|PHP)?/i);
  if (numMatch) {
    const num = parseFloat(numMatch[1].replace(/,/g, ""));
    if (Number.isFinite(num) && num > 0) {
      return { value: num, raw };
    }
  }

  // Word-based number parsing (simplified - handles common cases)
  const wordNum = parseWordNumber(raw);
  if (wordNum !== null) {
    return { value: wordNum, raw };
  }

  return { value: null, raw };
}

/**
 * Simplified word-to-number parser for Philippine salary formats
 */
function parseWordNumber(text: string): number | null {
  const u = text.toUpperCase();

  // Common patterns in appointment forms
  const patterns: Array<{ pattern: RegExp; base: number; multiplier: number }> = [
    { pattern: /FIFTEEN\s+THOUSAND/i, base: 15, multiplier: 1000 },
    { pattern: /SIXTEEN\s+THOUSAND/i, base: 16, multiplier: 1000 },
    { pattern: /SEVENTEEN\s+THOUSAND/i, base: 17, multiplier: 1000 },
    { pattern: /EIGHTEEN\s+THOUSAND/i, base: 18, multiplier: 1000 },
    { pattern: /NINETEEN\s+THOUSAND/i, base: 19, multiplier: 1000 },
    { pattern: /TWENTY\s+THOUSAND/i, base: 20, multiplier: 1000 },
    { pattern: /TWENTY[-\s]?ONE\s+THOUSAND/i, base: 21, multiplier: 1000 },
    { pattern: /TWENTY[-\s]?TWO\s+THOUSAND/i, base: 22, multiplier: 1000 },
    { pattern: /TWENTY[-\s]?THREE\s+THOUSAND/i, base: 23, multiplier: 1000 },
    { pattern: /TWENTY[-\s]?FOUR\s+THOUSAND/i, base: 24, multiplier: 1000 },
    { pattern: /TWENTY[-\s]?FIVE\s+THOUSAND/i, base: 25, multiplier: 1000 },
    { pattern: /THIRTY\s+THOUSAND/i, base: 30, multiplier: 1000 },
    { pattern: /FORTY\s+THOUSAND/i, base: 40, multiplier: 1000 },
    { pattern: /FIFTY\s+THOUSAND/i, base: 50, multiplier: 1000 },
  ];

  for (const p of patterns) {
    if (p.pattern.test(u)) {
      let extra = 0;
      // Check for hundreds
      if (/FIVE\s+HUNDRED/i.test(u)) extra += 500;
      else if (/ONE\s+HUNDRED/i.test(u)) extra += 100;
      else if (/TWO\s+HUNDRED/i.test(u)) extra += 200;
      else if (/THREE\s+HUNDRED/i.test(u)) extra += 300;
      else if (/FOUR\s+HUNDRED/i.test(u)) extra += 400;
      else if (/SIX\s+HUNDRED/i.test(u)) extra += 600;
      else if (/SEVEN\s+HUNDRED/i.test(u)) extra += 700;
      else if (/EIGHT\s+HUNDRED/i.test(u)) extra += 800;
      else if (/NINE\s+HUNDRED/i.test(u)) extra += 900;

      // Check for tens
      if (/SEVENTEEN/i.test(u) && !/SEVENTEEN\s+THOUSAND/i.test(u)) extra += 17;
      else if (/SIXTEEN/i.test(u) && !/SIXTEEN\s+THOUSAND/i.test(u)) extra += 16;
      else if (/FIFTEEN/i.test(u) && !/FIFTEEN\s+THOUSAND/i.test(u)) extra += 15;
      else if (/FIFTY/i.test(u) && !/FIFTY\s+THOUSAND/i.test(u)) extra += 50;
      else if (/SEVENTY/i.test(u)) extra += 70;

      return p.base * p.multiplier + extra;
    }
  }

  return null;
}

/**
 * Parse SG value (must be 1-33)
 */
function parseSG(text: string): number | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Look for SG-XX or SG XX pattern
  const match = raw.match(/SG[\s-]*(\d{1,2})/i);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 33) return num;
  }

  // Just a number 1-33
  const num = parseInt(raw, 10);
  if (num >= 1 && num <= 33) return num;

  return null;
}

/**
 * Robust date parser with dd/mm/yyyy vs mm/dd/yyyy disambiguation
 */
export function parseAppointmentDate(
  text: string,
  options?: {
    evidenceDates?: string[];
  }
): { iso: string | null; detectedFormat: "dd/mm/yyyy" | "mm/dd/yyyy" | "unknown"; confidence: number } {
  const raw = String(text || "").trim();
  if (!raw) return { iso: null, detectedFormat: "unknown", confidence: 0 };

  // Extract date components
  const patterns = [
    // DD/MM/YYYY or MM/DD/YYYY with slashes
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    // DD-MM-YYYY or MM-DD-YYYY with hyphens
    /(\d{1,2})-(\d{1,2})-(\d{4})/,
    // DD.MM.YYYY or MM.DD.YYYY with dots
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const part1 = parseInt(match[1], 10);
      const part2 = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);

      // Validate year (reasonable range for appointments)
      if (year < 2000 || year > 2100) continue;

      // Disambiguation logic
      let day: number;
      let month: number;
      let detectedFormat: "dd/mm/yyyy" | "mm/dd/yyyy";

      if (part1 > 12) {
        // First part > 12, must be day (DD/MM/YYYY)
        day = part1;
        month = part2;
        detectedFormat = "dd/mm/yyyy";
      } else if (part2 > 12) {
        // Second part > 12, must be month (MM/DD/YYYY impossible)
        day = part2;
        month = part1;
        detectedFormat = "dd/mm/yyyy";
      } else {
        // Both <= 12, need more evidence
        // Prefer DD/MM/YYYY for Philippine documents
        // Check evidence dates if provided
        const evidence = options?.evidenceDates || [];
        let ddmmCount = 0;
        let mmddCount = 0;

        for (const ed of evidence) {
          const em = ed.match(pattern);
          if (em) {
            const ep1 = parseInt(em[1], 10);
            const ep2 = parseInt(em[2], 10);
            if (ep1 > 12) ddmmCount++;
            if (ep2 > 12) ddmmCount++;
          }
        }

        // Default to dd/mm/yyyy for PH documents
        if (ddmmCount > mmddCount) {
          day = part1;
          month = part2;
          detectedFormat = "dd/mm/yyyy";
        } else {
          // Conservative: use dd/mm/yyyy as default for PH context
          day = part1;
          month = part2;
          detectedFormat = "dd/mm/yyyy";
        }
      }

      // Validate day/month ranges
      if (day < 1 || day > 31 || month < 1 || month > 12) {
        continue;
      }

      // Create ISO date
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return { iso, detectedFormat, confidence: 0.85 };
    }
  }

  return { iso: null, detectedFormat: "unknown", confidence: 0 };
}

/**
 * Extract owner name from appointment form using text-based regex
 * Format: DR. FIRSTNAME MIDDLE LASTNAME (e.g., "DR. TOMOMI N. ABE")
 * Also handles: "FIRSTNAME M. LASTNAME, M.D." format
 */
function extractOwnerFromAppointmentText(fullText: string): {
  last_name: string;
  first_name: string;
  middle_name?: string;
} | null {
  const text = fullText.toUpperCase();

  const nameBeforeAppointment = text.match(/\b(MR|MRS|MS|MISS|DR|ATTY|ENGR|HON)\.?\s+([A-Z][A-Z\s.'-]{2,80}?)\s+YOU\s+ARE\s+HEREBY\s+APPOINTED\b/i);
  if (nameBeforeAppointment) {
    const parsed = parseOwnerCandidateLine(`${nameBeforeAppointment[1]} ${nameBeforeAppointment[2]}`);
    if (parsed) return parsed;
  }
  
  // Pattern 1: DR./MR./MS./MRS. followed by name (FIRST MIDDLE LAST format)
  // Handles: "DR. TOMOMI N. ABE" or "MR. ADONIS T. ABABAN"
  const titleMatch = text.match(/\b(DR|M(?:R|RS|S))\.?\s+([A-Z]+(?:\s+[A-Z]\.?)?\s+[A-Z]+)(?:,\s*(M\.?D\.?|PH\.?D\.?|JR\.?|SR\.?))?/i);
  if (titleMatch) {
    const namePart = titleMatch[2].trim();
    const suffix = titleMatch[3] || "";
    const parts = namePart.split(/\s+/);
    
    if (parts.length >= 2) {
      // Last token is last name (before any suffix)
      const lastName = parts[parts.length - 1];
      // First token is first name
      const firstName = parts[0];
      // Middle is everything in between (could be "N" or "N." or empty)
      const middleParts = parts.slice(1, parts.length - 1);
      const middleName = middleParts.join(" ").replace(/\.$/, "") || undefined;
      
      if (lastName && firstName) {
        return {
          last_name: lastName,
          first_name: firstName,
          middle_name: middleName,
        };
      }
    }
  }
  
  // Pattern 2: Name followed by M.D./PH.D. (e.g., "TOMOMI N. ABE, M.D.")
  const suffixMatch = text.match(/\b([A-Z]+(?:\s+[A-Z]\.?)?\s+[A-Z]+),?\s*(M\.?D\.?|PH\.?D\.?)/i);
  if (suffixMatch) {
    const namePart = suffixMatch[1].trim();
    const parts = namePart.split(/\s+/);
    
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      const firstName = parts[0];
      const middleParts = parts.slice(1, parts.length - 1);
      const middleName = middleParts.join(" ").replace(/\.$/, "") || undefined;
      
      if (lastName && firstName) {
        return {
          last_name: lastName,
          first_name: firstName,
          middle_name: middleName,
        };
      }
    }
  }
  
  // Pattern 3: Look for "You are hereby appointed" and extract name before it
  const appointedContext = text.match(/([A-Z][A-Z\s\.]+)(?:,\s*(M\.?D\.?|PH\.?D\.?))?\s+YOU\s+ARE\s+HEREBY\s+APPOINTED/i);
  if (appointedContext) {
    const namePart = appointedContext[1].trim();
    const parts = namePart.split(/\s+/).filter(p => p && p !== "DR" && p !== "DR.");
    
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      const firstName = parts[0];
      const middleParts = parts.slice(1, parts.length - 1);
      const middleName = middleParts.join(" ").replace(/\.$/, "") || undefined;
      
      if (lastName && firstName && lastName.length > 1 && firstName.length > 1) {
        return {
          last_name: lastName,
          first_name: firstName,
          middle_name: middleName,
        };
      }
    }
  }

  const lines = String(fullText || "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const sirIndex = lines.findIndex((line) => /^SIR[:.]?$/i.test(line));
  const candidateLines: string[] = [];

  if (sirIndex > 0) {
    for (let i = Math.max(0, sirIndex - 4); i < sirIndex; i += 1) {
      candidateLines.push(lines[i]);
    }
  }
  for (const line of lines.slice(0, 12)) {
    if (!candidateLines.includes(line)) candidateLines.push(line);
  }

  for (const line of candidateLines) {
    const parsed = parseOwnerCandidateLine(line);
    if (parsed) return parsed;
  }
  
  return null;
}

/**
 * Extract position title from "appointed as" line using text-based regex
 * Format: "appointed as [Position Title] (SG/JG/PG)"
 * Now uses predefined list for accurate matching
 */
function extractPositionFromText(fullText: string): string | null {
  const text = fullText.toUpperCase();

  const appointedAsMatch = fullText.match(/YOU\s+ARE\s+HEREBY\s+APPOINTED\s+AS\s+([\s\S]{1,160}?)(?=\(\s*POSITION\s*TITLE\s*\)|\(\s*S\s*G\s*\/\s*J\s*G\s*\/\s*P\s*G(?:\s*\d{1,2})?\s*\)|\bUNDER\b|\bSTATUS\s+AT\b)/i);
  const appointedAsPosition = appointedAsMatch ? cleanPositionCandidate(appointedAsMatch[1]) : null;
  if (appointedAsPosition) {
    return appointedAsPosition;
  }

  const labeledValue = parseLabeledLineValue(fullText, /POSITION\s+TITLE\s*[:\-]\s*([^\n\r]+)/i);
  const cleanedLabeledValue = labeledValue ? cleanPositionCandidate(labeledValue) : null;
  if (cleanedLabeledValue) {
    return cleanedLabeledValue;
  }

  const lines = normalizedLines(fullText);
  const positionLabelIndex = lines.findIndex((line) => /\(\s*POSITION\s*TITLE\s*\)/i.test(line));
  if (positionLabelIndex > 0) {
    const previousLinePosition = cleanPositionCandidate(lines[positionLabelIndex - 1]);
    if (previousLinePosition) {
      return previousLinePosition;
    }
  }

  const appointedLineIndex = lines.findIndex((line) => /YOU\s+ARE\s+HEREBY\s+APPOINTED\s+AS/i.test(line));
  if (appointedLineIndex >= 0) {
    const windowText = lines.slice(appointedLineIndex, appointedLineIndex + 3).join(" ");
    const inlineCandidate = cleanPositionCandidate(
      windowText
        .replace(/^.*?YOU\s+ARE\s+HEREBY\s+APPOINTED\s+AS\s+/i, "")
        .replace(/\(\s*POSITION\s*TITLE\s*\)/gi, "")
        .replace(/\(\s*S\s*G\s*\/\s*J\s*G\s*\/\s*P\s*G(?:\s*\d{1,2})?\s*\)/gi, "")
        .replace(/\bUNDER\b[\s\S]*$/i, "")
        .replace(/\bSTATUS\s+AT\b[\s\S]*$/i, "")
    );
    if (inlineCandidate) {
      return inlineCandidate;
    }

    const nextLinePosition = cleanPositionCandidate(lines[appointedLineIndex + 1] || "");
    if (nextLinePosition) {
      return nextLinePosition;
    }
  }
  
  // Debug: store what we're searching
  console.log("[DEBUG] Position extraction - text snippet:", text.substring(0, 1000));
  
  // PRIORITY 1: Use predefined position list for accurate matching
  const predefinedMatch = extractPositionFromPredefined(text);
  if (predefinedMatch) {
    console.log("[DEBUG] Position matched from predefined list:", predefinedMatch);
    return predefinedMatch;
  }
  
  // Priority 2: Look for specific position patterns that might not be in the list
  const specificPositions = [
    /METER\s+READER\s+[I1-9][VXI0-9]*/i,
    /ADMINISTRATIVE\s+(?:OFFICER|ASSISTANT)\s*[I1-9]*/i,
    /MUNICIPAL\s+ENGINEER\s*[I1-9]*/i,
    /WATERWORKS\s+(?:SUPERINTENDENT|MANAGER|CHIEF)/i,
    /CIVIL\s+SECURITY\s+(?:UNIT\s+)?(?:CHIEF|HEAD|OFFICER)/i,
    /TRAFFIC\s+MANAGEMENT\s+(?:UNIT\s+)?(?:CHIEF|HEAD|OFFICER)/i,
    /SANGGUNIANG\s+BAYAN\s+(?:SECRETARY|MEMBER)/i,
  ];
  
  for (const pattern of specificPositions) {
    const match = text.match(pattern);
    if (match) {
      console.log("[DEBUG] Specific position matched:", match[0]);
      return match[0].trim();
    }
  }
  
  // Priority 3: Look for "APPOINTED AS" followed by position and SG
  const appointPatterns = [
    // Match: "appointed as Meter Reader II (SG/JG/PG)"
    /APPOINTED\s+AS\s+([A-Z][A-Z\s]*?[I1-9][VXI0-9]*)(?:\s*\(\s*S\s*G|\s*\(\s*S\s*G\s*\/\s*J\s*G|\s+S\s*T\s*A\s*T\s*U\s*S)/i,
    // Match: "appointed as [position]" followed by newline or parenthesis
    /APPOINTED\s+AS\s+([A-Z][A-Z\s]{2,40}?)(?:\s*\(|\n|STATUS|PERMANENT|TEMPORARY)/i,
  ];
  
  for (const pattern of appointPatterns) {
    const match = text.match(pattern);
    if (match) {
      const position = match[1].trim();
      const cleanPosition = position
        .replace(/\s+/g, " ")
        .replace(/\s*[,.;]+$/, "")
        .trim();
      
      console.log("[DEBUG] Position pattern matched:", pattern.source);
      console.log("[DEBUG] Position cleaned:", cleanPosition);
      
      // Validate: reasonable length and no signature markers
      if (cleanPosition.length > 2 && cleanPosition.length < 60 && 
          !cleanPosition.includes("BY:") && !cleanPosition.includes("PERSONNEL") &&
          !cleanPosition.includes("SPECIALIST") && !cleanPosition.includes("ADMINISTRATIVE")) {
        return cleanPosition;
      }
    }
  }
  
  return null;
}

/**
 * Extract office/department using predefined list for accurate matching
 */
function extractOfficeFromText(fullText: string): string | null {
  const text = fullText.toUpperCase();

  const officeContextPatterns = [
    /STATUS\s+AT\s+(?:THE\s+)?([\s\S]{1,180}?)(?=\bWITH\s+A\s+COMPENSATION\b|\(\s*OFFICE\s*\/\s*DEPARTMENT\s*\/\s*UNIT\s*\)|\bWITH\b)/i,
    /UNDER\s+[\s\S]{1,120}?STATUS\s+AT\s+(?:THE\s+)?([\s\S]{1,180}?)(?=\bWITH\s+A\s+COMPENSATION\b|\(\s*OFFICE\s*\/\s*DEPARTMENT\s*\/\s*UNIT\s*\)|\bWITH\b)/i,
    /\(\s*OFFICE\s*\/\s*DEPARTMENT\s*\/\s*UNIT\s*\)\s*([\s\S]{1,180}?)(?=\bWITH\s+A\s+COMPENSATION\b|\bWITH\b|$)/i,
  ];

  for (const pattern of officeContextPatterns) {
    const match = fullText.match(pattern);
    if (!match) continue;
    const cleaned = cleanOfficeCandidate(match[1]);
    if (!cleaned) continue;
    const matchedOffice = findMatchingOffice(cleaned);
    if (matchedOffice) return matchedOffice;
    return cleaned;
  }

  const lines = normalizedLines(fullText);
  const officeLabelIndex = lines.findIndex((line) => /\(\s*OFFICE\s*\/\s*DEPARTMENT\s*\/\s*UNIT\s*\)/i.test(line));
  if (officeLabelIndex > 0) {
    const previousLineOffice = cleanOfficeCandidate(lines[officeLabelIndex - 1]);
    if (previousLineOffice) {
      const matchedOffice = findMatchingOffice(previousLineOffice);
      return matchedOffice || previousLineOffice;
    }
  }

  const statusLine = lines.find((line) => /STATUS\s+AT/i.test(line) && !/\(\s*PERMANENT\s*,\s*TEMPORARY/i.test(line));
  if (statusLine) {
    const statusLineOffice = cleanOfficeCandidate(statusLine.replace(/^.*?STATUS\s+AT\s+(?:THE\s+)?/i, ""));
    if (statusLineOffice) {
      const matchedOffice = findMatchingOffice(statusLineOffice);
      return matchedOffice || statusLineOffice;
    }
  }
  
  console.log("[DEBUG] Office extraction - using predefined list");
  
  // Priority 1: Look for specific office patterns in the text first
  // These are the most reliable indicators - ORDER MATTERS: longer patterns first!
  const specificOfficePatterns: { pattern: RegExp; office: string }[] = [
    { pattern: /OFFICE\s+OF\s+THE\s+MUNICIPAL\s+ENGINEER[\s\-]+MUNICIPAL\s+WATERWORKS\s+MANAGEMENT\s+SECTION/i, office: "OFFICE OF THE MUNICIPAL ENGINEER - MUNICIPAL WATERWORKS MANAGEMENT SECTION" },
    { pattern: /MUNICIPAL\s+ENGINEER[\s\-]+MUNICIPAL\s+WATERWORKS/i, office: "OFFICE OF THE MUNICIPAL ENGINEER - MUNICIPAL WATERWORKS MANAGEMENT SECTION" },
    { pattern: /OFFICE\s+OF\s+THE\s+MUNICIPAL\s+ENGINEER[\s\-]+WATERWORKS/i, office: "OFFICE OF THE MUNICIPAL ENGINEER - MUNICIPAL WATERWORKS MANAGEMENT SECTION" },
    { pattern: /WATERWORKS\s+MANAGEMENT\s+SECTION/i, office: "OFFICE OF THE MUNICIPAL ENGINEER - MUNICIPAL WATERWORKS MANAGEMENT SECTION" },
    { pattern: /OFFICE\s+OF\s+THE\s+MUNICIPAL\s+ENGINEER/i, office: "OFFICE OF THE MUNICIPAL ENGINEER" },
    { pattern: /MUNICIPAL\s+ENGINEER/i, office: "OFFICE OF THE MUNICIPAL ENGINEER" },
    { pattern: /HUMAN\s+RESOURCE\s+MANAGEMENT\s+OFFICE/i, office: "HUMAN RESOURCE MANAGEMENT OFFICE" },
    { pattern: /MUNICIPAL\s+MAYOR[\s\-]+TRAFFIC\s+MANAGEMENT/i, office: "OFFICE OF THE MUNICIPAL MAYOR - TRAFFIC MANAGEMENT UNIT" },
    { pattern: /MUNICIPAL\s+MAYOR[\s\-]+CIVIL\s+SECURITY/i, office: "OFFICE OF THE MUNICIPAL MAYOR - CIVIL SECURITY UNIT" },
    { pattern: /OFFICE\s+OF\s+THE\s+MUNICIPAL\s+MAYOR/i, office: "OFFICE OF THE MUNICIPAL MAYOR" },
    { pattern: /VICE\s+MAYOR/i, office: "OFFICE OF THE MUNICIPAL VICE MAYOR" },
    { pattern: /SANGGUNIANG\s+BAYAN/i, office: "OFFICE OF THE SANGGUNIANG BAYAN" },
  ];
  
  for (const { pattern, office } of specificOfficePatterns) {
    if (pattern.test(text)) {
      console.log("[DEBUG] Specific office pattern matched:", office);
      return office;
    }
  }
  
  // Priority 2: Use the predefined office list for exact/close matching
  const matchedOffice = findMatchingOffice(text);
  if (matchedOffice) {
    console.log("[DEBUG] Office matched from predefined list:", matchedOffice);
    return matchedOffice;
  }
  
  return null;
}

/**
 * Extract SG value from text using regex
 */
function extractSGFromText(fullText: string): number | null {
  const text = fullText.toUpperCase();

  const labeledValue = parseLabeledLineValue(fullText, /SALARY\s+GRADE\s*[:\-]\s*(\d{1,2})\b/i);
  if (labeledValue) {
    const num = parseInt(labeledValue, 10);
    if (num >= 1 && num <= 33) return num;
  }
  
  console.log("[DEBUG] SG extraction - searching text");
  
  // Priority 1: Look for SG/JG/PG pattern near position title
  // Pattern: "Meter Reader II (SG/JG/PG) 6" or similar
  const sgNearPosition = text.match(/\(\s*S\s*G\s*\/\s*J\s*G\s*\/\s*P\s*G(?:\s*(\d{1,2}))?\s*\)\s*(\d{1,2})?/i);
  if (sgNearPosition) {
    const num = parseInt(sgNearPosition[1] || sgNearPosition[2], 10);
    console.log("[DEBUG] SG found near position:", num);
    if (num >= 1 && num <= 33) return num;
  }
  
  // Priority 2: Look for "(SG" followed by number in parentheses
  const sgInParens = text.match(/\(\s*S\s*G[^)]*\)(\d{1,2})/i);
  if (sgInParens) {
    const num = parseInt(sgInParens[1], 10);
    console.log("[DEBUG] SG found in parens:", num);
    if (num >= 1 && num <= 33) return num;
  }
  
  // Priority 3: Look for SG/JG/PG with optional spaces
  const sgPatterns = [
    /\(\s*S\s*G\s*\/\s*J\s*G\s*\/\s*P\s*G\s*(\d{1,2})\s*\)/i,
    /S\s*G\s*[\/\s]*J\s*G\s*[\/\s]*P\s*G\s*(\d{1,2})/i,
    /\(\s*S\s*G\s*[^)]*\)\s*(\d{1,2})/i,
    /S\s*G\s*(\d{1,2})\b/i,
  ];
  
  for (const pattern of sgPatterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      console.log("[DEBUG] SG pattern matched:", pattern.source, "num:", num);
      if (num >= 1 && num <= 33) return num;
    }
  }
  
  return null;
}

/**
 * Extract monthly salary from text using regex
 * Handles: "P 15,517.00", "₱15,517.00", "Fifteen Thousand Five Hundred Seventeen Pesos"
 */
function extractSalaryFromText(fullText: string): { monthly: number | null; annual: number | null } {
  const text = fullText.toUpperCase();
  const lines = normalizedLines(fullText);

  const explicitAnnual = (() => {
    const annualLine = parseLabeledLineValue(fullText, /ANNUAL\s+SALARY\s*[:\-]\s*([^\n\r]+)/i);
    if (!annualLine) return null;
    const parsed = parseCurrency(annualLine).value;
    return parsed && parsed >= 1000 ? parsed : null;
  })();

  const compensationRateMatch = fullText.match(/COMPENSATION\s+RATE\s+OF[\s\S]{0,220}?\(([^)]*?[₱P]?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\)[\s\S]{0,40}?(?:PER\s+MONTH|\/\s*MONTH|MONTHLY)/i);
  if (compensationRateMatch) {
    const parsed = parseCurrency(compensationRateMatch[1]).value;
    if (parsed !== null && parsed >= 1000 && parsed <= 500000) {
      return { monthly: parsed, annual: explicitAnnual ?? parsed * 12 };
    }
  }

  const compensationLineIndex = lines.findIndex((line) => /COMPENSATION\s+RATE\s+OF/i.test(line));
  if (compensationLineIndex >= 0) {
    const compensationWindow = lines.slice(compensationLineIndex, compensationLineIndex + 3).join(" ");
    const values = extractCurrencyValues(compensationWindow).filter((value) => value >= 1000 && value <= 500000);
    if (values.length > 0) {
      const monthly = Math.max(...values);
      return { monthly, annual: explicitAnnual ?? monthly * 12 };
    }
  }

  const contextPatterns = [
    /ADJUSTED\s+MONTHLY\s+BASIC\s+SALARY[\s\S]{0,160}?((?:[₱P]\s*)?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /NEW\s+SALARY\s+SCHEDULE[\s\S]{0,120}?((?:[₱P]\s*)?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /ACTUAL\s+MONTHLY\s+BASIC\s+SALARY[\s\S]{0,160}?((?:[₱P]\s*)?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /MONTHLY\s+BASIC\s+SALARY[\s\S]{0,140}?((?:[₱P]\s*)?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
  ];

  for (const pattern of contextPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = parseCurrency(match[1]).value;
    if (parsed !== null && parsed >= 1000 && parsed <= 500000) {
      return { monthly: parsed, annual: explicitAnnual ?? parsed * 12 };
    }
  }

  const allLines = String(fullText || "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  for (let i = 0; i < allLines.length; i += 1) {
    const upper = allLines[i].toUpperCase();
    if (!/(ADJUSTED\s+MONTHLY\s+BASIC\s+SALARY|NEW\s+SALARY\s+SCHEDULE|ACTUAL\s+MONTHLY\s+BASIC\s+SALARY|MONTHLY\s+BASIC\s+SALARY)/.test(upper)) {
      continue;
    }
    const windowText = [allLines[i], allLines[i + 1], allLines[i + 2]].filter(Boolean).join(" ");
    const values = extractCurrencyValues(windowText).filter((value) => value >= 1000 && value <= 500000);
    if (values.length > 0) {
      const monthly = Math.max(...values);
      return { monthly, annual: explicitAnnual ?? monthly * 12 };
    }
  }
  
  // Pattern 1: P/₱ followed by number with comma and decimal
  const pesoMatch = text.match(/[₱P]\s*(\d{1,3}(?:,\d{3})*\.?\d{0,2})/);
  if (pesoMatch) {
    const numStr = pesoMatch[1].replace(/,/g, "");
    const num = parseFloat(numStr);
    if (num >= 1000 && num <= 500000) {
      return { monthly: num, annual: explicitAnnual ?? num * 12 };
    }
  }
  
  // Pattern 2: Number followed by "per month" or "monthly"
  const monthlyMatch = text.match(/(\d{1,3}(?:,\d{3})*)\s*(?:PESOS?)?\s*(?:PER\s+MONTH|MONTHLY)/i);
  if (monthlyMatch) {
    const numStr = monthlyMatch[1].replace(/,/g, "");
    const num = parseFloat(numStr);
    if (num >= 1000 && num <= 500000) {
      return { monthly: num, annual: explicitAnnual ?? num * 12 };
    }
  }

  const allValues = extractCurrencyValues(text).filter((value) => value >= 1000 && value <= 500000);
  if (allValues.length > 0) {
    const monthly = Math.max(...allValues);
    return { monthly, annual: explicitAnnual ?? monthly * 12 };
  }
  
  // Pattern 3: Word-based salary (e.g., "Fifteen Thousand Five Hundred Seventeen")
  const wordNum = parseWordNumber(text);
  if (wordNum !== null && wordNum >= 1000) {
    return { monthly: wordNum, annual: explicitAnnual ?? wordNum * 12 };
  }
  
  return { monthly: null, annual: null };
}

/**
 * Extract date of signing from text using regex
 * Handles: "FEB 19 2025", "19/02/2025", "February 19, 2025"
 * Prioritizes dates near "Date of Signing" label
 */
function extractDateOfSigningFromText(fullText: string): string | null {
  const text = fullText.toUpperCase();
  const normalizedText = String(fullText || "").replace(/\s*([\/\-.])\s*/g, "$1");
  const normalizedLineList = normalizedLines(fullText);
  
  const months: Record<string, number> = {
    JAN: 1, JANUARY: 1,
    FEB: 2, FEBRUARY: 2,
    MAR: 3, MARCH: 3,
    APR: 4, APRIL: 4,
    MAY: 5,
    JUN: 6, JUNE: 6,
    JUL: 7, JULY: 7,
    AUG: 8, AUGUST: 8,
    SEP: 9, SEPT: 9, SEPTEMBER: 9,
    OCT: 10, OCTOBER: 10,
    NOV: 11, NOVEMBER: 11,
    DEC: 12, DECEMBER: 12,
  };
  
  // PRIORITY 1: Look specifically for "Date of Signing" followed by MMM DD YYYY
  // This is the most reliable pattern for appointment forms
  const dateOfSigningPattern = /DATE\s+OF\s+SIGNING[\s\S]{0,50}?((JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*)\s+(\d{1,2})[,\s]+(\d{4})/i;
  const dateOfSigningMatch = text.match(dateOfSigningPattern);
  if (dateOfSigningMatch) {
    const monthName = dateOfSigningMatch[2].toUpperCase();
    const day = parseInt(dateOfSigningMatch[3], 10);
    const year = parseInt(dateOfSigningMatch[4], 10);
    
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      console.log("[DEBUG] Date found at 'Date of Signing':", `${monthName} ${day} ${year}`);
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const labeledNumericMatch = normalizedText.match(/DATE\s+OF\s+SIGNING[\s\S]{0,80}?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i);
  if (labeledNumericMatch) {
    const parsed = parseAppointmentDate(labeledNumericMatch[1]);
    if (parsed.iso) {
      return parsed.iso;
    }
  }

  const dateLabelIndex = normalizedLineList.findIndex((line) => /DATE\s+OF\s+SIGNING/i.test(line));
  if (dateLabelIndex >= 0) {
    for (const line of [normalizedLineList[dateLabelIndex - 2], normalizedLineList[dateLabelIndex - 1], normalizedLineList[dateLabelIndex], normalizedLineList[dateLabelIndex + 1]]) {
      if (!line) continue;
      const parsed = parseAppointmentDate(line);
      if (parsed.iso) {
        return parsed.iso;
      }
    }
  }
  
  // PRIORITY 2: Look for any MMM DD YYYY in the last 25% of the document (signature area)
  const textLines = text.split(/\n/);
  const lastQuarterStart = Math.floor(textLines.length * 0.75);
  const lastQuarter = textLines.slice(lastQuarterStart).join("\n");
  
  const mmmInLastQuarter = lastQuarter.match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\s+(\d{1,2})[,\s]+(\d{4})/i);
  if (mmmInLastQuarter) {
    const monthName = mmmInLastQuarter[1].toUpperCase();
    const day = parseInt(mmmInLastQuarter[2], 10);
    const year = parseInt(mmmInLastQuarter[3], 10);
    
    const month = months[monthName];
    if (month && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      console.log("[DEBUG] Date found in signature area:", `${monthName} ${day} ${year}`);
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  
  // PRIORITY 3: Look for any MMM DD YYYY in the document (excluding received dates)
  // Skip lines with "RECEIVED" or "MAR 18" (common received stamp dates)
  const allLines = text.split(/\n/);
  for (const line of allLines) {
    if (line.includes("RECEIVED") || line.includes("STAMP") || line.includes("DATE OF BIRTH")) continue;
    
    const mmmMatch = line.match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\s+(\d{1,2})[,\s]+(\d{4})/i);
    if (mmmMatch) {
      const monthName = mmmMatch[1].toUpperCase();
      const day = parseInt(mmmMatch[2], 10);
      const year = parseInt(mmmMatch[3], 10);
      
      // Skip if it looks like a received date (MAR 18 2025 pattern from stamp)
      if (monthName === "MAR" && day === 18) continue;
      
      const month = months[monthName];
      if (month && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
        console.log("[DEBUG] Date found in text:", `${monthName} ${day} ${year}`);
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  
  // LAST RESORT: DD/MM/YYYY format - only if no MMM format found
  // Only look in the last 20% of document to avoid false positives
  const lastFifthStart = Math.floor(textLines.length * 0.8);
  const lastFifth = textLines.slice(lastFifthStart).join("\n");
  
  const slashMatch = lastFifth.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (slashMatch) {
    const part1 = parseInt(slashMatch[1], 10);
    const part2 = parseInt(slashMatch[2], 10);
    const year = parseInt(slashMatch[3], 10);
    
    if (year >= 2000 && year <= 2100) {
      let day: number, month: number;
      
      // Assume DD/MM/YYYY format for Philippine documents
      if (part1 > 12) {
        day = part1;
        month = part2;
      } else if (part2 > 12) {
        day = part2;
        month = part1;
      } else {
        // Both <= 12, assume DD/MM/YYYY
        day = part1;
        month = part2;
      }
      
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  
  return null;
}

type TokenLine = {
  tokens: Token[];
  text: string;
  minY: number;
  maxY: number;
  midY: number;
  minX: number;
  maxX: number;
};

function groupTokensIntoLines(tokens: Token[]): TokenLine[] {
  const sorted = (tokens || [])
    .filter((token) => normalizeText(token?.text || ""))
    .slice()
    .sort((a, b) => a.box.midY - b.box.midY || a.box.minX - b.box.minX);

  const groups: Token[][] = [];
  for (const token of sorted) {
    const current = groups[groups.length - 1];
    if (!current) {
      groups.push([token]);
      continue;
    }

    const avgMidY = current.reduce((sum, item) => sum + item.box.midY, 0) / current.length;
    if (Math.abs(token.box.midY - avgMidY) <= 0.014) {
      current.push(token);
    } else {
      groups.push([token]);
    }
  }

  return groups
    .map((group) => {
      const row = group.slice().sort((a, b) => a.box.minX - b.box.minX);
      const ys = row.flatMap((token) => [token.box.minY, token.box.maxY]);
      const xs = row.flatMap((token) => [token.box.minX, token.box.maxX]);
      return {
        tokens: row,
        text: normalizeText(row.map((token) => token.text).join(" ")),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
        midY: row.reduce((sum, token) => sum + token.box.midY, 0) / row.length,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
      };
    })
    .filter((line) => Boolean(line.text));
}

function extractAppointmentFieldsFromTokens(
  tokens: Token[],
  options?: { evidenceDates?: string[] }
): Partial<AppointmentExtractResult> & { raw: Record<string, string> } {
  const lines = groupTokensIntoLines(tokens);
  const raw: Record<string, string> = {};
  const result: Partial<AppointmentExtractResult> & { raw: Record<string, string> } = { raw };

  const positionLabelIndex = lines.findIndex((line) => /\(\s*POSITION\s*TITLE\s*\)/i.test(line.text));
  const officeLabelIndex = lines.findIndex((line) => /\(\s*OFFICE\s*\/\s*DEPARTMENT\s*\/\s*UNIT\s*\)/i.test(line.text));
  const sgLineIndex = lines.findIndex((line) => /S\s*G\s*\/\s*J\s*G\s*\/\s*P\s*G/i.test(line.text));
  const compensationLineIndex = lines.findIndex((line) => /COMPENSATION\s+RATE\s+OF/i.test(line.text));
  const signingLineIndex = lines.findIndex((line) => /DATE\s+OF\s+SIGNING/i.test(line.text));
  const appointedLineIndex = lines.findIndex((line) => /YOU\s+ARE\s+HEREBY\s+APPOINTED\s+AS/i.test(line.text));

  if (appointedLineIndex >= 0) {
    const line = lines[appointedLineIndex];
    const inlinePosition = cleanPositionCandidate(
      line.text
        .replace(/^.*?YOU\s+ARE\s+HEREBY\s+APPOINTED\s+AS\s+/i, "")
        .replace(/\bUNDER\b[\s\S]*$/i, "")
        .replace(/\bSTATUS\s+AT\b[\s\S]*$/i, "")
        .replace(/\(\s*POSITION\s*TITLE\s*\)/gi, "")
        .replace(/\(\s*S\s*G\s*\/\s*J\s*G\s*\/\s*P\s*G(?:\s*\d{1,2})?\s*\)/gi, "")
    );
    if (inlinePosition) {
      result.position_title = inlinePosition;
      raw.position_title = line.text;
    }
  }

  if (!result.position_title && positionLabelIndex > 0) {
    for (const candidate of [lines[positionLabelIndex - 1], lines[positionLabelIndex - 2]].filter(Boolean) as TokenLine[]) {
      const cleaned = cleanPositionCandidate(candidate.text);
      if (cleaned) {
        result.position_title = cleaned;
        raw.position_title = candidate.text;
        break;
      }
    }
  }

  if (officeLabelIndex > 0) {
    for (const candidate of [lines[officeLabelIndex - 1], lines[officeLabelIndex - 2]].filter(Boolean) as TokenLine[]) {
      const cleaned = cleanOfficeCandidate(candidate.text);
      if (cleaned) {
        result.office_department = findMatchingOffice(cleaned) || cleaned;
        raw.office_department = candidate.text;
        break;
      }
    }
  }

  if (!result.office_department) {
    const statusLine = lines.find((line) => /STATUS\s+AT/i.test(line.text));
    if (statusLine) {
      const cleaned = cleanOfficeCandidate(statusLine.text.replace(/^.*?STATUS\s+AT\s+(?:THE\s+)?/i, ""));
      if (cleaned) {
        result.office_department = findMatchingOffice(cleaned) || cleaned;
        raw.office_department = statusLine.text;
      }
    }
  }

  if (sgLineIndex >= 0) {
    const sgWindow = [lines[sgLineIndex - 1], lines[sgLineIndex], lines[sgLineIndex + 1]].filter(Boolean).map((line) => line.text).join(" ");
    const parsedSg = extractSGFromText(sgWindow) ?? parseSG(sgWindow);
    if (parsedSg !== null) {
      result.sg = parsedSg;
      raw.sg = sgWindow;
    }
  }

  if (compensationLineIndex >= 0) {
    const salaryWindow = [lines[compensationLineIndex], lines[compensationLineIndex + 1], lines[compensationLineIndex + 2]]
      .filter(Boolean)
      .map((line) => line.text)
      .join(" ");
    const values = extractCurrencyValues(salaryWindow).filter((value) => value >= 1000 && value <= 500000);
    if (values.length > 0) {
      const monthly = Math.max(...values);
      result.monthly_salary = monthly;
      result.annual_salary = monthly * 12;
      raw.monthly_salary = salaryWindow;
    }
  }

  if (signingLineIndex >= 0) {
    for (const candidate of [lines[signingLineIndex - 2], lines[signingLineIndex - 1], lines[signingLineIndex], lines[signingLineIndex + 1]].filter(Boolean) as TokenLine[]) {
      const parsed = parseAppointmentDate(candidate.text, { evidenceDates: options?.evidenceDates });
      if (parsed.iso) {
        result.appointment_date = parsed.iso;
        raw.appointment_date = candidate.text;
        break;
      }
    }
  }

  return result;
}

/**
 * Main appointment field extraction function
 */
export function extractAppointmentFields(
  doc: any,
  options?: { pageIndex?: number; evidenceDates?: string[] }
): AppointmentExtractResult {
  const fullText: string = String(doc?.text || "");
  const tokens: Token[] = Array.isArray(doc?.tokens) ? (doc.tokens as Token[]) : [];
  const pageIndex = options?.pageIndex ?? 0;

  const debug: AppointmentExtractDebug = {
    foundLabels: [],
    chosenRois: [],
    extractedRawStrings: {},
    parsedValues: {},
    validationReasons: [],
    pageIndex,
  };

  const result: AppointmentExtractResult = {
    owner: null,
    position_title: null,
    office_department: null,
    sg: null,
    step: null,
    monthly_salary: null,
    annual_salary: null,
    appointment_date: null,
    date_received: null,
    date_approved: null,
    plantilla_item_no: null,
    nature_of_appointment: null,
    status: null,
    sg_from_salary: false,
    debug,
  };

  // Store raw text for debugging
  debug.extractedRawStrings.full_text_snippet = fullText.slice(0, 500);

  // 1) Extract owner name using text-based regex
  result.owner = extractOwnerFromAppointmentText(fullText);
  if (result.owner) {
    debug.parsedValues.owner = result.owner;
    debug.extractedRawStrings.owner = `${result.owner.first_name} ${result.owner.middle_name || ""} ${result.owner.last_name}`;
  }

  // 2) Position Title - use text-based extraction
  result.position_title = extractPositionFromText(fullText);
  if (result.position_title) {
    debug.parsedValues.position_title = result.position_title;
    debug.extractedRawStrings.position_title = result.position_title;
  }

  // 3) Office/Department - use text-based extraction
  result.office_department = extractOfficeFromText(fullText);
  if (result.office_department) {
    debug.parsedValues.office_department = result.office_department;
    debug.extractedRawStrings.office_department = result.office_department;
  }

  // 4) SG - use text-based extraction first
  const extractedSG = extractSGFromText(fullText);
  if (extractedSG !== null) {
    result.sg = extractedSG;
    debug.parsedValues.sg = extractedSG;
    debug.extractedRawStrings.sg = String(extractedSG);
  }

  const extractedStep = extractStepFromText(fullText);
  if (extractedStep !== null) {
    result.step = extractedStep;
    debug.parsedValues.step = extractedStep;
    debug.extractedRawStrings.step = String(extractedStep);
  }

  // 5) Monthly Salary - use text-based extraction
  const salaryResult = extractSalaryFromText(fullText);
  if (salaryResult.monthly !== null) {
    result.monthly_salary = salaryResult.monthly;
    result.annual_salary = salaryResult.annual;
    debug.parsedValues.monthly_salary = salaryResult.monthly;
    debug.parsedValues.annual_salary = salaryResult.annual;
    debug.extractedRawStrings.monthly_salary = String(salaryResult.monthly);
    
    // Use salary grade lookup to determine SG and Step
    const sgLookup = findSGAndStepFromSalary(salaryResult.monthly);
    if (sgLookup.sg !== null && sgLookup.step !== null) {
      // If we have both extracted SG and lookup SG, validate them
      if (result.sg !== null) {
        const validation = validateSGWithSalary(result.sg, salaryResult.monthly);
        debug.parsedValues.sg_validation = validation;
        
        // If extracted SG doesn't match salary-based SG, prefer salary-based
        // as it's more reliable from the lookup table
        if (!validation.valid && sgLookup.confidence > 80) {
          result.sg = sgLookup.sg;
          result.step = sgLookup.step;
          result.sg_from_salary = true;
          debug.parsedValues.sg_source = "salary_lookup";
          debug.parsedValues.sg_confidence = sgLookup.confidence;
        } else {
          if (result.step === null) result.step = sgLookup.step;
          result.sg_from_salary = false;
          debug.parsedValues.sg_source = "text_extraction";
        }
      } else {
        // No extracted SG, use lookup result
        result.sg = sgLookup.sg;
        if (result.step === null) result.step = sgLookup.step;
        result.sg_from_salary = true;
        debug.parsedValues.sg = sgLookup.sg;
        debug.parsedValues.step = sgLookup.step;
        debug.parsedValues.sg_source = "salary_lookup";
        debug.parsedValues.sg_confidence = sgLookup.confidence;
        debug.extractedRawStrings.sg = String(sgLookup.sg);
      }
    }
  }

  // 6) Date of Signing - use text-based extraction
  result.appointment_date = extractDateOfSigningFromText(fullText);
  if (result.appointment_date) {
    debug.parsedValues.appointment_date = result.appointment_date;
    debug.extractedRawStrings.appointment_date = result.appointment_date;
  }

  const tokenFallback = tokens.length > 0 ? extractAppointmentFieldsFromTokens(tokens, { evidenceDates: options?.evidenceDates }) : { raw: {} };

  if (!result.position_title && tokenFallback.position_title) {
    result.position_title = tokenFallback.position_title;
    debug.parsedValues.position_title = tokenFallback.position_title;
    debug.extractedRawStrings.position_title = tokenFallback.raw.position_title || tokenFallback.position_title;
  }

  if (!result.office_department && tokenFallback.office_department) {
    result.office_department = tokenFallback.office_department;
    debug.parsedValues.office_department = tokenFallback.office_department;
    debug.extractedRawStrings.office_department = tokenFallback.raw.office_department || tokenFallback.office_department;
  }

  if (result.sg === null && tokenFallback.sg !== undefined && tokenFallback.sg !== null) {
    result.sg = tokenFallback.sg;
    debug.parsedValues.sg = tokenFallback.sg;
    debug.extractedRawStrings.sg = tokenFallback.raw.sg || String(tokenFallback.sg);
  }

  if (result.monthly_salary === null && tokenFallback.monthly_salary !== undefined && tokenFallback.monthly_salary !== null) {
    result.monthly_salary = tokenFallback.monthly_salary;
    result.annual_salary = tokenFallback.annual_salary ?? tokenFallback.monthly_salary * 12;
    debug.parsedValues.monthly_salary = result.monthly_salary;
    debug.parsedValues.annual_salary = result.annual_salary;
    debug.extractedRawStrings.monthly_salary = tokenFallback.raw.monthly_salary || String(tokenFallback.monthly_salary);

    const sgLookup = findSGAndStepFromSalary(tokenFallback.monthly_salary);
    if (result.sg === null && sgLookup.sg !== null) {
      result.sg = sgLookup.sg;
      debug.parsedValues.sg = sgLookup.sg;
      debug.extractedRawStrings.sg = String(sgLookup.sg);
      result.sg_from_salary = true;
    }
    if (result.step === null && sgLookup.step !== null) {
      result.step = sgLookup.step;
      debug.parsedValues.step = sgLookup.step;
      debug.extractedRawStrings.step = String(sgLookup.step);
    }
  }

  if (!result.appointment_date && tokenFallback.appointment_date) {
    result.appointment_date = tokenFallback.appointment_date;
    debug.parsedValues.appointment_date = tokenFallback.appointment_date;
    debug.extractedRawStrings.appointment_date = tokenFallback.raw.appointment_date || tokenFallback.appointment_date;
  }

  // Validation summary
  const validations: string[] = [];
  if (!result.owner) validations.push("owner_not_found");
  if (!result.position_title) validations.push("position_not_found");
  if (!result.sg) validations.push("sg_not_found_or_invalid");
  if (!result.monthly_salary) validations.push("salary_not_found_or_invalid");
  if (!result.appointment_date) validations.push("appointment_date_not_found");
  debug.validationReasons = validations;

  return result;
}

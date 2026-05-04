export type DocumentType = 
  | "pds" 
  | "appointment" 
  | "oath" 
  | "assumption" 
  | "certification_lgu"
  | "nosa"
  | "nosi"
  | "ipcr"
  | "service_record"
  | "training"
  | "eligibility"
  | "pdf_generic"
  | "other"
  | "unknown";

export type DocumentDetectionResult = {
  type: DocumentType;
  confidence: number;
  evidence: {
    matched: string[];
    scores: Record<string, number>;
    stage: "text" | "layout" | "fallback";
  };
};

// Stage A: Text-based keyword/anchor detection
export function detectDocumentType(fullText: string): DocumentDetectionResult {
  const t = String(fullText || "");
  const u = t.toUpperCase();
  
  const results: Record<DocumentType, { score: number; matched: string[] }> = {
    pds: { score: 0, matched: [] },
    appointment: { score: 0, matched: [] },
    oath: { score: 0, matched: [] },
    assumption: { score: 0, matched: [] },
    certification_lgu: { score: 0, matched: [] },
    nosa: { score: 0, matched: [] },
    nosi: { score: 0, matched: [] },
    ipcr: { score: 0, matched: [] },
    service_record: { score: 0, matched: [] },
    training: { score: 0, matched: [] },
    eligibility: { score: 0, matched: [] },
    pdf_generic: { score: 0, matched: [] },
    other: { score: 0, matched: [] },
    unknown: { score: 0, matched: [] },
  };

  // Define detection rules with weights
  const rules: Array<{
    type: DocumentType;
    patterns: Array<{ regex: RegExp; weight: number; label: string }>;
    minMatches: number;
    threshold: number;
  }> = [
    {
      type: "pds",
      patterns: [
        { regex: /CS\s*FORM\s*NO\.?\s*212/i, weight: 8, label: "cs_form_212" },
        { regex: /PERSONAL\s+DATA\s+SHEET/i, weight: 8, label: "personal_data_sheet" },
        { regex: /PERSONAL\s+INFORMATION/i, weight: 2, label: "personal_information" },
        { regex: /SURNAME.*FIRST\s+NAME.*MIDDLE\s+NAME/i, weight: 2, label: "name_headers" },
        { regex: /REVISED\s*2017/i, weight: 2, label: "revised_2017" },
        { regex: /CS\s*FORM\s*212\s*ATTACHMENT/i, weight: 2, label: "pds_attachment" },
        { regex: /WORK\s*EXPERIENCE/i, weight: 1, label: "work_experience" },
        { regex: /VOLUNTARY\s*WORK/i, weight: 1, label: "voluntary_work" },
        { regex: /TRAINING\s*PROGRAMS/i, weight: 1, label: "training_programs" },
        { regex: /OTHER\s*INFORMATION/i, weight: 1, label: "other_information" },
      ],
      minMatches: 1,
      threshold: 4,
    },
    {
      type: "appointment",
      patterns: [
        { regex: /CS\s*FORM\s*NO\.?\s*33\s*-?\s*A/i, weight: 4, label: "cs_form_33a" },
        { regex: /YOU\s*ARE\s*HEREBY\s*APPOINTED/i, weight: 4, label: "hereby_appointed" },
        { regex: /POSITION\s*TITLE/i, weight: 3, label: "position_title" },
        { regex: /SG\s*[\/\\]\s*JG\s*[\/\\]\s*PG/i, weight: 3, label: "sg_jg_pg" },
        { regex: /COMPENSATION\s*RATE/i, weight: 2, label: "compensation_rate" },
        { regex: /PER\s*MONTH/i, weight: 2, label: "per_month" },
        { regex: /DATE\s*OF\s*SIGNING/i, weight: 2, label: "date_of_signing" },
        { regex: /CSC\s*ACTION/i, weight: 2, label: "csc_action" },
        { regex: /APPOINTING\s*OFFICER/i, weight: 2, label: "appointing_officer" },
        { regex: /PLANTILLA\s*ITEM\s*NO/i, weight: 2, label: "plantilla_item" },
        { regex: /NATURE\s*OF\s*APPOINTMENT/i, weight: 2, label: "nature_appointment" },
        { regex: /APPROVED/i, weight: 1, label: "approved_stamp" },
        { regex: /RECEIVED/i, weight: 1, label: "received_stamp" },
        { regex: /ORIGINAL\s*-\s*VICE/i, weight: 1, label: "original_vice" },
        { regex: /NEW\s*ITEM/i, weight: 1, label: "new_item" },
      ],
      minMatches: 3,
      threshold: 5,
    },
    {
      type: "oath",
      patterns: [
        { regex: /SUBSCRIBED\s*AND\s*SWORN/i, weight: 4, label: "subscribed_sworn" },
        { regex: /PERSON\s*ADMINISTERING\s*OATH/i, weight: 4, label: "person_admin_oath" },
        { regex: /AFFIANT/i, weight: 3, label: "affiant" },
        { regex: /OATH\s*OF\s*OFFICE/i, weight: 3, label: "oath_of_office" },
        { regex: /SO\s*HELP\s*ME\s*GOD/i, weight: 3, label: "so_help_me_god" },
        { regex: /TRUTH/i, weight: 1, label: "truth_keyword" },
        { regex: /ALLEGIANCE/i, weight: 1, label: "allegiance" },
      ],
      minMatches: 2,
      threshold: 5,
    },
    {
      type: "assumption",
      patterns: [
        { regex: /ASSUMPTION\s*TO\s*DUTY/i, weight: 4, label: "assumption_to_duty" },
        { regex: /ASSUME\s*THE\s*DUTIES/i, weight: 3, label: "assume_duties" },
        { regex: /HEREBY\s*ASSUME/i, weight: 3, label: "hereby_assume" },
        { regex: /POSITION\s*OF/i, weight: 2, label: "position_of" },
        { regex: /EFFECTIVE\s*DATE/i, weight: 2, label: "effective_date" },
        { regex: /FIRST\s*DAY/i, weight: 2, label: "first_day" },
      ],
      minMatches: 2,
      threshold: 5,
    },
    {
      type: "certification_lgu",
      patterns: [
        { regex: /CERTIFICATION/i, weight: 2, label: "certification" },
        { regex: /LGU\s*APPOINTMENT/i, weight: 4, label: "lgu_appointment" },
        { regex: /LOCAL\s*GOVERNMENT\s*UNIT/i, weight: 3, label: "local_gov_unit" },
        { regex: /CSC\s*MC\s*NO/i, weight: 2, label: "csc_mc_no" },
        { regex: /RA\s*NO\.?\s*7041/i, weight: 3, label: "ra_7041" },
        { regex: /HUMAN\s*RESOURCE\s*MERIT/i, weight: 2, label: "hrmpsb" },
        { regex: /QUALIFIED/i, weight: 1, label: "qualified" },
      ],
      minMatches: 3,
      threshold: 6,
    },
    {
      type: "nosa",
      patterns: [
        { regex: /NOTICE\s*OF\s*SALARY\s*ADJUSTMENT/i, weight: 5, label: "notice_salary_adjustment" },
        { regex: /NOSA/i, weight: 4, label: "nosa_acronym" },
        { regex: /SALARY\s*ADJUSTMENT/i, weight: 3, label: "salary_adjustment" },
        { regex: /ADJUSTED\s*SALARY/i, weight: 2, label: "adjusted_salary" },
        { regex: /SALARY\s*INCREASE/i, weight: 2, label: "salary_increase" },
        { regex: /EFFECTIVE/i, weight: 1, label: "effective" },
      ],
      minMatches: 2,
      threshold: 5,
    },
    {
      type: "nosi",
      patterns: [
        { regex: /NOTICE\s*OF\s*STEP\s*INCREMENT/i, weight: 5, label: "notice_step_increment" },
        { regex: /NOSI/i, weight: 4, label: "nosi_acronym" },
        { regex: /STEP\s*INCREMENT/i, weight: 3, label: "step_increment" },
        { regex: /NEXT\s*STEP/i, weight: 2, label: "next_step" },
        { regex: /LONGEVITY/i, weight: 2, label: "longevity" },
        { regex: /EFFECTIVE/i, weight: 1, label: "effective" },
      ],
      minMatches: 2,
      threshold: 5,
    },
    {
      type: "ipcr",
      patterns: [
        { regex: /IPCR/i, weight: 4, label: "ipcr_acronym" },
        { regex: /INDIVIDUAL\s*PERFORMANCE\s*COMMITMENT/i, weight: 5, label: "individual_performance" },
        { regex: /PERFORMANCE\s*COMMITMENT\s*AND\s*REVIEW/i, weight: 5, label: "performance_commitment_review" },
        { regex: /STRATEGIC\s*OBJECTIVES/i, weight: 2, label: "strategic_objectives" },
        { regex: /MAJOR\s*FINAL\s*OUTPUT/i, weight: 2, label: "major_final_output" },
        { regex: /ACTUAL\s*RESULTS/i, weight: 1, label: "actual_results" },
        { regex: /RATING/i, weight: 1, label: "rating" },
      ],
      minMatches: 2,
      threshold: 5,
    },
    {
      type: "service_record",
      patterns: [
        { regex: /SERVICE\s*RECORD/i, weight: 5, label: "service_record" },
        { regex: /CERTIFICATE\s*OF\s*EMPLOYMENT/i, weight: 4, label: "certificate_employment" },
        { regex: /COE/i, weight: 3, label: "coe_acronym" },
        { regex: /EMPLOYMENT\s*RECORD/i, weight: 3, label: "employment_record" },
        { regex: /WORK\s*RECORD/i, weight: 2, label: "work_record" },
        { regex: /FROM\s*DATE/i, weight: 1, label: "from_date" },
        { regex: /TO\s*DATE/i, weight: 1, label: "to_date" },
        { regex: /DESIGNATION/i, weight: 1, label: "designation" },
        { regex: /STATUS/i, weight: 1, label: "status" },
        { regex: /SALARY/i, weight: 1, label: "salary" },
        { regex: /OFFICE\s*ASSIGNMENT/i, weight: 1, label: "office_assignment" },
      ],
      minMatches: 2,
      threshold: 5,
    },
    {
      type: "training",
      patterns: [
        { regex: /TRAINING/i, weight: 3, label: "training" },
        { regex: /SEMINAR/i, weight: 3, label: "seminar" },
        { regex: /WORKSHOP/i, weight: 3, label: "workshop" },
        { regex: /L&D/i, weight: 2, label: "learning_dev" },
        { regex: /LEARNING\s*AND\s*DEVELOPMENT/i, weight: 3, label: "learning_development" },
        { regex: /CERTIFICATE\s*OF\s*ATTENDANCE/i, weight: 3, label: "certificate_attendance" },
        { regex: /CERTIFICATE\s*OF\s*COMPLETION/i, weight: 3, label: "certificate_completion" },
        { regex: /TRAINING\s*HOURS/i, weight: 2, label: "training_hours" },
        { regex: /CONDUCTED\s*BY/i, weight: 2, label: "conducted_by" },
        { regex: /VENUE/i, weight: 1, label: "venue" },
        { regex: /INCLUSIVE\s*DATE/i, weight: 1, label: "inclusive_date" },
      ],
      minMatches: 2,
      threshold: 4,
    },
    {
      type: "eligibility",
      patterns: [
        { regex: /CIVIL\s*SERVICE\s*ELIGIBILITY/i, weight: 4, label: "civil_service_eligibility" },
        { regex: /ELIGIBILITY/i, weight: 2, label: "eligibility" },
        { regex: /RA\s*NO\.?\s*1080/i, weight: 3, label: "ra_1080" },
        { regex: /BOARD\s*EXAM/i, weight: 3, label: "board_exam" },
        { regex: /BAR\s*EXAM/i, weight: 3, label: "bar_exam" },
        { regex: /PROFESSIONAL\s*REGULATION/i, weight: 3, label: "professional_regulation" },
        { regex: /PRC/i, weight: 2, label: "prc" },
        { regex: /CAREER\s*SERVICE/i, weight: 2, label: "career_service" },
        { regex: /RATING/i, weight: 1, label: "rating" },
        { regex: /DATE\s*OF\s*EXAM/i, weight: 1, label: "date_exam" },
        { regex: /PLACE\s*OF\s*EXAM/i, weight: 1, label: "place_exam" },
      ],
      minMatches: 3,
      threshold: 8,
    },
  ];

  // Score each document type
  for (const rule of rules) {
    let score = 0;
    const matched: string[] = [];
    
    for (const pattern of rule.patterns) {
      if (pattern.regex.test(t)) {
        score += pattern.weight;
        matched.push(pattern.label);
      }
    }
    
    if (matched.length >= rule.minMatches) {
      results[rule.type] = { score, matched };
    }
  }

  // Hard override: PERSONAL DATA SHEET or CS FORM 212 is unambiguous — always wins.
  const isPds = /CS\s*FORM\s*NO\.?\s*212/i.test(t) || /PERSONAL\s+DATA\s+SHEET/i.test(t);
  if (isPds) {
    return {
      type: "pds",
      confidence: 1.0,
      evidence: {
        matched: ["personal_data_sheet_override"],
        scores: { pds: 10 },
        stage: "text",
      },
    };
  }

  // Find best match
  let bestType: DocumentType = "unknown";
  let bestScore = 0;
  const allScores: Record<string, number> = {};
  
  for (const [type, result] of Object.entries(results)) {
    allScores[type] = result.score;
    if (result.score > bestScore) {
      bestScore = result.score;
      bestType = type as DocumentType;
    }
  }

  // Get threshold for best match
  const bestRule = rules.find(r => r.type === bestType);
  const threshold = bestRule?.threshold ?? 3;
  
  // Confidence calculation
  let confidence = 0;
  if (bestScore >= threshold) {
    confidence = Math.min(1, bestScore / (threshold * 1.5));
  } else if (bestScore > 0) {
    confidence = bestScore / threshold * 0.5; // Low confidence if below threshold
  }

  return {
    type: bestScore > 0 ? bestType : "unknown",
    confidence,
    evidence: {
      matched: results[bestType].matched,
      scores: allScores,
      stage: "text",
    },
  };
}

// Helper to check if document is a specific type
export function isDocumentType(fullText: string, type: DocumentType, minConfidence = 0.4): boolean {
  const result = detectDocumentType(fullText);
  return result.type === type && result.confidence >= minConfidence;
}

// Get human-readable label for document type
export function getDocumentTypeLabel(type: DocumentType): string {
  const labels: Record<DocumentType, string> = {
    pds: "Personal Data Sheet (PDS)",
    appointment: "Appointment Document",
    oath: "Oath of Office",
    assumption: "Assumption to Duty",
    certification_lgu: "LGU Certification",
    nosa: "Notice of Salary Adjustment (NOSA)",
    nosi: "Notice of Step Increment (NOSI)",
    ipcr: "IPCR",
    service_record: "Service Record / COE",
    training: "Training Certificate",
    eligibility: "Eligibility",
    pdf_generic: "PDF Document",
    other: "Other Document",
    unknown: "Unknown Document",
  };
  return labels[type] || "Unknown";
}

// Get category for grouping (simpler categories for UI)
export function getDocumentCategory(type: DocumentType): string {
  const categories: Record<DocumentType, string> = {
    pds: "PDS",
    appointment: "Appointment",
    oath: "Oath",
    assumption: "Assumption",
    certification_lgu: "Certification",
    nosa: "NOSA",
    nosi: "NOSI",
    ipcr: "IPCR",
    service_record: "Service Record",
    training: "Training",
    eligibility: "Eligibility",
    pdf_generic: "Other",
    other: "Other",
    unknown: "Unknown",
  };
  return categories[type] || "Other";
}

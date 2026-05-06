export type ExtractionStatus =
  | "uploaded"
  | "pending"
  | "extracted"
  | "in_review"
  | "approved"
  | "committed"
  | "failed"
  | "error";

export interface EmployeeDocumentRow {
  id: string;
  employee_id: string | null;
  batch_id?: string | null;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  original_filename: string;
  file_size_bytes: number | null;
  created_at: string;
}

export interface ExtractionRow {
  id: string;
  document_id: string;
  batch_id?: string | null;
  status: ExtractionStatus;
  quality_score: number | null;
  warnings: any;
  errors: any;
  created_at: string;
  updated_at: string;
}

export interface SettingsRow {
  id: number;
  org_slug: string;
  sg_min: number;
  sg_max: number;
  age_brackets: any;
  allow_66_plus: boolean;
  salary_tolerance: string;
  appointment_grace_days: number;
}

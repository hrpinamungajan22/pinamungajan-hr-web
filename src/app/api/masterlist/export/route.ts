import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateDdMmYyyy } from "@/lib/pds/validators";

export const dynamic = "force-dynamic";

type EmployeeExportRow = {
  id: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  name_extension: string | null;
  date_of_birth: string | null;
  date_hired: string | null;
  appointment_date: string | null;
  position_title: string | null;
  office_department: string | null;
  sg: number | null;
  step: number | null;
  monthly_salary: number | null;
  annual_salary: number | null;
  age: number | null;
  age_group: string | null;
  gender: string | null;
  tenure_years: number | null;
  tenure_months: number | null;
};

type XmlCellValue = string | number | null;

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tenureLabel(tenureYears: number | null, tenureMonths: number | null) {
  if (tenureYears === null && tenureMonths === null) return "";
  const years = tenureYears ?? 0;
  const months = tenureMonths ?? 0;
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}m`;
  return "0m";
}

function xmlCell(value: XmlCellValue, header = false) {
  if (value === null || value === undefined || value === "") {
    return `<Cell${header ? ' ss:StyleID="header"' : ""}><Data ss:Type="String"></Data></Cell>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<Cell${header ? ' ss:StyleID="header"' : ""}><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  return `<Cell${header ? ' ss:StyleID="header"' : ""}><Data ss:Type="String">${xmlEscape(String(value))}</Data></Cell>`;
}

async function fetchEmployeesForExport(q: string) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("Unauthorized");
  }

  const rows: EmployeeExportRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    let query = supabase
      .from("employees")
      .select(
        "id, last_name, first_name, middle_name, name_extension, date_of_birth, date_hired, appointment_date, position_title, office_department, sg, step, monthly_salary, annual_salary, age, age_group, gender, tenure_years, tenure_months"
      )
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (q) {
      const like = `%${q}%`;
      query = query.or(`last_name.ilike.${like},first_name.ilike.${like},middle_name.ilike.${like}`);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    const batch = (data || []) as EmployeeExportRow[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return rows;
}

function buildWorkbook(rows: EmployeeExportRow[]) {
  const headers = [
    "Employee ID",
    "Last Name",
    "First Name",
    "Middle Name",
    "Name Extension",
    "Date of Birth",
    "Age",
    "Age Group",
    "Gender",
    "Date Hired",
    "Appointment Date",
    "Office / Department",
    "Position Title",
    "Salary Grade",
    "Step",
    "Monthly Salary",
    "Annual Salary",
    "Tenure",
    "Tenure Years",
    "Tenure Months",
  ];

  const headerRow = `<Row>${headers.map((header) => xmlCell(header, true)).join("")}</Row>`;

  const bodyRows = rows
    .map((row) => {
      const cells: XmlCellValue[] = [
        normalizeText(row.id),
        normalizeText(row.last_name),
        normalizeText(row.first_name),
        normalizeText(row.middle_name),
        normalizeText(row.name_extension),
        normalizeText(formatDateDdMmYyyy(row.date_of_birth)),
        normalizeNumber(row.age),
        normalizeText(row.age_group),
        normalizeText(row.gender),
        normalizeText(formatDateDdMmYyyy(row.date_hired)),
        normalizeText(formatDateDdMmYyyy(row.appointment_date)),
        normalizeText(row.office_department),
        normalizeText(row.position_title),
        normalizeNumber(row.sg),
        normalizeNumber(row.step),
        normalizeNumber(row.monthly_salary),
        normalizeNumber(row.annual_salary),
        normalizeText(tenureLabel(normalizeNumber(row.tenure_years), normalizeNumber(row.tenure_months))),
        normalizeNumber(row.tenure_years),
        normalizeNumber(row.tenure_months),
      ];

      return `<Row>${cells.map((cell) => xmlCell(cell)).join("")}</Row>`;
    })
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">',
    '<Styles>',
    '<Style ss:ID="header"><Font ss:Bold="1"/></Style>',
    '</Styles>',
    '<Worksheet ss:Name="Masterlist">',
    '<Table>',
    headerRow,
    bodyRows,
    '</Table>',
    '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>',
    '</Worksheet>',
    '</Workbook>',
  ].join("");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const q = String(url.searchParams.get("q") || "").trim();
    const rows = await fetchEmployeesForExport(q);
    const workbook = buildWorkbook(rows);
    const datePart = new Date().toISOString().slice(0, 10);
    const filename = q ? `employee-masterlist-${datePart}.xls` : `employee-masterlist-${datePart}.xls`;

    return new NextResponse(workbook, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Unauthorized" ? 401 : 400;
    return new NextResponse(message, { status });
  }
}

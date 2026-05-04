import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth/roles";

export const runtime = "nodejs";

/** Admin-only: recent extractions + employee audit fields with user emails. */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  if (!isAdminUser(user)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const emailById = new Map<string, string>();
  try {
    const adminClient = createSupabaseAdminClient();
    const { data: listData, error: listErr } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
    if (!listErr && listData?.users) {
      for (const u of listData.users) {
        if (u.id && u.email) emailById.set(u.id, u.email);
      }
    }
  } catch {
    /* ignore */
  }

  const { data: extractions, error: exErr } = await supabase
    .from("extractions")
    .select(
      "id, status, created_at, updated_at, created_by, updated_by, document_id, batch_id, document_set_id"
    )
    .order("created_at", { ascending: false })
    .limit(150);

  if (exErr) {
    return new NextResponse(exErr.message, { status: 400 });
  }

  type ExtractionRow = {
    id: string;
    document_id: string | null;
    [key: string]: unknown;
  };

  const docIds = [
    ...new Set(
      (extractions as ExtractionRow[] | null)?.map((e) => e.document_id).filter(Boolean) as string[]
    ),
  ];
  const docNames: Record<string, string> = {};
  if (docIds.length) {
    const { data: docs } = await supabase
      .from("employee_documents")
      .select("id, original_filename")
      .in("id", docIds);
    for (const d of docs || []) {
      const row = d as { id: string; original_filename: string | null };
      docNames[row.id] = String(row.original_filename || "");
    }
  }

  const { data: empRows } = await supabase
    .from("employees")
    .select("id, last_name, first_name, middle_name, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(80);

  const exOut = (extractions as ExtractionRow[] | null | undefined)?.map((e) => ({
    id: String(e.id),
    status: String(e.status ?? ""),
    created_at: String(e.created_at ?? ""),
    updated_at: String(e.updated_at ?? ""),
    created_by: e.created_by,
    created_by_email: e.created_by ? emailById.get(String(e.created_by)) || null : null,
    updated_by: e.updated_by,
    updated_by_email: e.updated_by ? emailById.get(String(e.updated_by)) || null : null,
    document_id: e.document_id,
    original_filename: e.document_id ? docNames[String(e.document_id)] || null : null,
    batch_id: e.batch_id,
    document_set_id: e.document_set_id,
  }));

  type EmployeeAuditRow = {
    id: string;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    created_at: string | null;
    updated_at: string | null;
    created_by: string | null;
    updated_by: string | null;
  };

  const empOut = (empRows as EmployeeAuditRow[] | null)?.map((e) => ({
    id: e.id,
    name: [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" "),
    created_at: e.created_at,
    updated_at: e.updated_at,
    created_by: e.created_by,
    created_by_email: e.created_by ? emailById.get(String(e.created_by)) || null : null,
    updated_by: e.updated_by,
    updated_by_email: e.updated_by ? emailById.get(String(e.updated_by)) || null : null,
  }));

  return NextResponse.json({
    ok: true,
    extractions: exOut ?? [],
    employees: empOut ?? [],
  });
}

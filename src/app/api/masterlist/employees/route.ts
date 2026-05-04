import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const page = clampInt(Number(url.searchParams.get("page") || "1"), 1, 10_000);
  const pageSize = clampInt(Number(url.searchParams.get("pageSize") || "50"), 10, 200);

  const offset = (page - 1) * pageSize;

  // Prefer RPC (stable + case-insensitive ordering).
  try {
    const { data, error } = await supabase.rpc("masterlist_search_employees", {
      q: q || null,
      limit_count: pageSize,
      offset_count: offset,
    });

    if (error) {
      const msg = String(error.message || "");
      // If RPC missing, fall back to simple query.
      if (!/function .*masterlist_search_employees/i.test(msg) && String((error as any).code || "") !== "PGRST202") {
        return new NextResponse(error.message, { status: 400 });
      }
    } else {
      const rows = (data || []) as any[];
      const parsedTotal = rows.length > 0 ? Number(rows[0].total_count ?? NaN) : 0;
      const employees = rows.map((r) => {
        const { total_count, ...rest } = r;
        return rest;
      });
      if (employees.length === 0) {
        return NextResponse.json({ employees: [], total: 0, page, pageSize });
      }
      if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
        return NextResponse.json({ employees, total: parsedTotal, page, pageSize });
      }
      // Rows returned but total_count missing or zero — fall through for an exact count + stable rows.
    }
  } catch {
    // ignore and fall back
  }

  // Fallback: non-RPC query (may be case-sensitive depending on DB collation).
  let query = supabase
    .from("employees")
    .select(
      "id, last_name, first_name, middle_name, name_extension, date_of_birth, date_hired, appointment_date, position_title, office_department, sg, step, monthly_salary, annual_salary, age, age_group, gender, tenure_years, tenure_months",
      { count: "exact" }
    );

  if (q) {
    const like = `%${q}%`;
    query = query.or(`last_name.ilike.${like},first_name.ilike.${like},middle_name.ilike.${like}`);
  }

  const { data, error, count } = await query
    .order("last_name", { ascending: true })
    .order("first_name", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (error) {
    return new NextResponse(error.message, { status: 400 });
  }

  // Debug: log first employee to check tenure data
  if (data && data.length > 0) {
    console.log("[DEBUG API] First employee data:", {
      id: data[0].id,
      name: `${data[0].first_name} ${data[0].last_name}`,
      tenure_years: data[0].tenure_years,
      tenure_months: data[0].tenure_months,
      date_hired: data[0].date_hired,
      appointment_date: data[0].appointment_date,
    });
  }

  return NextResponse.json({ employees: data || [], total: count || 0, page, pageSize });
}

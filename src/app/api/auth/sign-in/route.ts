import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminListUser = {
  id: string;
  email?: string | null;
  user_metadata?: { username?: string | null };
};

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function emailLocalPart(value: string) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : "";
}

async function resolveEmailFromUsername(identifier: string) {
  const normalized = normalizeUsername(identifier);
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    throw new Error(error.message);
  }

  const users = (data?.users || []) as AdminListUser[];

  const byUsername = users.find(
    (user) => normalizeUsername(String(user.user_metadata?.username || "")) === normalized
  );
  if (byUsername?.email) {
    return String(byUsername.email).trim().toLowerCase();
  }

  const byEmail = users.find((user) => String(user.email || "").trim().toLowerCase() === normalized);
  if (byEmail?.email) {
    return String(byEmail.email).trim().toLowerCase();
  }

  const byLocalPart = users.filter((user) => emailLocalPart(String(user.email || "")) === normalized);
  if (byLocalPart.length === 1 && byLocalPart[0]?.email) {
    return String(byLocalPart[0].email).trim().toLowerCase();
  }
  if (byLocalPart.length > 1) {
    throw new Error("This username matches multiple accounts. Use the assigned username instead.");
  }

  return "";
}

/**
 * Password sign-in via server so the browser does not call Supabase directly
 * (same rationale as OTP routes — avoids "Failed to fetch" from blocked third-party requests).
 */
export async function POST(request: NextRequest) {
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Missing Supabase configuration" }, { status: 500 });
  }

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? normalizeUsername(body.username) : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
  }

  let email = "";
  try {
    email = await resolveEmailFromUsername(username);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not resolve username" },
      { status: 400 }
    );
  }

  if (!email) {
    return NextResponse.json({ error: "Username not found" }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true as const });
  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const result = await supabase.auth.signInWithPassword({ email, password });

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 400 });
  }

  if (!result.data.session) {
    return NextResponse.json({ error: "Signed in but no session returned" }, { status: 500 });
  }

  return response;
}

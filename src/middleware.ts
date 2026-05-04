import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getAdminLoginPath, getAdminPath } from "@/lib/urls";

const PUBLIC_PATHS = new Set<string>(["/login", "/logout", "/pending-approval", getAdminLoginPath()]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const publicAdminPath = getAdminPath();

  // Browser URL uses NEXT_PUBLIC_ADMIN_PATH (e.g. /hr-admin). The App Router only has app/admin/...
  // next.config rewrites are unreliable in some Turbopack dev setups, so we rewrite in middleware
  // after auth so /hr-admin always serves the admin routes.
  const isPublicAdminUrl =
    publicAdminPath !== "/admin" &&
    (pathname === publicAdminPath ||
      pathname === `${publicAdminPath}/` ||
      pathname.startsWith(`${publicAdminPath}/`));

  // Keep /admin/login on this path (dedicated admin sign-in URL)
  const isAdminLoginPath = pathname === getAdminLoginPath() || pathname.startsWith(`${getAdminLoginPath()}/`);

  // Canonical: send direct /admin requests to the public /hr-admin URL
  if (
    publicAdminPath !== "/admin" &&
    !isAdminLoginPath &&
    (pathname === "/admin" || pathname.startsWith("/admin/"))
  ) {
    const after = pathname === "/admin" || pathname === "/admin/" ? "" : pathname.slice("/admin".length) || "/";
    const path =
      after && after !== "/" ? `${publicAdminPath}${after.startsWith("/") ? after : `/${after}`}` : publicAdminPath;
    const to = new URL(path.replace(/\/\/+/g, "/"), request.url);
    to.search = request.nextUrl.search;
    if (to.pathname === pathname) return NextResponse.next();
    return NextResponse.redirect(to);
  }

  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|pdf|woff2?)$/i.test(pathname)) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/templates") ||
    pathname.startsWith("/guides") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/public")
  ) {
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const rewriteToAdmin = (): URL | null => {
    if (!isPublicAdminUrl) return null;
    const after =
      pathname === publicAdminPath || pathname === `${publicAdminPath}/`
        ? "/"
        : pathname.slice(publicAdminPath.length) || "/";
    const dest = after === "/" || after === "" ? "/admin" : `/admin${after}`.replace(/\/\/+/g, "/");
    const u = new URL(dest, request.url);
    u.search = request.nextUrl.search;
    return u;
  };

  const rw = rewriteToAdmin();
  const response = rw
    ? NextResponse.rewrite(rw, { request: { headers: request.headers } })
    : NextResponse.next({
        request: {
          headers: request.headers,
        },
      });

  const supabase = createServerClient(url, anonKey, {
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

  let session = null;
  try {
    const {
      data: { session: s },
      error,
    } = await supabase.auth.getSession();
    if (error) {
      return response;
    }
    session = s;
  } catch {
    return response;
  }

  if (!session) {
    const wantsAdminLogin =
      pathname === publicAdminPath ||
      pathname.startsWith(`${publicAdminPath}/`) ||
      (pathname === "/admin" || pathname.startsWith("/admin/")) &&
        !isAdminLoginPath;
    const loginPath = wantsAdminLogin ? getAdminLoginPath() : "/login";
    const redirectUrl = new URL(loginPath, request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  const role = String(session?.user?.app_metadata?.role || "").toLowerCase();
  const approvedFlag = session?.user?.app_metadata?.approved === true;
  const isApproved = role === "admin" || role === "hr" || approvedFlag;
  const isAdmin = role === "admin";
  if (!isApproved && !pathname.startsWith("/pending-approval")) {
    return NextResponse.redirect(new URL("/pending-approval", request.url));
  }
  if (isApproved && pathname.startsWith("/pending-approval")) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  if (pathname.startsWith("/upload") && isAdmin) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

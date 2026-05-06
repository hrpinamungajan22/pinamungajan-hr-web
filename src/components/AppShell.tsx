"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandLogo } from "@/components/BrandLogo";
import { LogoutButton } from "@/components/LogoutButton";
import { PlusCircle, Eye, Users, Sun, Moon, Shield } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { getAdminPath } from "@/lib/urls";

export function AppShell({
  title,
  description,
  children,
}: {
  title: string;
  /** Optional one-line context under the page title (improves scan-ability). */
  description?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [navReady, setNavReady] = useState(false);

  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setNavReady(false);
    fetch("/api/auth/me", { credentials: "include" })
      .then(
        (r) =>
          r.json() as Promise<{ user: { role: string | null; approved?: boolean } | null }>,
      )
      .then((data) => {
        if (cancelled) return;
        setRole(data.user?.role ?? null);
        setApproved(Boolean(data.user?.approved));
        setNavReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setRole(null);
          setApproved(false);
          setNavReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const isAdmin = role === "admin";
  const canUpload = role !== "admin";
  /** Align with canAccessReviewQueue: admin, HR staff, or explicitly approved accounts. */
  const canReview = role === "admin" || role === "hr" || approved;
  const adminPath = getAdminPath();

  function navClass(href: string) {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return `app-nav-link ${active ? "app-nav-link-active" : ""}`;
  }

  function currentProps(href: string) {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return active ? ({ "aria-current": "page" } as const) : {};
  }

  return (
    <div className="min-h-screen bg-app-bg transition-colors">
      <header className="sticky top-0 z-40 border-b border-app-border bg-app-surface/95 shadow-sm backdrop-blur-md transition-colors supports-[backdrop-filter]:bg-app-surface/90">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
            <Link
              href="/"
              className="flex min-w-0 shrink-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-app-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg"
            >
              <BrandLogo variant="header" priority />
              <div className="min-w-0 flex flex-col border-l border-app-border pl-3">
                <span className="text-lg font-bold leading-tight text-app-text">HR System</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-app-primary">
                  Pinamungajan
                </span>
              </div>
            </Link>

            <nav
              className={`flex min-w-0 flex-1 flex-wrap items-center gap-1 sm:gap-1.5 ${!navReady ? "opacity-70" : ""} transition-opacity duration-200`}
              aria-label="Main"
              aria-busy={!navReady}
            >
              {canUpload ? (
                <Link className={navClass("/upload")} href="/upload" {...currentProps("/upload")}>
                  <PlusCircle className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Add document</span>
                </Link>
              ) : null}
              {canReview ? (
                <Link className={navClass("/review")} href="/review" {...currentProps("/review")}>
                  <Eye className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Review</span>
                </Link>
              ) : null}
              <Link className={navClass("/masterlist")} href="/masterlist" {...currentProps("/masterlist")}>
                <Users className="h-4 w-4 shrink-0" aria-hidden />
                <span>Masterlist</span>
              </Link>
              {isAdmin ? (
                <Link className={navClass(adminPath)} href={adminPath} {...currentProps(adminPath)}>
                  <Shield className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Admin</span>
                </Link>
              ) : null}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
            {mounted && (
              <button
                type="button"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="app-btn-ghost min-h-11 min-w-11 rounded-full p-2"
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </button>
            )}
            <LogoutButton />
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-6xl px-4 py-6 sm:py-10" tabIndex={-1}>
        <header className="border-b border-app-border pb-6">
          <p className="app-eyebrow">LGU Pinamungajan · Human resources</p>
          <h1 className="app-section-title mt-3 text-balance">{title}</h1>
          {description ? <p className="app-page-desc">{description}</p> : null}
        </header>
        <div className="mt-8">{children}</div>
      </main>
    </div>
  );
}

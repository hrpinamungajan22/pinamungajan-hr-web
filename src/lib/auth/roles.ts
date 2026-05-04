import type { User } from "@supabase/supabase-js";

export type AppRole = "admin" | "hr" | string;

export function getAppRole(user: User | null | undefined): AppRole | null {
  const r = user?.app_metadata?.role;
  if (typeof r === "string" && r.trim()) return r.trim().toLowerCase() as AppRole;
  return null;
}

export function isAdminUser(user: User | null | undefined): boolean {
  return getAppRole(user) === "admin";
}

export function isAdminOrHrUser(user: User | null | undefined): boolean {
  const r = getAppRole(user);
  return r === "admin" || r === "hr";
}

/** Same idea as middleware “approved”: admin, HR staff, or explicitly approved accounts. */
export function canAccessReviewQueue(user: User | null | undefined): boolean {
  if (!user) return false;
  if (isAdminOrHrUser(user)) return true;
  return user.app_metadata?.approved === true;
}

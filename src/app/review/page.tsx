import { AppShell } from "@/components/AppShell";
import { ReviewList } from "@/app/review/ReviewList";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canAccessReviewQueue } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !canAccessReviewQueue(user)) {
    return (
      <AppShell
        title="Review queue"
        description="Sign in with an approved HR or administrator account to use the review queue."
      >
        <div className="app-card max-w-2xl space-y-3 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-app-text">Access required</h2>
          <p className="app-prose-muted text-sm leading-relaxed">
            The review queue is for verifying extractions before they reach the masterlist. If your account still needs
            approval, wait for an administrator to activate it or use{" "}
            <strong className="text-app-text">Upload</strong> and <strong className="text-app-text">Masterlist</strong>{" "}
            from the menu once you can sign in.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Review queue"
      description="Open a row to see extracted fields, run OCR, and commit updates to the masterlist when ready."
    >
      <ReviewList />
    </AppShell>
  );
}

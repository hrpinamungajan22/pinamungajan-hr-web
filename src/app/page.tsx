import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import {
  PlusCircle,
  ClipboardCheck,
  Users,
  ArrowRight,
  Sparkles,
} from "lucide-react";

export default function Home() {
  return (
    <AppShell
      title="HR dashboard"
      description="Choose a task below or use the menu at the top. Your view may differ by role (HR staff vs administrator)."
    >
      <div className="grid gap-8">
        <section className="app-card p-6 sm:p-8">
          <div className="flex flex-wrap items-start gap-3">
            <span className="inline-flex rounded-xl bg-app-primary/12 p-2.5 text-app-primary" aria-hidden>
              <Sparkles className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-bold tracking-tight text-app-text sm:text-2xl">
                Welcome to Pinamungajan Human Resources
              </h2>
              <p className="app-prose-muted mt-2 max-w-2xl">
                Upload forms and appointments, review scanned data, and keep the employee masterlist up to date in one
                place.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="quick-actions-heading" className="space-y-4">
          <h2
            id="quick-actions-heading"
            className="text-sm font-semibold uppercase tracking-wider text-app-muted"
          >
            Quick start
          </h2>
          <ul className="grid gap-4 md:grid-cols-3">
            <li>
              <Link
                href="/upload"
                className="app-card group flex h-full flex-col p-6 outline-none transition-all hover:border-app-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-app-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg"
              >
                <span className="mb-4 inline-flex w-fit rounded-xl bg-app-primary/12 p-3 text-app-primary transition-colors group-hover:bg-app-primary/20">
                  <PlusCircle className="h-8 w-8" aria-hidden />
                </span>
                <span className="text-lg font-semibold text-app-text">Add document</span>
                <span className="app-prose-muted mt-2 flex-1">Upload PDS, appointments, and other files for processing.</span>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-app-primary">
                  Go to upload
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
            <li>
              <Link
                href="/review"
                className="app-card group flex h-full flex-col p-6 outline-none transition-all hover:border-app-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-app-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg"
              >
                <span className="mb-4 inline-flex w-fit rounded-xl bg-app-primary/12 p-3 text-app-primary transition-colors group-hover:bg-app-primary/20">
                  <ClipboardCheck className="h-8 w-8" aria-hidden />
                </span>
                <span className="text-lg font-semibold text-app-text">Pending reviews</span>
                <span className="app-prose-muted mt-2 flex-1">Open the queue to verify and fix extracted data.</span>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-app-primary">
                  Open queue
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
            <li>
              <Link
                href="/masterlist"
                className="app-card group flex h-full flex-col p-6 outline-none transition-all hover:border-app-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-app-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app-bg"
              >
                <span className="mb-4 inline-flex w-fit rounded-xl bg-app-primary/12 p-3 text-app-primary transition-colors group-hover:bg-app-primary/20">
                  <Users className="h-8 w-8" aria-hidden />
                </span>
                <span className="text-lg font-semibold text-app-text">Masterlist</span>
                <span className="app-prose-muted mt-2 flex-1">Search people and open linked records and documents.</span>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-app-primary">
                  Browse list
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

/**
 * Smoke-check Vercel (frontend) + Render (backend) without opening a browser.
 *
 * Usage:
 *   node scripts/check-deploy-health.mjs --frontend=https://your-app.vercel.app --backend=https://your-app.onrender.com
 *   FRONTEND_URL=https://... BACKEND_URL=https://... node scripts/check-deploy-health.mjs
 *
 * Exit code: 0 = all checks passed, 1 = at least one failed.
 */

function parseArgs(argv) {
  const out = { frontend: "", backend: "", timeoutMs: 25_000 };
  for (const a of argv) {
    if (a.startsWith("--frontend=")) out.frontend = a.slice("--frontend=".length).trim();
    else if (a.startsWith("--backend=")) out.backend = a.slice("--backend=".length).trim();
    else if (a.startsWith("--timeout=")) out.timeoutMs = Number(a.slice("--timeout=".length).trim()) || out.timeoutMs;
  }
  return out;
}

function normalizeBase(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  return s;
}

async function probe(name, url, { expectJsonOk = false, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { Accept: expectJsonOk ? "application/json" : "*/*" },
    });
    const status = res.status;
    let ok = status >= 200 && status < 400;
    let detail = "";
    if (expectJsonOk) {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        const jsonOk = Boolean(j && (j.ok === true || j.route));
        if (!jsonOk) {
          ok = false;
          detail = ` body=${text.slice(0, 200)}`;
        }
      } catch {
        ok = false;
        detail = ` body=${text.slice(0, 200)}`;
      }
    }
    return { name, url, ok, status, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, url, ok: false, status: 0, detail: ` ${msg}` };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const frontend = normalizeBase(args.frontend || process.env.FRONTEND_URL || "");
  const backend = normalizeBase(args.backend || process.env.BACKEND_URL || "");
  const timeoutMs = args.timeoutMs;

  console.log("Deploy health check\n");

  if (!frontend) {
    console.error("Missing frontend URL. Set FRONTEND_URL or pass --frontend=https://...");
    process.exit(1);
  }
  if (!backend) {
    console.error("Missing backend URL. Set BACKEND_URL or pass --backend=https://...");
    process.exit(1);
  }

  const checks = [
    probe("Frontend home", `${frontend}/`, { expectJsonOk: false, timeoutMs }),
    probe("Frontend login page", `${frontend}/login`, { expectJsonOk: false, timeoutMs }),
    probe("Backend API (direct)", `${backend}/api/ocr`, { expectJsonOk: true, timeoutMs }),
    probe("Frontend /api via proxy", `${frontend}/api/ocr`, { expectJsonOk: true, timeoutMs }),
  ];

  const results = await Promise.all(checks);

  let failed = 0;
  for (const r of results) {
    const label = r.ok ? "OK  " : "FAIL";
    const status = r.status ? ` HTTP ${r.status}` : "";
    console.log(`[${label}] ${r.name}${status} — ${r.url}${r.detail || ""}`);
    if (!r.ok) failed += 1;
  }

  console.log("");
  if (failed) {
    console.error(`${failed} check(s) failed.`);
    console.error("Tips: wake Render (free tier sleeps); verify BACKEND_URL on Vercel matches backend; check Supabase env on both.");
    process.exit(1);
  }
  console.log("All checks passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

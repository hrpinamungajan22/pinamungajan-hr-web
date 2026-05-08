"use client";

import { useEffect, useState } from "react";

type StaffRow = {
  id: string;
  username: string | null;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  approved: boolean;
  last_sign_in_at: string | null;
  providers: string[];
};

function staffSortLabel(r: StaffRow): string {
  return String(r.username || r.owner_name || r.email || r.phone || "").toLowerCase();
}

async function readJsonError(res: Response, text: string): Promise<string> {
  try {
    const j = JSON.parse(text) as { error?: string };
    if (typeof j.error === "string" && j.error.trim()) return j.error.trim();
  } catch {
    /* plain text */
  }
  return text.trim() || `Request failed (${res.status})`;
}

export function StaffManagementClient() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [username, setUsername] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    const res = await fetch("/api/admin/staff", { credentials: "include" });
    const text = await res.text();
    if (!res.ok) throw new Error(await readJsonError(res, text));
    const json = JSON.parse(text) as { users: StaffRow[] };
    const list = json.users || [];
    setRows(
      list.sort((a, b) => staffSortLabel(a).localeCompare(staffSortLabel(b)))
    );
  }

  useEffect(() => {
    load().catch((e) => setMessage(e instanceof Error ? e.message : String(e)));
  }, []);

  async function createOrPromote() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: username.trim(), owner_name: ownerName.trim(), password }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(await readJsonError(res, text));
      const json = JSON.parse(text) as {
        mode: string;
        username?: string;
        owner_name?: string;
      };
      setUsername("");
      setOwnerName("");
      setPassword("");
      const lines: string[] = [];
      lines.push(`Staff ${json.mode}.`);
      if (json.username) {
        lines.push(`Username: ${json.username}`);
      }
      if (json.owner_name) {
        lines.push(`Owner: ${json.owner_name}`);
      }
      setMessage(lines.join(" "));
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function removeUser(userId: string) {
    if (!confirm("Delete this HR staff account?")) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/staff?user_id=${encodeURIComponent(userId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(await readJsonError(res, text));
      setMessage("Staff deleted.");
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function approveUser(userId: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ user_id: userId, action: "approve", role: "hr" }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(await readJsonError(res, text));
      setMessage("User approved as HR staff.");
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="app-card p-6 sm:p-8">
      <h2 className="text-base font-semibold text-app-text">HR staff accounts</h2>
      <p className="app-prose-muted mt-1">
        Create HR accounts, set the account owner name, approve pending sign-ups, or remove access.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          className="app-input"
          autoComplete="off"
        />
        <input
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          placeholder="Owner name"
          className="app-input"
          autoComplete="off"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="app-input"
          autoComplete="new-password"
        />
        <button
          disabled={loading || !username.trim() || !ownerName.trim() || !password.trim()}
          onClick={createOrPromote}
          className="app-btn-primary"
        >
          Add or promote HR
        </button>
      </div>

      <p className="app-prose-muted mt-3 text-xs">
        Users now sign in with <span className="font-medium text-app-text">username and password</span>. The account owner name is stored for display in this admin panel.
      </p>

      {message ? (
        <div className="app-alert-info mt-4 text-sm whitespace-pre-wrap">{message}</div>
      ) : null}

      <div className="app-table-wrap mt-6 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="app-table-head">
            <tr>
              <th className="px-3 py-3 text-left">Username</th>
              <th className="px-3 py-3 text-left">Owner name</th>
              <th className="px-3 py-3 text-left">Role</th>
              <th className="px-3 py-3 text-left">Approved</th>
              <th className="px-3 py-3 text-left">Providers</th>
              <th className="px-3 py-3 text-left">Last sign in</th>
              <th className="px-3 py-3 text-left">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {rows.map((r) => (
              <tr key={r.id} className="text-app-text">
                <td className="px-3 py-2.5">{r.username || "—"}</td>
                <td className="px-3 py-2.5">{r.owner_name || "—"}</td>
                <td className="px-3 py-2.5">{r.role || "none"}</td>
                <td className="px-3 py-2.5">{r.approved ? "yes" : "no"}</td>
                <td className="px-3 py-2.5">{r.providers.join(", ") || "—"}</td>
                <td className="px-3 py-2.5">
                  {r.last_sign_in_at ? new Date(r.last_sign_in_at).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2.5">
                  {r.role === "hr" && r.approved ? (
                    <div className="flex gap-2">
                      <button
                        disabled={loading}
                        onClick={() => removeUser(r.id)}
                        className="rounded-lg bg-app-danger px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  ) : !r.approved ? (
                    <div className="flex gap-2">
                      <button
                        disabled={loading}
                        onClick={() => approveUser(r.id)}
                        className="rounded-lg bg-app-success px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        Approve as HR
                      </button>
                      <button
                        disabled={loading}
                        onClick={() => removeUser(r.id)}
                        className="rounded-lg bg-app-danger px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        Reject/Delete
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-app-muted">Not deletable here</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-app-muted" colSpan={7}>
                  No users found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

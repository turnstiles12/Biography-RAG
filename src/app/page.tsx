"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, recentWorkspaces, rememberWorkspace } from "@/components/api";
import type { PublicConfig, WorkspaceInfo } from "@/components/types";

export default function Home() {
  const router = useRouter();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [demo, setDemo] = useState<WorkspaceInfo | null | "missing">(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ id: string; personName: string }[]>([]);

  useEffect(() => {
    setRecent(recentWorkspaces());
    api<PublicConfig>("/api/config")
      .then((c) => {
        setCfg(c);
        return api<WorkspaceInfo>(`/api/workspaces/${c.demoWorkspaceId}`).then(setDemo);
      })
      .catch(() => setDemo("missing"));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ws = await api<{ id: string; personName: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ personName: name }),
      });
      rememberWorkspace(ws.id, ws.personName);
      router.push(`/w/${ws.id}?tab=documents`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <section style={{ maxWidth: 760, margin: "10px 0 18px" }}>
        <h1>A biography where every sentence shows its source.</h1>
        <p className="muted" style={{ fontSize: 17 }}>
          Upload pages about one person. They get chunked, embedded and searched with 20 fixed biographical questions.
          The model writes a story using <b>only</b> the retrieved snippets. Each sentence carries a{" "}
          <span className="kbd">[chunk_id]</span>, and an automated audit flags anything that came from the model&apos;s
          own memory instead of your documents.
        </p>
      </section>

      <div className="grid2">
        <div className="card stack">
          <div className="row">
            <h2 style={{ margin: 0 }}>Explore the demo</h2>
            <span className="badge accent">read-only</span>
          </div>
          {demo === null && <p className="faint">Loading…</p>}
          {demo === "missing" && (
            <div className="alert warn">
              The demo workspace has not been seeded on this server yet. The operator can run{" "}
              <span className="kbd">npm run seed</span>.
            </div>
          )}
          {demo && demo !== "missing" && (
            <>
              <p className="muted">
                <b>{demo.personName}</b>
                {demo.description ? `: ${demo.description}` : ""}
              </p>
              <div className="stats">
                <div className="stat"><b>{demo.stats.documents}</b><span>books</span></div>
                <div className="stat"><b>{demo.stats.pages.toLocaleString()}</b><span>pages</span></div>
                <div className="stat"><b>{demo.stats.chunks.toLocaleString()}</b><span>chunks</span></div>
                <div className="stat"><b>{demo.runs.length}</b><span>runs</span></div>
              </div>
              <div className="row">
                <Link className="btn primary" href={`/w/${demo.id}?tab=story`}>Read the story</Link>
                <Link className="btn" href={`/w/${demo.id}?tab=queries`}>20 queries &amp; audit log</Link>
                <Link className="btn" href={`/w/${demo.id}?tab=canary`}>Canary lab</Link>
              </div>
            </>
          )}
        </div>

        <form className="card stack" onSubmit={create}>
          <h2 style={{ margin: 0 }}>Start your own</h2>
          <p className="muted">
            Create a private workspace for any person, then drag in .pdf, .txt, .md or .html files about them.
          </p>
          <div>
            <label htmlFor="person">Person&apos;s name</label>
            <input
              id="person"
              type="text"
              placeholder="e.g. Ada Lovelace"
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={80}
              required
            />
          </div>
          {error && <div className="alert error">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || name.trim().length < 2}>
              {busy ? "Creating…" : "Create workspace"}
            </button>
            {cfg && (
              <span className="faint">
                Up to {cfg.limits.maxPagesPerWorkspace?.toLocaleString()} pages · {cfg.limits.maxFileMb} MB per file
              </span>
            )}
          </div>
          {cfg && !cfg.serverKeyAvailable && (
            <div className="alert info small">
              This server has no shared LLM key. You&apos;ll need your own Anthropic API key to generate stories.
            </div>
          )}
        </form>
      </div>

      {recent.length > 0 && (
        <div className="card">
          <h3>Your workspaces in this browser</h3>
          <div className="row" style={{ marginTop: 8 }}>
            {recent.map((w) => (
              <Link key={w.id} className="btn sm" href={`/w/${w.id}`}>
                {w.personName}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

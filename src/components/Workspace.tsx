"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, forgetWorkspace, rememberWorkspace } from "./api";
import type { PublicConfig, RunLog, RunSummary, WorkspaceInfo } from "./types";
import UploadPanel from "./UploadPanel";
import StoryView from "./StoryView";
import QueryExplorer from "./QueryExplorer";
import CanaryLab from "./CanaryLab";
import ByokBox from "./ByokBox";

const TABS = [
  { id: "documents", label: "Documents" },
  { id: "story", label: "Story" },
  { id: "queries", label: "20 Queries & Audit Log" },
  { id: "canary", label: "Canary Test Lab" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function Workspace({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tab = (TABS.find((t) => t.id === search.get("tab"))?.id ?? "story") as TabId;

  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [byok, setByok] = useState<string | null>(null); // memory only
  const [runId, setRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLog | null>(null);
  const [activeRun, setActiveRun] = useState<RunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      const w = await api<WorkspaceInfo>(`/api/workspaces/${id}`);
      setInfo(w);
      if (w.isOwner) rememberWorkspace(w.id, w.personName);
      const running = w.runs.find((r) => r.status === "running") ?? null;
      setActiveRun(running);
      setRunId((cur) => {
        if (cur && w.runs.some((r) => r.id === cur)) return cur;
        return (w.runs.find((r) => r.status === "succeeded") ?? w.runs[0])?.id ?? null;
      });
      return w;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    void loadInfo();
    api<PublicConfig>("/api/config").then(setCfg).catch(() => {});
  }, [loadInfo]);

  // Load the selected run's full log (unless it is still running).
  useEffect(() => {
    if (!runId) {
      setRunLog(null);
      return;
    }
    const summary = info?.runs.find((r) => r.id === runId);
    if (summary?.status === "running") return;
    let cancelled = false;
    api<RunLog>(`/api/runs/${runId}`)
      .then((l) => !cancelled && setRunLog(l))
      .catch((e) => !cancelled && setRunError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [runId, info]);

  // Poll an active run.
  useEffect(() => {
    if (!activeRun) return;
    const t = setInterval(async () => {
      try {
        const s = await api<RunSummary>(`/api/runs/${activeRun.id}/status`);
        setActiveRun(s.status === "running" ? s : null);
        if (s.status !== "running") {
          setRunId(s.id);
          await loadInfo();
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [activeRun, loadInfo]);

  function setTab(t: TabId) {
    const p = new URLSearchParams(search.toString());
    p.set("tab", t);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }

  async function startRun() {
    setStarting(true);
    setRunError(null);
    try {
      const r = await api<{ runId: string }>(`/api/workspaces/${id}/runs`, { method: "POST", byok });
      setActiveRun({ id: r.runId, status: "running", stage: "queries", progress: 0, total: 22 } as RunSummary);
      setTab("story");
      await loadInfo();
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function deleteWorkspace() {
    if (!info || !confirm(`Permanently delete the workspace for ${info.personName} and all its documents and runs?`)) return;
    try {
      await api(`/api/workspaces/${id}`, { method: "DELETE" });
      forgetWorkspace(id);
      router.push("/");
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const ready = (info?.stats.embedded ?? 0) > 0 && info?.latestJob?.status !== "running";
  const needsKey = cfg ? !cfg.serverKeyAvailable && !byok : false;
  const runOptions = useMemo(() => info?.runs ?? [], [info]);

  if (loadError) {
    return (
      <div className="card">
        <h2>Workspace unavailable</h2>
        <p className="muted">{loadError}</p>
        <a className="btn" href="/">Back home</a>
      </div>
    );
  }
  if (!info) return <p className="faint">Loading workspace…</p>;

  return (
    <div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{info.personName}</h1>
            {info.isDemo && <span className="badge accent">Demo · read-only</span>}
            {info.isOwner && <span className="badge neutral">You own this workspace</span>}
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            {info.stats.documents} documents · {info.stats.pages.toLocaleString()} pages · {info.stats.chunks.toLocaleString()} chunks
            ({info.stats.embedded.toLocaleString()} embedded) ·{" "}
            <button
              className="btn sm"
              onClick={() => navigator.clipboard?.writeText(window.location.href.split("?")[0])}
              title="Anyone with this link can view this workspace (but not upload or delete)"
            >
              Copy share link
            </button>
            {info.isOwner && !info.isDemo && (
              <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={deleteWorkspace}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row">
          {info.canRun ? (
            <button className="btn primary" onClick={startRun} disabled={!ready || starting || !!activeRun || needsKey}>
              {activeRun ? "Run in progress…" : starting ? "Starting…" : "Run 20 queries & write story"}
            </button>
          ) : (
            <span className="faint">Only the owner can start runs in this workspace.</span>
          )}
          {runOptions.length > 0 && (
            <label className="row" style={{ margin: 0, fontWeight: 400 }}>
              <span className="faint">Showing run</span>
              <select
                value={runId ?? ""}
                onChange={(e) => setRunId(e.target.value)}
                style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)" }}
              >
                {runOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.started_at).toLocaleString()} · {r.status}
                    {r.audit_summary ? ` · ${r.audit_summary.verified}/${r.audit_summary.sentences} verified` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="spacer" />
          {cfg?.allowByok && <ByokBox value={byok} onChange={setByok} required={!cfg.serverKeyAvailable} />}
        </div>
        {!ready && info.stats.chunks === 0 && (
          <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>Upload documents first. Runs need at least one indexed document.</p>
        )}
        {activeRun && (
          <div style={{ marginTop: 12 }}>
            <div className="row small muted">
              Stage: <b>{activeRun.stage}</b> · {activeRun.progress} / {activeRun.total} steps
            </div>
            <div className="progress" style={{ marginTop: 6 }}>
              <div style={{ width: `${Math.round((100 * activeRun.progress) / Math.max(1, activeRun.total))}%` }} />
            </div>
          </div>
        )}
        {runError && <div className="alert error" style={{ marginTop: 10 }}>{runError}</div>}
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "documents" && <UploadPanel info={info} cfg={cfg} onChanged={loadInfo} />}
      {tab === "story" && <StoryView log={runLog} running={!!activeRun && activeRun.id === runId} hasRuns={info.runs.length > 0} />}
      {tab === "queries" && <QueryExplorer log={runLog} />}
      {tab === "canary" && <CanaryLab info={info} byok={byok} needsKey={needsKey} />}
    </div>
  );
}

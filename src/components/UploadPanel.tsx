"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { JobInfo, PublicConfig, WorkspaceInfo } from "./types";

const ACCEPT = ".pdf,.txt,.md,.markdown,.html,.htm";
const OK_EXT = /\.(pdf|txt|text|md|markdown|html?)$/i;

export default function UploadPanel({
  info,
  cfg,
  onChanged,
}: {
  info: WorkspaceInfo;
  cfg: PublicConfig | null;
  onChanged: () => Promise<unknown>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [job, setJob] = useState<JobInfo | null>(
    info.latestJob && ["queued", "running"].includes(info.latestJob.status) ? info.latestJob : null,
  );
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Poll indexing progress.
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const t = setInterval(async () => {
      try {
        const j = await api<JobInfo>(`/api/jobs/${job.id}`);
        setJob(j);
        if (!["queued", "running"].includes(j.status)) await onChanged();
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job, onChanged]);

  function addFiles(list: FileList | File[]) {
    const arr = Array.from(list);
    const bad = arr.filter((f) => !OK_EXT.test(f.name)).map((f) => `"${f.name}": unsupported type`);
    setMessages(bad);
    setFiles((cur) => [...cur, ...arr.filter((f) => OK_EXT.test(f.name))].slice(0, cfg?.limits.maxFilesPerUpload ?? 50));
  }

  function upload() {
    if (!files.length) return;
    setError(null);
    setMessages([]);
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/workspaces/${info.id}/documents`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploadPct(Math.round((100 * e.loaded) / e.total));
    xhr.onload = async () => {
      setUploadPct(null);
      let data: { added?: unknown[]; errors?: string[]; jobId?: string | null; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 400 && !data.added?.length) {
        setError(data.error ?? data.errors?.join("\n") ?? `Upload failed (HTTP ${xhr.status})`);
        return;
      }
      setMessages(data.errors ?? []);
      setFiles([]);
      if (data.jobId) setJob({ id: data.jobId, status: "queued", progress: 0, total: 0, message: "Queued", error: null });
      await onChanged();
    };
    xhr.onerror = () => {
      setUploadPct(null);
      setError("Network error during upload");
    };
    setUploadPct(0);
    xhr.send(fd);
  }

  const indexing = job && ["queued", "running"].includes(job.status);
  const totalMb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;

  return (
    <div className="stack">
      {info.canUpload ? (
        <div className="card stack">
          <h2>Add pages about {info.personName}</h2>
          <div
            className={`dropzone ${over ? "over" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              addFiles(e.dataTransfer.files);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          >
            <b>Drag &amp; drop files here</b> or click to choose
            <div className="faint" style={{ marginTop: 6 }}>
              .pdf, .txt, .md, .html
              {cfg && ` · up to ${cfg.limits.maxFileMb} MB each, ${cfg.limits.maxUploadMb} MB per upload, ${cfg.limits.maxPagesPerWorkspace?.toLocaleString()} pages per workspace`}
            </div>
            <input ref={inputRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </div>
          {files.length > 0 && (
            <div>
              <table>
                <tbody>
                  {files.map((f, i) => (
                    <tr key={i}>
                      <td>{f.name}</td>
                      <td className="faint">{(f.size / 1024).toFixed(0)} KB</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary" onClick={upload} disabled={uploadPct !== null || !!indexing}>
                  Upload &amp; index {files.length} file{files.length > 1 ? "s" : ""} ({totalMb.toFixed(1)} MB)
                </button>
                {indexing && <span className="faint">Wait for the current indexing job to finish.</span>}
              </div>
            </div>
          )}
          {uploadPct !== null && (
            <div>
              <div className="small muted">Uploading… {uploadPct}%</div>
              <div className="progress"><div style={{ width: `${uploadPct}%` }} /></div>
            </div>
          )}
          {error && <div className="alert error" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
          {messages.length > 0 && (
            <div className="alert warn small">
              {messages.map((m, i) => <div key={i}>{m}</div>)}
            </div>
          )}
        </div>
      ) : (
        <div className="alert info">
          {info.isDemo
            ? "This is the read-only demo corpus. Create your own workspace on the home page to upload documents."
            : "Only the owner of this workspace can upload documents."}
        </div>
      )}

      {job && (
        <div className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>Indexing</h3>
            <span className={`badge ${job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : "accent"}`}>{job.status}</span>
            <span className="faint">{job.message}</span>
          </div>
          {job.total > 0 && (
            <div className="progress" style={{ marginTop: 10 }}>
              <div style={{ width: `${Math.round((100 * job.progress) / job.total)}%` }} />
            </div>
          )}
          {job.error && <div className="alert error" style={{ marginTop: 10 }}>{job.error}</div>}
        </div>
      )}

      <div className="card">
        <h2>Documents ({info.documents.length})</h2>
        {info.documents.length === 0 ? (
          <p className="faint">No documents yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>#</th><th>File</th><th>Type</th><th>Pages</th><th>Characters</th><th>Status</th></tr>
            </thead>
            <tbody>
              {info.documents.map((d) => (
                <tr key={d.doc_index}>
                  <td className="mono">doc{String(d.doc_index).padStart(2, "0")}</td>
                  <td>{d.source_file}</td>
                  <td>{d.file_type}</td>
                  <td>{d.page_count.toLocaleString()}</td>
                  <td>{d.char_count.toLocaleString()}</td>
                  <td><span className={`badge ${d.status === "indexed" ? "ok" : d.status === "failed" ? "bad" : "neutral"}`}>{d.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

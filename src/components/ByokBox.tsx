"use client";

import { useState } from "react";

/** Optional "bring your own key" control. The key lives only in React state (this tab's memory):
 *  it is sent as a header on run/canary requests and never written to storage or the database. */
export default function ByokBox({
  value,
  onChange,
  required,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  required: boolean;
}) {
  const [open, setOpen] = useState(required);
  const [draft, setDraft] = useState("");

  if (value) {
    return (
      <div className="row small">
        <span className="badge ok">Using your API key</span>
        <button className="btn sm" onClick={() => onChange(null)}>
          Forget key
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button className="btn sm" onClick={() => setOpen(true)} title="Use your own Anthropic key instead of the site's free quota">
        Use my own API key
      </button>
    );
  }
  return (
    <form
      className="row small"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) onChange(draft.trim());
        setDraft("");
      }}
    >
      <input
        type="password"
        autoComplete="off"
        placeholder="sk-ant-…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        style={{ width: 220 }}
        aria-label="Your Anthropic API key"
      />
      <button className="btn sm primary" disabled={!draft.trim()}>
        Use key
      </button>
      {!required && (
        <button type="button" className="btn sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      )}
      <span className="faint" style={{ width: "100%" }}>
        Kept in this tab&apos;s memory only and sent over HTTPS with each request. The server never stores it.
        {required ? " This server has no shared key, so one is required." : ""}
      </span>
    </form>
  );
}

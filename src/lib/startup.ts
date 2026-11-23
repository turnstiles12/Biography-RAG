import { q } from "./db";
import { config } from "./env";
import { runMigrations } from "./migrate";
import { purgeStaleWorkspaces } from "./workspaces";

/** Runs once per server process (from instrumentation.ts). */
export async function onServerStart(): Promise<void> {
  try {
    if (config.autoMigrate) {
      const applied = await runMigrations((m) => console.log(`[migrate] ${m}`));
      if (applied.length === 0) console.log("[migrate] schema up to date");
    }
    // Background work does not survive a restart; mark anything left running as failed.
    await q(
      "UPDATE jobs SET status = 'failed', error = 'Server restarted during this job. Upload again to retry.', updated_at = now() WHERE status IN ('queued','running')",
    );
    await q("UPDATE runs SET status = 'failed', error = 'Server restarted during this run.', finished_at = now() WHERE status = 'running'");
    const purged = await purgeStaleWorkspaces();
    if (purged) console.log(`[startup] purged ${purged} idle workspaces`);
    setInterval(() => void purgeStaleWorkspaces().catch(() => {}), 6 * 60 * 60 * 1000).unref();
  } catch (e) {
    console.error("[startup] failed:", (e as Error).message);
  }
}

import { config } from "@/lib/env";
import { QUERY_TEMPLATES } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, non-secret settings the UI needs. */
export async function GET() {
  return Response.json({
    demoWorkspaceId: config.demoWorkspaceId,
    allowByok: config.allowByok,
    serverKeyAvailable: !!config.anthropicApiKey,
    model: config.llmModel,
    limits: {
      maxFilesPerUpload: config.maxFilesPerUpload,
      maxFileMb: config.maxFileMb,
      maxUploadMb: config.maxUploadMb,
      maxPagesPerWorkspace: config.maxPagesPerWorkspace,
      runsPerDay: config.rlRunsPerDay,
      runsPerDayByok: config.rlRunsPerDayByok,
      canaryPerHour: config.rlCanaryPerHour,
    },
    retrieval: { topK: config.topK, minSimilarity: config.minSimilarity },
    queryTemplates: QUERY_TEMPLATES,
  });
}

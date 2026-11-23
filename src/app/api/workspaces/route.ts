import type { NextRequest } from "next/server";
import { config } from "@/lib/env";
import { apiBudget, assertSameOrigin, handleError, HttpError, json, limit, ownerCookie } from "@/lib/http";
import { cleanPersonName, createWorkspace, newOwnerToken } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a private workspace for one person. The creator receives an httpOnly owner cookie. */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    await apiBudget(req);
    const body = (await req.json().catch(() => null)) as { personName?: unknown } | null;
    let personName: string;
    try {
      personName = cleanPersonName(body?.personName);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    await limit(req, "workspaces", config.rlWorkspacesPerDay, 86400);
    const token = newOwnerToken();
    const ws = await createWorkspace({ personName, ownerToken: token });
    const res = json({ id: ws.id, personName: ws.person_name }, { status: 201 });
    ownerCookie(res, ws.id, token, req);
    return res;
  } catch (e) {
    return handleError(e);
  }
}

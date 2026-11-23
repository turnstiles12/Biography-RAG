import { Suspense } from "react";
import Workspace from "@/components/Workspace";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="faint">Loading…</p>}>
      <Workspace id={id} />
    </Suspense>
  );
}

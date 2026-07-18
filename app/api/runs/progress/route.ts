/**
 * GET /api/runs/progress?config=name → Server-Sent Events
 *
 * Each `data:` frame is a ProgressEvent. Progress is DERIVED FROM DISK
 * (deriveProgress) so a reconnecting tab or a restarted server still sees the
 * truth; the in-process emitter (runManager) only makes updates immediate. A
 * frame is sent at least every ~1.5s while a run is active, plus instantly on
 * each emitter tick. The stream ends with a terminal { phase: "done",
 * outageProviders } — when the run finishes or when no run is active after the
 * first frame.
 */
import { NextRequest } from "next/server";
import { loadConfig } from "../../../../lib/ui/configStore";
import { deriveProgress } from "../../../../lib/ui/progress";
import { computeOutageProviders } from "../../../../lib/ui/renderPipeline";
import { activeRun, runEvents } from "../../../../lib/ui/runManager";
import type { DoneTick, ProgressTick } from "../../../../lib/ui/runManager";
import { resultsPath } from "../../../lib/contract";
import type { ProgressEvent, RunConfig } from "../../../lib/contract";
import { loadCells } from "../../_lib/cells";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest): Response {
  const name = req.nextUrl.searchParams.get("config");
  if (!name) return new Response("config query param required", { status: 400 });

  let config: RunConfig;
  try {
    config = loadConfig(name);
  } catch {
    return new Response("config not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const send = (ev: ProgressEvent): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        runEvents.off("progress", onProgress);
        runEvents.off("done", onDone);
        req.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Which phase to report: generation until it completes, then extraction.
      const frame = (): ProgressEvent => {
        const p = deriveProgress(loadCells(resultsPath(name)), config);
        if (p.generation.done < p.generation.total) {
          return { phase: "generation", ...p.generation };
        }
        return { phase: "extraction", ...p.extraction };
      };

      const finish = (outageProviders?: string[]): void => {
        const outage =
          outageProviders ?? computeOutageProviders(loadCells(resultsPath(name)), config);
        send({ phase: "done", outageProviders: outage });
        close();
      };

      const onProgress = (t: ProgressTick): void => {
        if (t.configName !== name) return;
        send({ phase: t.phase, done: t.done, total: t.total, failed: t.failed });
      };
      const onDone = (t: DoneTick): void => {
        if (t.configName !== name) return;
        finish(t.outageProviders);
      };

      runEvents.on("progress", onProgress);
      runEvents.on("done", onDone);
      req.signal.addEventListener("abort", close);

      // Immediate first frame, then either terminate (no run) or keep streaming.
      send(frame());
      if (!activeRun().running) {
        finish();
        return;
      }
      timer = setInterval(() => {
        if (closed) return;
        if (!activeRun().running) {
          finish();
          return;
        }
        send(frame());
      }, 1500);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

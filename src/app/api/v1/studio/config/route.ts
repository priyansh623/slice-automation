import { NextResponse } from 'next/server';
import { studioRoute } from '@/lib/studio/api';
import { generationReadiness } from '@/lib/studio/readiness';
import { ANALYSIS_KIND, budgetStatus } from '@/lib/studio/budget';

const analysisLimit = (): number => { const n = parseInt(process.env.STUDIO_ANALYSIS_BUDGET_PER_HOUR ?? '600', 10); return Number.isFinite(n) && n >= 0 ? n : 600; };

// Operational status for the Studio. No secrets: only whether generation is on (disabled / mock test mode / real), whether a worker is
// running and agrees with this server about the provider, and this hour's image-analysis budget.
export const GET = studioRoute(async () => {
  const r = await generationReadiness();
  return NextResponse.json({
    generation: {
      enabled: r.config.enabled, mode: r.config.mode, provider: r.config.provider, testMode: r.config.testMode, reason: r.config.reason,
      ready: r.ready, code: r.code, message: r.message,
      worker: r.worker ? { status: r.worker.status, providers: r.worker.workerProviders } : null,
    },
    analysisBudget: await budgetStatus(ANALYSIS_KIND, analysisLimit()),
  });
});

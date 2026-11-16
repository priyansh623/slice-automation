/**
 * Whether a generation batch can be created right now: this process has a provider, a Studio worker is running, it uses the SAME
 * provider, and it is ready. Nothing is queued that no worker would process.
 */
import { generationConfig, type GenerationConfig } from './mock-provider';
import { checkWorkerForProvider, type WorkerCheck } from './worker-status';
import { StudioError } from './repository';

export interface GenerationReadiness {
  ready: boolean;
  /** Why not: generation_disabled | worker_unavailable | provider_mismatch | worker_not_ready. */
  code: 'generation_disabled' | 'worker_unavailable' | 'provider_mismatch' | 'worker_not_ready' | null;
  message: string | null;
  config: GenerationConfig;
  worker: WorkerCheck | null;
}

export async function generationReadiness(now = Date.now()): Promise<GenerationReadiness> {
  const config = generationConfig();
  if (!config.enabled || !config.provider) return { ready: false, code: 'generation_disabled', message: config.reason, config, worker: null };
  const worker = await checkWorkerForProvider(config.provider, now);
  if (worker.status === 'ok') return { ready: true, code: null, message: null, config, worker };
  const code = worker.status === 'no_worker' ? 'worker_unavailable' : worker.status === 'provider_mismatch' ? 'provider_mismatch' : 'worker_not_ready';
  return { ready: false, code, message: worker.message, config, worker };
}

/** Throws a 503 (with the reason) unless generation can run now. Returns the readiness, so the caller has the provider id. */
export async function assertGenerationReady(): Promise<GenerationReadiness & { config: GenerationConfig & { provider: string } }> {
  const r = await generationReadiness();
  if (!r.ready || !r.config.provider) throw new StudioError(r.message ?? 'Image generation is not available.', 503, r.code ?? 'generation_disabled');
  return r as GenerationReadiness & { config: GenerationConfig & { provider: string } };
}

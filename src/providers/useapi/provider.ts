import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { VideoGenerationProvider } from './interface';
import {
  AuthenticationError,
  ConfigurationError,
  OutputExpiredError,
  PermanentDownloadError,
  RateLimitError,
  TemporaryDownloadError,
  UnexpectedProviderError,
} from './errors';

const BASE_URL = 'https://api.useapi.net/v1/google-flow';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.USEAPI_TOKEN}` };
}

export class UseapiGoogleFlowProvider implements VideoGenerationProvider {
  async uploadReferenceImage(params: {
    imagePath: string;
    contentType: string;
    email: string;
  }): Promise<{ mediaGenerationId: string }> {
    const fileBuffer = fs.readFileSync(params.imagePath);
    const filename = path.basename(params.imagePath);

    const url = `${BASE_URL}/assets/${encodeURIComponent(params.email)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': params.contentType },
      body: fileBuffer,
    });

    if (res.status === 401) throw new AuthenticationError('USEAPI_TOKEN invalid or expired');
    if (res.status === 596) throw new ConfigurationError('Google Flow not configured or Google session expired');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UnexpectedProviderError(`Upload failed: ${res.status} ${text}`, res.status);
    }

    const json = (await res.json()) as Record<string, unknown>;
    // mediaGenerationId is a nested object: { mediaGenerationId: "user:...-image:..." }
    const mid = json.mediaGenerationId as Record<string, string> | string | undefined;
    const mediaGenerationId = typeof mid === 'object' && mid !== null ? mid.mediaGenerationId : (mid ?? json.id as string | undefined);
    if (!mediaGenerationId) throw new UnexpectedProviderError(`uploadReferenceImage: no media id in response: ${JSON.stringify(json)}`, res.status);
    return { mediaGenerationId };
  }

  async submitGeneration(params: {
    prompt: string;
    model: string;
    referenceImageMediaId: string;
    duration: number;
    aspectRatio: string;
    seed?: number;
    correlationId: string;
  }): Promise<{ jobId: string; videoUrl?: string; mediaGenerationId?: string }> {
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      model: params.model,
      referenceImage_1: params.referenceImageMediaId,
      duration: params.duration,
      aspectRatio: params.aspectRatio,
    };
    if (params.seed !== undefined) body.seed = params.seed;

    const res = await fetch(`${BASE_URL}/videos`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 401) throw new AuthenticationError('USEAPI_TOKEN invalid or expired');
    if (res.status === 596) throw new ConfigurationError('Google Flow not configured or Google session expired');
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10) * 1000;
      const text = await res.text().catch(() => '');
      throw new RateLimitError(`All Google Flow accounts busy (429): ${text}`, retryAfter);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UnexpectedProviderError(`Submit failed: ${res.status} ${text}`, res.status);
    }

    const json = (await res.json()) as Record<string, unknown>;
    const jobId = (json.jobId ?? json.job_id ?? json.id ?? json.videoId) as string | undefined;
    if (!jobId) throw new UnexpectedProviderError(`submitGeneration: no job id in response: ${JSON.stringify(json)}`, res.status);

    // This API often returns a completed video synchronously — extract it if present
    type MediaItem = { videoUrl?: string; mediaGenerationId?: string; mediaMetadata?: { mediaStatus?: { mediaGenerationStatus?: string } } };
    const firstMedia = ((json.media as MediaItem[] | undefined) ?? [])[0];
    const immediateVideoUrl = firstMedia?.videoUrl as string | undefined;
    const immediateMediaId = firstMedia?.mediaGenerationId as string | undefined;
    const isImmediate = firstMedia?.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL';

    return { jobId, videoUrl: isImmediate ? immediateVideoUrl : undefined, mediaGenerationId: isImmediate ? immediateMediaId : undefined };
  }

  async pollJob(jobId: string): Promise<{
    status: 'created' | 'started' | 'completed' | 'failed';
    videoUrl?: string;
    outputMediaGenerationId?: string;
    remainingCredits?: number;
    errorMessage?: string;
    errorCode?: string;
    retryAfterMs?: number;
  }> {
    const res = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(),
    });

    if (res.status === 401) throw new AuthenticationError('USEAPI_TOKEN invalid or expired');
    if (res.status === 596) throw new ConfigurationError('Google Flow not configured');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UnexpectedProviderError(`Poll failed: ${res.status} ${text}`, res.status);
    }

    const json = (await res.json()) as Record<string, unknown>;
    console.log('[useapi] pollJob response:', JSON.stringify(json).slice(0, 500));

    // API returns media[] array; status is derived from mediaGenerationStatus
    type MediaItem = { videoUrl?: string; thumbnailUrl?: string; mediaGenerationId?: string; mediaMetadata?: { mediaStatus?: { mediaGenerationStatus?: string } }; url?: string };
    const media = (json.media ?? json.videos) as MediaItem[] | undefined;
    const firstMedia = media?.[0];

    // Derive status: explicit json.status, or from mediaGenerationStatus
    const rawStatus = json.status as string | undefined;
    const genStatus = firstMedia?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ?? '';
    let status: 'created' | 'started' | 'completed' | 'failed';
    if (rawStatus === 'completed' || genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
      status = 'completed';
    } else if (rawStatus === 'failed' || genStatus === 'MEDIA_GENERATION_STATUS_FAILED') {
      status = 'failed';
    } else if (rawStatus === 'started') {
      status = 'started';
    } else {
      status = 'created';
    }

    const videoUrl = firstMedia?.videoUrl ?? firstMedia?.url;
    const outputMediaGenerationId = firstMedia?.mediaGenerationId;

    return {
      status,
      videoUrl,
      outputMediaGenerationId,
      remainingCredits: json.remainingCredits as number | undefined,
      errorMessage: json.errorMessage as string | undefined,
      errorCode: json.errorCode as string | undefined,
    };
  }

  async downloadVideo(params: {
    jobId: string;
    signedUrl: string | null;
    outputMediaGenerationId: string | null;
    jobCompletedAt: number;
  }): Promise<{ tempPath: string; contentType: string }> {
    const url = params.signedUrl;
    if (!url) throw new OutputExpiredError('No video URL available for download');

    const res = await fetch(url);

    if (res.status === 401) throw new AuthenticationError('Download URL auth failed');
    if (res.status === 403 || res.status === 404) {
      throw new PermanentDownloadError(`Video no longer accessible: ${res.status}`);
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10) * 1000;
      throw new TemporaryDownloadError(`Rate limited: ${res.status}`, retryAfter);
    }
    if (!res.ok) {
      throw new UnexpectedProviderError(`Download failed: ${res.status}`, res.status);
    }

    const contentType = res.headers.get('content-type') ?? 'video/mp4';
    const ext = contentType.includes('webm') ? 'webm' : 'mp4';

    const storageDir = process.env.STORAGE_DIR ?? './storage';
    fs.mkdirSync(storageDir, { recursive: true });
    const tempName = `${params.jobId}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const tempPath = path.join(storageDir, tempName);

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);

    return { tempPath, contentType };
  }
}

export const useapiProvider: VideoGenerationProvider = new UseapiGoogleFlowProvider();

/**
 * Technical rules for a video entering a bulk B-roll batch. Pure (no node or browser APIs), so the browser checks the
 * file before anything is analysed and the tests check the very same code. The server enforces the same limits again
 * (broll-direct-upload.ts and the ffprobe check in the complete route): this is for fast, clear feedback, not trust.
 */
export type IssueSeverity = 'error' | 'warning';
export interface ValidationIssue { code: string; severity: IssueSeverity; message: string }

export const BULK_TYPE_BY_EXT: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo' };
export const BULK_ALLOWED_TYPES = Object.values(BULK_TYPE_BY_EXT);
/** Same product limit as the direct upload flow (500 MiB). */
export const BULK_MAX_BYTES = 500 * 1024 * 1024;
export const BULK_MAX_FILES = 100;
export const BULK_MIN_DURATION_S = 0.5;
export const BULK_LONG_DURATION_S = 120;
/** Same tolerance as the server's check: width / height within 0.05 of 9 / 16. */
export const ASPECT_TARGET = 9 / 16;
export const ASPECT_TOLERANCE = 0.05;

export const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** The video type to use: the browser's own value when it is an allowed video type, otherwise taken from the extension. */
export function resolveContentType(file: { name: string; type: string }): string | null {
  const t = (file.type ?? '').toLowerCase();
  if (BULK_ALLOWED_TYPES.includes(t)) return t;
  return BULK_TYPE_BY_EXT[extOf(file.name)] ?? null;
}

export const isPortrait916 = (width: number, height: number): boolean => height > 0 && Math.abs(width / height - ASPECT_TARGET) <= ASPECT_TOLERANCE;

const issue = (code: string, severity: IssueSeverity, message: string): ValidationIssue => ({ code, severity, message });

/** Checks that need nothing but the file's name, type and size. */
export function validateFileBasics(file: { name: string; type: string; size: number }): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const ext = extOf(file.name);
  const type = resolveContentType(file);
  if (!type) out.push(issue('unsupported_format', 'error', `Unsupported format${ext ? ` .${ext}` : ''}. Use MP4, MOV, WEBM or AVI.`));
  else if (ext && BULK_TYPE_BY_EXT[ext] && BULK_TYPE_BY_EXT[ext] !== type && (file.type ?? '') !== '') {
    out.push(issue('type_mismatch', 'error', `The file name says .${ext} but the file reports ${file.type}. Re-export it as a normal ${ext.toUpperCase()}.`));
  } else if (ext && !BULK_TYPE_BY_EXT[ext]) out.push(issue('unsupported_extension', 'error', `Unsupported file extension .${ext}. Use MP4, MOV, WEBM or AVI.`));
  if (file.size <= 0) out.push(issue('empty_file', 'error', 'The file is empty.'));
  else if (file.size > BULK_MAX_BYTES) out.push(issue('too_large', 'error', `The file is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${BULK_MAX_BYTES / 1048576} MB.`));
  return out;
}

/** Checks that need the video's real size and length, read by the browser from the file itself. */
export function validateVideoFacts(facts: { width: number; height: number; durationSeconds: number }): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const { width, height, durationSeconds } = facts;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    out.push(issue('no_dimensions', 'error', 'The video has no readable dimensions.'));
  } else if (!isPortrait916(width, height)) {
    out.push(issue('not_9_16', 'error', `Video must be 9:16 aspect ratio. Detected ${width}×${height}.`));
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < BULK_MIN_DURATION_S) out.push(issue('no_duration', 'error', 'The video has no readable duration (or is shorter than half a second).'));
  else if (durationSeconds > BULK_LONG_DURATION_S) out.push(issue('long_video', 'warning', `This video is ${Math.round(durationSeconds)} s long, much longer than usual B-roll.`));
  return out;
}

export const hasBlockingIssue = (issues: ValidationIssue[]): boolean => issues.some((i) => i.severity === 'error');

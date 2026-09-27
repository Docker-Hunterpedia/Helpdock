import type { AttachmentKind, ContentPolicy, KindPolicy } from '../transport/types.js';

/**
 * The client half of the rich content policy (ARCHITECTURE §9, M4-07). The
 * server enforces the same rules at presign time and again in the worker; this
 * copy only saves the visitor an upload that would be refused.
 */
export interface FileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface PolicyProblem {
  readonly key: string;
  readonly vars: Readonly<Record<string, string | number>>;
}

export function kindOf(mime: string): Exclude<AttachmentKind, 'voice'> {
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  return 'file';
}

export function mimeAllowed(mime: string, allowed: readonly string[]): boolean {
  const type = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  return allowed.some((pattern) => {
    const rule = pattern.toLowerCase();
    return rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : type === rule;
  });
}

/** Whether the paperclip is drawn at all (`WidgetStatesEN`: "Attach hides when every file type is off"). */
export function canAttach(policy: ContentPolicy): boolean {
  return policy.image.enabled || policy.video.enabled || policy.file.enabled;
}

/** The `accept` attribute for the file picker, so the OS dialog already filters. */
export function acceptList(policy: ContentPolicy): string {
  return [policy.image, policy.video, policy.file]
    .filter((kind) => kind.enabled)
    .flatMap((kind) => kind.allowed_mime)
    .join(',');
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const megabytes = bytes / (1024 * 1024);
    return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function checkFile(
  file: FileLike,
  kind: AttachmentKind,
  policy: KindPolicy,
): PolicyProblem | null {
  if (!policy.enabled || !mimeAllowed(file.type, policy.allowed_mime)) {
    return { key: 'attachment.typeRejected', vars: { name: file.name } };
  }
  if (file.size > policy.max_bytes) {
    return {
      key: `attachment.tooLarge.${kind}`,
      vars: {
        name: file.name,
        size: formatBytes(file.size),
        max: formatBytes(policy.max_bytes),
      },
    };
  }
  return null;
}

/** The first problem with a picked set of files, or `null` when all of them may be sent. */
export function checkFiles(
  files: readonly FileLike[],
  policy: ContentPolicy,
): PolicyProblem | null {
  if (files.length > policy.max_attachments_per_message) {
    return { key: 'attachment.tooMany', vars: { max: policy.max_attachments_per_message } };
  }
  for (const file of files) {
    const kind = kindOf(file.type);
    const problem = checkFile(file, kind, policy[kind]);
    if (problem) {
      return problem;
    }
  }
  return null;
}

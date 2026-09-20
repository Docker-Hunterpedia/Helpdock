import type {
  AttachmentKind,
  AttachmentRejectReason,
  ContentPolicy,
  MediaPolicy,
} from '@helpdock/schemas';
import { contentPolicySchema, policyFor } from '@helpdock/schemas';
import { isSniffableMime } from './magic-bytes.js';

/**
 * The brand's content policy, and the one place an upload is measured against
 * it (REQUIREMENTS §4.6, ARCHITECTURE §9: "enforced at presign time and again
 * in the worker").
 *
 * Both callers go through {@link checkUpload}: the presign endpoint, where a
 * refusal costs no bytes, and the worker, where the same policy is applied to
 * the object that actually arrived. One function, so the two can never drift —
 * a policy tightened while an upload was in flight refuses it at confirm.
 */

/**
 * A stored `brands.content_policy` as a whole policy.
 *
 * Anything unparseable falls back to the shipped default rather than throwing.
 * The column is jsonb, every field has a default, and a brand whose row somehow
 * holds nonsense must still be able to work tickets — with the conservative
 * policy, not with none.
 */
export const readContentPolicy = (stored: unknown): ContentPolicy => {
  const parsed = contentPolicySchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : contentPolicySchema.parse({});
};

/**
 * An upload the policy refuses. It carries the reason key that will be stored
 * on the row and shown to the person, never a sentence built from input.
 */
export class PolicyRefusal extends Error {
  readonly reason: AttachmentRejectReason;

  constructor(reason: AttachmentRejectReason) {
    super(`The content policy refuses this upload: ${reason}`);
    this.name = 'PolicyRefusal';
    this.reason = reason;
  }
}

export interface UploadClaim {
  readonly kind: AttachmentKind;
  readonly mime: string;
  readonly size: number;
}

/**
 * Throws a {@link PolicyRefusal} unless the brand allows this kind, this type
 * and this many bytes.
 *
 * The order matters for what a person is told: "images are off for this brand"
 * is a different answer from "that image is too big", and checking the switch
 * first means the second is never given when the first applies.
 *
 * The MIME is checked twice — once against the brand's list and once against
 * the sniffer's — because the two can disagree. A brand may allow a type the
 * pipeline has no signature for, and an upload the worker could never verify
 * must be refused before it is stored, not after.
 */
export const checkUpload = (policy: ContentPolicy, claim: UploadClaim): MediaPolicy => {
  const kindPolicy = policyFor(policy, claim.kind);

  if (!kindPolicy.enabled) {
    throw new PolicyRefusal('kind_disabled');
  }
  if (!kindPolicy.allowedMime.includes(claim.mime) || !isSniffableMime(claim.mime)) {
    throw new PolicyRefusal('mime_not_allowed');
  }
  if (claim.size > kindPolicy.maxBytes) {
    throw new PolicyRefusal('too_large');
  }

  return kindPolicy;
};

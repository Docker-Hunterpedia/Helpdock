/**
 * Injection tokens for the media module, declared apart from the classes that
 * use them for the reason `runtime/tokens.ts` gives: a token in the same file
 * as its provider makes the consumer import the provider's module, and an
 * interface has no runtime value to inject by.
 */

/** The bucket, as {@link ./storage.js ObjectStorage}. A test provides a double. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** Node's fatal TextDecoder error; unrelated TypeErrors must still propagate. */
export function isInvalidUtf8(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
  );
}

import { useEffect, useState } from 'preact/hooks';
import { initials } from '../format.js';

/**
 * A person's photo, or their initials (M14-12). The photo is a presigned URL
 * that expires in minutes, so an image that fails to load falls back to the
 * initials instead of a broken icon; a new URL (the next message carries one)
 * is tried again. Decorative: the name is always written beside it.
 */
export function Avatar({
  name,
  url = null,
  class: className,
  text,
}: {
  name: string;
  url?: string | null | undefined;
  class: string;
  /** What to draw instead of the initials of `name`, such as the brand's one letter. */
  text?: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [url]);

  return (
    <span class={className} aria-hidden="true">
      {url && !failed ? (
        <img src={url} alt="" decoding="async" onError={() => setFailed(true)} />
      ) : (
        (text ?? initials(name))
      )}
    </span>
  );
}

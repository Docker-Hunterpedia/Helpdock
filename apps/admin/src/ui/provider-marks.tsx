import type { ReactNode } from 'react';

/**
 * Google and GitHub wordmarks as inline monochrome paths. Lucide dropped brand
 * icons in v1 and DESIGN §5 allows no second icon set, so the two provider
 * buttons carry their mark inline (DESIGN §5, "provider marks"). Both are
 * decorative: the button's own label names the provider.
 */
const marks = {
  google:
    'M12 11v2.8h4a3.4 3.4 0 0 1-1.5 2.2l2.4 1.9A5.9 5.9 0 0 0 18.6 12c0-.4 0-.7-.1-1zM12 18.1a6 6 0 0 1-5.1-3l-2.5 1.9A8.9 8.9 0 0 0 12 21a8.5 8.5 0 0 0 5.9-2.1l-2.4-1.9a5.4 5.4 0 0 1-1.5.6zM6.7 12c0-.5.1-1 .2-1.4L4.4 8.7a8.9 8.9 0 0 0 0 6.6L6.9 13.4c-.1-.4-.2-.9-.2-1.4zM12 6.9c1.3 0 2.4.5 3.3 1.3l2.2-2.2A8.5 8.5 0 0 0 12 3.7 8.9 8.9 0 0 0 4.4 8.7l2.5 1.9A6 6 0 0 1 12 6.9z',
  github:
    'M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z',
} as const;

type ProviderMarkName = keyof typeof marks;

export function ProviderMark({
  name,
  size = 16,
}: {
  readonly name: ProviderMarkName;
  readonly size?: number;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={marks[name]} />
    </svg>
  );
}

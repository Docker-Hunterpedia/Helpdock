import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar.js';

afterEach(cleanup);

describe('Avatar (M14-12)', () => {
  it('draws the initials when there is no photo', () => {
    const { container } = render(<Avatar name="Lina Haddad" class="hd-avatar" />);

    expect(container.textContent).toBe('LH');
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws the photo, decoratively, when there is one', () => {
    const { container } = render(
      <Avatar name="Lina" url="https://bucket.test/lina/64.webp" class="hd-avatar" />,
    );

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://bucket.test/lina/64.webp');
    expect(image?.getAttribute('alt')).toBe('');
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the initials when the link has expired and the image fails to load', () => {
    const { container } = render(
      <Avatar name="Lina" url="https://bucket.test/gone.webp" class="hd-avatar" />,
    );

    fireEvent.error(container.querySelector('img') as Element);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('L');
  });

  it('tries a fresh link after a failed one', () => {
    const { container, rerender } = render(
      <Avatar name="Lina" url="https://bucket.test/old.webp" class="hd-avatar" />,
    );
    fireEvent.error(container.querySelector('img') as Element);

    rerender(<Avatar name="Lina" url="https://bucket.test/new.webp" class="hd-avatar" />);

    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://bucket.test/new.webp',
    );
  });

  it('draws the text it was given in place of the initials, such as the brand letter', () => {
    const { container } = render(
      <Avatar name="Helpdock support" text="H" class="hd-header-avatar" />,
    );

    expect(container.textContent).toBe('H');
  });
});

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render.tsx';
import { meterTone, UsageMeter } from './usage-meter.tsx';

describe('meterTone', () => {
  it('is the accent below 80 %, the warning from 80 % and the danger at 100 %', () => {
    expect(meterTone(79)).toBe('normal');
    expect(meterTone(80)).toBe('warning');
    expect(meterTone(99)).toBe('warning');
    expect(meterTone(100)).toBe('danger');
  });
});

describe('UsageMeter', () => {
  it('names its progress bar and says the share in words', () => {
    renderApp(
      <UsageMeter
        label="Files in S3"
        figure="18.4 GB"
        percent={37}
        caption="37 % of the 50 GB soft limit"
        accessibleLabel="Storage 37 %"
      />,
    );

    const bar = screen.getByRole('progressbar', { name: 'Storage 37 %' });
    expect(bar).toHaveAttribute('aria-valuenow', '37');
    expect(screen.getByText('37 % of the 50 GB soft limit')).toBeVisible();
  });

  it('hides the bar from assistive technology when the caption already says it', () => {
    renderApp(<UsageMeter percent={86} caption="86 % of $100 · past the 80 % alert" />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // From 80 % the caption carries an icon, so the warning is not the hue alone.
    expect(
      screen.getByText('86 % of $100 · past the 80 % alert').querySelector('svg'),
    ).not.toBeNull();
  });
});

import { Tooltip } from '@mui/material';
import type { ReactElement, ReactNode } from 'react';
import { usePreferences } from '../app/providers.tsx';

/**
 * The Tooltip of DESIGN §6.4 beside an icon of the collapsed sidebar, on hover
 * and on keyboard focus, at the rail's inline end. MUI places a tooltip by
 * physical side, so the inline end is spelled per direction.
 *
 * An empty `title` draws nothing but keeps the element in the same place in
 * the tree, so a control that is a rail icon in one state and a full row in
 * the other keeps its DOM node, and its focus, across the toggle.
 */
export function RailTooltip({
  title,
  describeChild = false,
  children,
}: {
  readonly title: string;
  /** For a control whose name is already set: the title becomes its description. */
  readonly describeChild?: boolean;
  readonly children: ReactElement;
}): ReactNode {
  const { locale } = usePreferences();

  return (
    <Tooltip
      title={title}
      placement={locale === 'ar' ? 'left' : 'right'}
      describeChild={describeChild}
    >
      {children}
    </Tooltip>
  );
}

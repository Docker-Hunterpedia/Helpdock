import { Tooltip } from '@mui/material';
import { cloneElement, type FocusEvent, type ReactElement, useEffect, useState } from 'react';

type TriggerProps = { onBlur?: (event: FocusEvent<HTMLElement>) => void };

/** DESIGN.md §6.4 header tooltips: non-interactive, hidden while the menu they open is shown. */
export function MenuTriggerTooltip({
  title,
  menuOpen,
  children,
}: {
  readonly title: string;
  readonly menuOpen: boolean;
  readonly children: ReactElement<TriggerProps>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [focusDisabled, setFocusDisabled] = useState(false);

  useEffect(() => {
    if (menuOpen) {
      setOpen(false);
      setFocusDisabled(true);
    }
  }, [menuOpen]);

  return (
    <Tooltip
      title={title}
      disableInteractive
      disableFocusListener={focusDisabled}
      open={open && !menuOpen}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
    >
      {cloneElement(children, {
        onBlur: (event) => {
          children.props.onBlur?.(event);
          setOpen(false);
          if (!menuOpen) setFocusDisabled(false);
        },
      })}
    </Tooltip>
  );
}

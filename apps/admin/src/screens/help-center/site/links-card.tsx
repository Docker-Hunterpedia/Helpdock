import { HC_LINKS_MAX, type HcLink, type HcLinks } from '@helpdock/schemas';
import { Box, Button, IconButton, TextField, Typography } from '@mui/material';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { SectionCard } from '../../admin/channels/section-card.tsx';
import { useHelpCenter, useReaderLocale } from '../use-help-center.js';
import { EMPTY_LINK, linkName, linksValid, moved } from './site-draft.js';
import { useSiteSave } from './use-site.js';

type Place = keyof HcLinks;

/**
 * "Header and footer links" (M5-06, `Admin/HelpCenter-Settings`): two ordered
 * tables of links, each a label per language and an address. A row moves with
 * ArrowUp / ArrowDown on its handle.
 */
export function LinksCard({
  links,
  canManage,
}: {
  readonly links: HcLinks;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT();
  const id = useId();
  const { api } = useHelpCenter();
  const [draft, setDraft] = useState<HcLinks>(links);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setDraft(links);
    setTried(false);
  }, [links]);

  const save = useSiteSave(api.saveLinks.bind(api), (site, result: HcLinks) => ({
    ...site,
    links: result,
  }));
  const valid = linksValid(draft);

  const setRows = (place: Place, rows: HcLink[]): void => {
    setDraft({ ...draft, [place]: rows });
  };

  return (
    <SectionCard
      id={`${id}-links`}
      heading={t('helpCenter:site.links.heading')}
      caption={t('helpCenter:site.links.caption')}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (valid) {
          save.mutate(draft);
        }
      }}
      {...(canManage
        ? {
            footer: (
              <>
                <Button variant="text" disabled={save.isPending} onClick={() => setDraft(links)}>
                  {t('helpCenter:settings.discard')}
                </Button>
                <Button type="submit" variant="contained" disabled={save.isPending}>
                  {t('helpCenter:settings.save')}
                </Button>
              </>
            ),
          }
        : {})}
    >
      {(['header', 'footer'] as const).map((place) => (
        <LinkTable
          key={place}
          place={place}
          rows={draft[place]}
          canManage={canManage}
          onChange={(rows) => setRows(place, rows)}
        />
      ))}
      {tried && !valid ? (
        <Typography role="alert" variant="caption" sx={{ color: 'error.main' }}>
          {t('helpCenter:site.links.invalid')}
        </Typography>
      ) : null}
    </SectionCard>
  );
}

function LinkTable({
  place,
  rows,
  canManage,
  onChange,
}: {
  readonly place: Place;
  readonly rows: readonly HcLink[];
  readonly canManage: boolean;
  readonly onChange: (rows: HcLink[]) => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const reader = useReaderLocale();
  const headingId = useId();
  const columns = canManage
    ? '32px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr) 32px'
    : 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr)';

  const update = (index: number, patch: Partial<HcLink>): void => {
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const cell = { display: 'flex', alignItems: 'center', minWidth: 0 } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography id={headingId} component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
        {t(`helpCenter:site.links.${place}`)}
      </Typography>
      <Box
        role="table"
        aria-labelledby={headingId}
        sx={{
          borderRadius: '6px',
          border: `1px solid ${tokens['border.default']}`,
          overflow: 'hidden',
          fontSize: 13,
        }}
      >
        <Box
          role="row"
          sx={{
            display: 'grid',
            gridTemplateColumns: columns,
            gap: 2,
            paddingInline: 2,
            minHeight: 32,
            alignItems: 'center',
            backgroundColor: tokens['bg.muted'],
            fontWeight: 500,
          }}
        >
          {canManage ? (
            <Box role="columnheader" sx={visuallyHidden}>
              {t('helpCenter:site.links.order')}
            </Box>
          ) : null}
          <Box role="columnheader">{t('helpCenter:site.links.english')}</Box>
          <Box role="columnheader">{t('helpCenter:site.links.arabic')}</Box>
          <Box role="columnheader">{t('helpCenter:site.links.address')}</Box>
          {canManage ? (
            <Box role="columnheader" sx={visuallyHidden}>
              {t('helpCenter:site.links.removeColumn')}
            </Box>
          ) : null}
        </Box>
        {rows.map((row, index) => {
          const name = linkName(row, reader, t('helpCenter:site.links.untitled'));
          return (
            <Box
              role="row"
              // Rows have no id of their own; their position is what they are.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              key={index}
              sx={{
                display: 'grid',
                gridTemplateColumns: columns,
                gap: 2,
                paddingInline: 2,
                paddingBlock: 2,
                borderBlockStart: `1px solid ${tokens['bg.muted']}`,
              }}
            >
              {canManage ? (
                <Box role="cell" sx={cell}>
                  <IconButton
                    size="small"
                    aria-label={t('helpCenter:site.links.move', { name })}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        onChange(moved(rows, index, event.key === 'ArrowUp' ? -1 : 1));
                      }
                    }}
                    sx={{ width: 28, height: 28 }}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                  </IconButton>
                </Box>
              ) : null}
              <Box role="cell" sx={cell}>
                <TextField
                  size="small"
                  fullWidth
                  value={row.labelEn}
                  disabled={!canManage}
                  onChange={(event) => update(index, { labelEn: event.target.value })}
                  slotProps={{
                    htmlInput: {
                      'aria-label': t('helpCenter:site.links.englishLabel', { name }),
                      lang: 'en',
                      dir: 'ltr',
                      maxLength: 60,
                    },
                  }}
                />
              </Box>
              <Box role="cell" sx={cell}>
                <TextField
                  size="small"
                  fullWidth
                  value={row.labelAr}
                  disabled={!canManage}
                  onChange={(event) => update(index, { labelAr: event.target.value })}
                  slotProps={{
                    htmlInput: {
                      'aria-label': t('helpCenter:site.links.arabicLabel', { name }),
                      lang: 'ar',
                      dir: 'rtl',
                      maxLength: 60,
                    },
                  }}
                />
              </Box>
              <Box role="cell" sx={cell}>
                <TextField
                  size="small"
                  fullWidth
                  type="url"
                  value={row.url}
                  disabled={!canManage}
                  onChange={(event) => update(index, { url: event.target.value })}
                  slotProps={{
                    htmlInput: {
                      'aria-label': t('helpCenter:site.links.addressLabel', { name }),
                      dir: 'ltr',
                      spellCheck: false,
                    },
                  }}
                  sx={{ '& input': { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 } }}
                />
              </Box>
              {canManage ? (
                <Box role="cell" sx={cell}>
                  <IconButton
                    size="small"
                    aria-label={t('helpCenter:site.links.remove', { name })}
                    onClick={() => onChange(rows.filter((_row, at) => at !== index))}
                    sx={{ width: 28, height: 28 }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </IconButton>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {canManage && rows.length < HC_LINKS_MAX ? (
        <Button
          size="small"
          variant="text"
          startIcon={<Plus size={16} aria-hidden="true" />}
          onClick={() => onChange([...rows, EMPTY_LINK])}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('helpCenter:site.links.add')}
        </Button>
      ) : null}
    </Box>
  );
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const;

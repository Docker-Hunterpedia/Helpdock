import type { TagColor, TagSummary } from '@helpdock/schemas';
import { TAG_NAME_MAX_LENGTH } from '@helpdock/schemas';
import {
  Box,
  Button,
  FormControlLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field } from '../../../ui/field.tsx';
import { TAG_COLOURS, tagTint } from './tag-colours.js';

/**
 * The side column of the Tags tab: the editor card for whichever tag the list
 * has selected, or the form that makes a new one. The same anatomy as
 * `DepartmentEditor`, because `Admin/Ticketing` draws one editor card and every
 * tab fills it.
 *
 * **The colour picker is a radio group.** Eight swatches, each a real `<input
 * type="radio">` with the colour's name as its label, so it is reachable by Tab,
 * moved with the arrow keys, announced by a screen reader and never a choice
 * that exists only as a colour (DESIGN §10: nothing depends on colour alone).
 */

export interface TagDraft {
  readonly name: string;
  readonly nameAr: string | null;
  readonly color: TagColor;
}

export function TagEditor({
  tag,
  busy,
  onSubmit,
  onCancel,
  onDelete,
}: {
  /** Null while the card is making a new tag rather than editing one. */
  readonly tag: TagSummary | null;
  readonly busy: boolean;
  onSubmit(draft: TagDraft): void;
  onCancel(): void;
  /** Absent while creating: there is nothing to delete yet. */
  onDelete?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const nameId = useId();
  const nameArId = useId();
  const colourId = useId();

  const [name, setName] = useState(tag?.name ?? '');
  const [nameAr, setNameAr] = useState(tag?.nameAr ?? '');
  const [colour, setColour] = useState<TagColor>(tag?.color ?? 'sand');

  // Selecting another row re-fills the card rather than re-mounting it, and it
  // follows the selection only: depending on the whole object would re-fill the
  // fields on every background refetch, and half a typed name would vanish.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different tag" is its id.
  useEffect(() => {
    setName(tag?.name ?? '');
    setNameAr(tag?.nameAr ?? '');
    setColour(tag?.color ?? 'sand');
  }, [tag?.id]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '') {
      return;
    }

    onSubmit({
      name: name.trim(),
      nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
      color: colour,
    });
  };

  const heading =
    tag === null ? t('ticketing:tags.editor.newHeading') : t('ticketing:tags.editor.heading');

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={heading}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2">
        {heading}
      </Typography>

      <Field id={nameId} label={t('ticketing:tags.editor.name')}>
        <TextField
          id={nameId}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: TAG_NAME_MAX_LENGTH } }}
        />
      </Field>

      <Field
        id={nameArId}
        label={t('ticketing:tags.editor.nameAr')}
        hint={t('ticketing:tags.editor.nameArHint')}
      >
        <TextField
          id={nameArId}
          value={nameAr}
          onChange={(event) => {
            setNameAr(event.target.value);
          }}
          size="small"
          slotProps={{ htmlInput: { maxLength: TAG_NAME_MAX_LENGTH, dir: 'rtl', lang: 'ar' } }}
        />
      </Field>

      <Box role="group" aria-labelledby={colourId}>
        <Typography
          id={colourId}
          component="p"
          sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', marginBlockEnd: '6px' }}
        >
          {t('ticketing:tags.editor.colour')}
        </Typography>
        <RadioGroup
          row
          value={colour}
          onChange={(event) => {
            setColour(event.target.value as TagColor);
          }}
          sx={{ gap: 2 }}
        >
          {TAG_COLOURS.map((candidate) => {
            const tint = tagTint(candidate, tokens);

            return (
              <FormControlLabel
                key={candidate}
                value={candidate}
                label=""
                slotProps={{
                  typography: { sx: { display: 'none' } },
                }}
                sx={{ margin: 0 }}
                control={
                  <Radio
                    size="small"
                    // The swatch is the control, so the name it is chosen by has
                    // to be on the input rather than beside it.
                    slotProps={{
                      input: {
                        'aria-label': t('ticketing:tags.editor.colourOption', {
                          colour: t(`ticketing:tags.colours.${candidate}`),
                        }),
                      },
                    }}
                    icon={<Swatch tint={tint} selected={false} />}
                    checkedIcon={<Swatch tint={tint} selected />}
                    sx={{ padding: 1 }}
                  />
                }
              />
            );
          })}
        </RadioGroup>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || name.trim() === ''}>
          {tag === null ? t('ticketing:tags.editor.create') : t('ticketing:tags.editor.save')}
        </Button>
      </Box>

      {onDelete === undefined ? null : (
        <Button
          variant="text"
          color="error"
          onClick={onDelete}
          disabled={busy}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('ticketing:tags.editor.delete')}
        </Button>
      )}
    </Box>
  );
}

/**
 * One swatch. The selected one carries a second ring rather than only a
 * stronger colour, so which is chosen survives greyscale and a colour-vision
 * difference (DESIGN §10).
 */
function Swatch({
  tint,
  selected,
}: {
  readonly tint: { background: string; border: string };
  readonly selected: boolean;
}): ReactNode {
  return (
    <Box
      aria-hidden="true"
      sx={{
        inlineSize: 20,
        blockSize: 20,
        borderRadius: '6px',
        backgroundColor: tint.background,
        border: `1px solid ${tint.border}`,
        boxShadow: selected ? `0 0 0 2px ${tint.border}` : 'none',
      }}
    />
  );
}

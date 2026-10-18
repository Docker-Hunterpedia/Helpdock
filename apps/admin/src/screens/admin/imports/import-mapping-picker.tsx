import {
  type ImportMapping,
  type ImportMappingTargetChoice,
  type ImportMappingValue,
  importMappingChoiceId,
} from '@helpdock/schemas';
import { Autocomplete, Box, Button, TextField, Typography } from '@mui/material';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useImportsApi } from '../../../imports/context.tsx';
import { Field } from '../../../ui/field.js';
import { useDebounced } from '../../../ui/use-debounced.js';

/**
 * Only an opened combobox searches the potentially large destination catalog; a closed one names
 * its destination from the saved or proposed choice, or from the option the admin just picked.
 */
export function ImportMappingPicker({
  brandId,
  runId,
  source,
  kind,
  value,
  disabled,
  onChange,
}: {
  brandId: string;
  runId: string;
  source: ImportMappingValue;
  kind: ImportMapping['kind'];
  value: ImportMapping | null;
  disabled: boolean;
  onChange: (value: ImportMapping | null) => void;
}) {
  const api = useImportsApi();
  const t = useT();
  const { locale } = usePreferences();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ImportMappingTargetChoice | null>(null);
  const settled = useDebounced(search, 250);
  const selectedId = importMappingChoiceId(value);
  const query = { kind, externalValue: source.externalValue, search: settled, limit: 50 };
  const choices = useInfiniteQuery({
    queryKey: ['imports', brandId, 'run', runId, 'mapping-targets', query],
    queryFn: ({ pageParam }) =>
      api.mappingTargets(brandId, runId, {
        ...query,
        ...(pageParam === null ? {} : { after: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && !disabled,
  });
  const options = choices.data?.pages.flatMap((page) => page.choices) ?? [];
  const found = [picked, source.confirmedChoice, source.proposedChoice, ...options].find(
    (option) => option?.id === selectedId,
  );
  const selectedOption: ImportMappingTargetChoice | null =
    found ??
    (selectedId && value
      ? {
          id: selectedId,
          label: t('imports:mapping.selected'),
          nameAr: null,
          detail: selectedId,
          selection: value,
        }
      : null);
  const label = (option: ImportMappingTargetChoice) =>
    locale === 'ar' && option.nameAr ? option.nameAr : option.label;
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Field id={id} label={t('imports:mapping.destination')}>
        <Autocomplete<ImportMappingTargetChoice>
          id={id}
          size="small"
          open={open}
          disabled={disabled}
          onOpen={() => setOpen(true)}
          onClose={() => {
            setOpen(false);
            setSearch('');
          }}
          options={
            selectedOption && !options.some((option) => option.id === selectedOption.id)
              ? [selectedOption, ...options]
              : options
          }
          value={selectedOption}
          getOptionLabel={label}
          isOptionEqualToValue={(option, current) => option.id === current.id}
          filterOptions={(items) => items}
          loading={choices.isFetching}
          loadingText={t('imports:loading')}
          noOptionsText={t('imports:mapping.noTargets')}
          onInputChange={(_event, input, reason) => {
            if (reason === 'input' || reason === 'clear') setSearch(input);
          }}
          onChange={(_event, option) => {
            setPicked(option);
            onChange(option?.selection ?? null);
          }}
          renderOption={(props, option) => {
            const { key, ...rest } = props;
            return (
              <li key={key} {...rest}>
                <Box>
                  <Typography>{label(option)}</Typography>
                  {option.detail ? (
                    <Typography variant="caption" color="text.secondary">
                      <bdi>{option.detail}</bdi>
                    </Typography>
                  ) : null}
                </Box>
              </li>
            );
          }}
          renderInput={(params) => (
            <TextField {...params} placeholder={t('imports:mapping.choose')} />
          )}
        />
      </Field>
      {choices.isError ? (
        <Button size="small" disabled={disabled} onClick={() => void choices.refetch()}>
          {t('imports:retry')}
        </Button>
      ) : null}
      {open && choices.hasNextPage ? (
        <Button
          size="small"
          disabled={choices.isFetchingNextPage || disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void choices.fetchNextPage()}
        >
          {t('imports:mapping.moreTargets')}
        </Button>
      ) : null}
    </Box>
  );
}

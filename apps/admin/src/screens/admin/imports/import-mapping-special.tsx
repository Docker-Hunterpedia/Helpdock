import {
  customFieldCreateRequestSchema,
  type ImportMapping,
  type ImportMappingValue,
} from '@helpdock/schemas';
import { Box, Checkbox, FormControlLabel, Skeleton, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useTicketingApi } from '../../../auth/session.tsx';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.js';

export function ImportInvitedPerson({
  brandId,
  source,
  value,
  disabled,
  onChange,
}: {
  brandId: string;
  source: ImportMappingValue;
  value: ImportMapping | null;
  disabled: boolean;
  onChange: (mapping: ImportMapping | null) => void;
}) {
  const t = useT();
  const api = useTicketingApi();
  const departments = useQuery({
    queryKey: ['imports', brandId, 'departments'],
    queryFn: () => api.departments(brandId),
  });
  const selected =
    value?.kind === 'agent' && value.target.kind === 'invited' ? value.target.departmentIds : [];
  if (!source.person?.email)
    return <AlertBanner tone="warning">{t('imports:mapping.emailRequired')}</AlertBanner>;
  return (
    <Box>
      <Typography variant="caption">{t('imports:mapping.noInvitation')}</Typography>
      {departments.isError ? (
        <AlertBanner tone="danger">{t('imports:loadFailed')}</AlertBanner>
      ) : null}
      {departments.isPending ? <Skeleton /> : null}
      <Box component="fieldset" disabled={disabled} sx={{ border: 0, padding: 0, margin: 0 }}>
        <legend>{t('imports:mapping.departments')}</legend>
        {departments.data?.departments.map((department) => (
          <FormControlLabel
            key={department.id}
            label={department.name}
            control={
              <Checkbox
                checked={selected.includes(department.id)}
                onChange={(_event, checked) => {
                  const ids = checked
                    ? [...selected, department.id]
                    : selected.filter((id) => id !== department.id);
                  onChange(
                    ids.length
                      ? {
                          kind: 'agent',
                          externalValue: source.externalValue,
                          target: { kind: 'invited', departmentIds: ids },
                        }
                      : null,
                  );
                }}
              />
            }
          />
        ))}
      </Box>
      {!selected.length ? (
        <Typography variant="caption" color="text.secondary">
          {t('imports:mapping.departmentRequired')}
        </Typography>
      ) : null}
    </Box>
  );
}

export function ImportNewField({
  brandId,
  runId,
  source,
  value,
  disabled,
  onChange,
}: {
  brandId: string;
  runId: string;
  source: ImportMappingValue;
  value: ImportMapping | null;
  disabled: boolean;
  onChange: (mapping: ImportMapping | null) => void;
}) {
  const t = useT();
  const api = useImportsApi();
  const field = useQuery({
    queryKey: ['imports', brandId, 'run', runId, 'field-definition', source.externalValue],
    queryFn: () => api.mappingField(brandId, runId, { externalId: source.externalValue }),
  });
  if (field.isError) return <AlertBanner tone="danger">{t('imports:loadFailed')}</AlertBanner>;
  if (!field.data) return <Skeleton />;
  return (
    <NewFieldDefinition
      key={source.externalValue}
      field={field.data}
      value={value}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function NewFieldDefinition({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Awaited<ReturnType<ReturnType<typeof useImportsApi>['mappingField']>>;
  value: ImportMapping | null;
  disabled: boolean;
  onChange: (mapping: ImportMapping | null) => void;
}) {
  const t = useT();
  const id = useId();
  const initial =
    value?.kind === 'field' && value.target.kind === 'create' ? value.target.definition : null;
  const [key, setKey] = useState(initial?.key ?? field.key);
  const [label, setLabel] = useState(initial?.label ?? field.label);
  const [labelAr, setLabelAr] = useState(initial?.labelAr ?? '');
  const definition = (next: { key: string; label: string; labelAr: string }) =>
    customFieldCreateRequestSchema.safeParse({
      target: field.target === 'organization' ? 'account' : field.target,
      type:
        field.type === 'textarea'
          ? 'text'
          : field.type === 'multiselect'
            ? 'multi_select'
            : field.type,
      ...next,
      labelAr: next.labelAr.trim() || null,
      options: field.options?.map((option) => option.value) ?? [],
      required: false,
      agentVisible: true,
    });
  const valid = definition({ key, label, labelAr }).success;
  const update = (next: { key: string; label: string; labelAr: string }) => {
    const result = definition(next);
    onChange(
      result.success
        ? {
            kind: 'field',
            externalValue: field.externalId,
            target: { kind: 'create', definition: result.data },
          }
        : null,
    );
  };
  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      <Field id={`${id}-key`} label={t('imports:mapping.fieldKey')}>
        <TextField
          id={`${id}-key`}
          size="small"
          disabled={disabled}
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            update({ key: event.target.value, label, labelAr });
          }}
        />
      </Field>
      <Field id={`${id}-label`} label={t('imports:mapping.fieldLabel')}>
        <TextField
          id={`${id}-label`}
          size="small"
          disabled={disabled}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
            update({ key, label: event.target.value, labelAr });
          }}
        />
      </Field>
      <Field id={`${id}-label-ar`} label={t('imports:mapping.fieldLabelAr')}>
        <TextField
          id={`${id}-label-ar`}
          size="small"
          disabled={disabled}
          value={labelAr}
          onChange={(event) => {
            setLabelAr(event.target.value);
            update({ key, label, labelAr: event.target.value });
          }}
        />
      </Field>
      {field.options?.length ? (
        <Typography variant="caption">
          {t('imports:mapping.optionsPreserved', { count: field.options.length })}
        </Typography>
      ) : null}
      {!valid ? (
        <AlertBanner tone="warning">{t('imports:mapping.invalidDefinition')}</AlertBanner>
      ) : null}
      <Typography variant="caption">{t('imports:mapping.createOnImport')}</Typography>
      <FormControlLabel
        label={t('imports:mapping.confirmField')}
        control={
          <Checkbox
            disabled={disabled || !valid}
            checked={value?.kind === 'field' && value.target.kind === 'create'}
            onChange={(_event, checked) =>
              checked ? update({ key, label, labelAr }) : onChange(null)
            }
          />
        }
      />
    </Box>
  );
}

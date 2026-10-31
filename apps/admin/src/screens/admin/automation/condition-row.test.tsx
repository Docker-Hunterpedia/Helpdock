import type { RuleBuilderOptions } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { ActionRow } from './action-row.tsx';
import { ConditionRow } from './condition-row.tsx';
import { newAction, newCondition } from './rule-draft.js';
import { useRuleText } from './rule-text.js';

/**
 * The M14-27 field types in the rule builder: a person is picked by name and
 * stored by id (so nobody types a UUID), and a long text is searched with
 * `contains`.
 */

const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
const options: RuleBuilderOptions = {
  statuses: [],
  departments: [],
  teams: [],
  tags: [],
  members: [
    { id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a', name: 'Lina Haddad' },
    { id: OMAR, name: 'Omar Nasser' },
  ],
  accounts: [],
  customFields: [
    { key: 'owner', label: 'Owner', labelAr: null, type: 'person' },
    { key: 'notes', label: 'Notes', labelAr: null, type: 'long_text' },
  ],
  cannedResponses: [],
};

function Row({ onChange }: { readonly onChange: (next: unknown) => void }) {
  const text = useRuleText(options);

  return (
    <ConditionRow
      condition={newCondition('custom_field', 'owner')}
      options={options}
      text={text}
      onChange={onChange}
      onRemove={() => undefined}
    />
  );
}

describe('ConditionRow, custom fields', () => {
  it('picks a person by name, keeps the id, and offers no "contains"', async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<Row onChange={onChange} />);

    const operators = screen.getByRole('combobox', { name: 'Operator' });
    expect([...operators.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'is',
      'is_not',
      'is_set',
    ]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Value' }), 'Omar Nasser');

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ values: [OMAR] }));
  });

  it('searches a long text with "contains", first', () => {
    const text = (
      <ConditionRow
        condition={newCondition('custom_field', 'notes')}
        options={options}
        text={{ field: () => 'Notes' } as never}
        onChange={() => undefined}
        onRemove={() => undefined}
      />
    );
    renderApp(text);

    const operators = screen.getByRole('combobox', { name: 'Operator' });
    expect((operators as HTMLSelectElement).value).toBe('contains');
  });
});

describe('ActionRow, set field', () => {
  it('picks the person to set by name and stores the id', async () => {
    const onChange = vi.fn();
    const { user } = renderApp(
      <ActionRow
        action={{ ...newAction('set_field'), key: 'owner', value: '' } as never}
        index={0}
        options={options}
        onChange={onChange}
        onRemove={() => undefined}
        onMove={() => undefined}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Value' }), 'Omar Nasser');

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ value: OMAR }));
  });
});

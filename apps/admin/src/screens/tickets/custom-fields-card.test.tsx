import type { CustomFieldDef, CustomFieldType, Session } from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../auth/session.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { CustomFieldsCard } from './custom-fields-card.tsx';

/**
 * The editors of the details panel's custom fields (M1-15), one per type: what
 * each sends, and when. The ticket screen's own tests cover the round trip
 * through the fixture; these cover the controls a seeded brand does not have.
 */

const def = (
  type: CustomFieldType,
  label: string,
  overrides: Partial<CustomFieldDef> = {},
): CustomFieldDef => ({
  id: `id-${type}`,
  target: 'ticket',
  key: type,
  label,
  labelAr: null,
  type,
  options: type === 'select' || type === 'multi_select' ? ['DHL', 'UPS'] : [],
  required: false,
  requiredToClose: false,
  agentVisible: true,
  pinned: false,
  sortOrder: 0,
  ...overrides,
});

const FIELDS = [
  def('number', 'Amount'),
  def('select', 'Carrier'),
  def('multi_select', 'Carriers'),
  def('checkbox', 'Gift'),
];

const renderCard = (onSave = vi.fn().mockResolvedValue(undefined), values = {}) => {
  const rendered = renderApp(
    <CustomFieldsCard fields={FIELDS} values={values} canWrite onSave={onSave} />,
  );

  return { ...rendered, onSave };
};

describe('CustomFieldsCard', () => {
  it('sends a number as a number, once, on blur', async () => {
    const { user, onSave } = renderCard(undefined, { number: 3 });

    await user.clear(screen.getByRole('spinbutton', { name: 'Amount' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Amount' }), '12.5');
    expect(onSave).not.toHaveBeenCalled();
    await user.tab();

    expect(onSave).toHaveBeenCalledExactlyOnceWith('number', 12.5);
  });

  it('sends nothing for a blur that changed nothing', async () => {
    const { user, onSave } = renderCard(undefined, { number: 3 });

    await user.click(screen.getByRole('spinbutton', { name: 'Amount' }));
    await user.tab();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a select as soon as it is chosen, and clears it with the empty option', async () => {
    const { user, onSave } = renderCard(undefined, { select: 'UPS' });

    await user.click(screen.getByRole('combobox', { name: 'Carrier' }));
    await user.click(await screen.findByRole('option', { name: 'DHL' }));
    expect(onSave).toHaveBeenLastCalledWith('select', 'DHL');

    await user.click(screen.getByRole('combobox', { name: 'Carrier' }));
    await user.click(await screen.findByRole('option', { name: '—' }));
    expect(onSave).toHaveBeenLastCalledWith('select', null);
  });

  it('saves a multi-select as a list of the options chosen', async () => {
    const { user, onSave } = renderCard();

    await user.click(screen.getByRole('combobox', { name: 'Carriers' }));
    await user.click(await screen.findByRole('option', { name: 'UPS' }));

    expect(onSave).toHaveBeenLastCalledWith('multi_select', ['UPS']);
  });

  it('saves a tick as a boolean', async () => {
    const { user, onSave } = renderCard();

    await user.click(screen.getByRole('checkbox', { name: 'Gift' }));

    expect(onSave).toHaveBeenLastCalledWith('checkbox', true);
  });

  it('shows the refusal for the field’s type and unticks the box again', async () => {
    const { user } = renderCard(vi.fn().mockRejectedValue(new Error('400')));
    const box = screen.getByRole('checkbox', { name: 'Gift' });

    await user.click(box);

    expect(await screen.findByRole('alert')).toHaveTextContent('That value was not saved.');
    await waitFor(() => {
      expect(box).not.toBeChecked();
    });
    expect(box).toHaveAccessibleDescription('That value was not saved.');
  });

  it('says so when the brand has no ticket fields', () => {
    renderApp(<CustomFieldsCard fields={[]} values={{}} canWrite onSave={vi.fn()} />);

    expect(screen.getByText('None')).toBeVisible();
  });

  it('marks a field required to close and describes the control with the marker (M14-17)', () => {
    renderApp(
      <CustomFieldsCard
        fields={[def('number', 'Amount', { requiredToClose: true }), def('select', 'Carrier')]}
        values={{}}
        canWrite
        onSave={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Required to close')).toHaveLength(1);
    expect(screen.getByRole('spinbutton', { name: 'Amount' })).toHaveAccessibleDescription(
      'Required to close',
    );
    expect(screen.getByRole('combobox', { name: 'Carrier' })).not.toHaveAccessibleDescription();
  });
});

describe('CustomFieldsCard, the M14-27 types', () => {
  const NEW_FIELDS = [
    def('long_text', 'Notes'),
    def('link', 'Status page'),
    def('email', 'Billing email'),
    def('person', 'Owner'),
  ];
  // The mock ticketing api's first staff member.
  const LINA = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

  // The person picker reads the signed-in brand's staff, so it needs a session.
  let session: Session;
  beforeAll(async () => {
    const signedIn = await (await signedInMockApis()).auth.me();
    if (!signedIn) throw new Error('Missing session');
    session = signedIn;
  });

  const renderNew = (values: Record<string, unknown> = {}, canWrite = true) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const rendered = renderApp(
      <SessionProvider session={session}>
        <CustomFieldsCard fields={NEW_FIELDS} values={values} canWrite={canWrite} onSave={onSave} />
      </SessionProvider>,
    );

    return { ...rendered, onSave };
  };

  it('saves a long text, a link and an email on blur, trimmed', async () => {
    const { user, onSave } = renderNew();

    await user.type(screen.getByRole('textbox', { name: 'Notes' }), '  first line');
    await user.tab();
    expect(onSave).toHaveBeenLastCalledWith('long_text', 'first line');

    await user.type(screen.getByRole('textbox', { name: 'Status page' }), 'https://a.co/x');
    await user.tab();
    expect(onSave).toHaveBeenLastCalledWith('link', 'https://a.co/x');

    await user.type(screen.getByRole('textbox', { name: 'Billing email' }), 'Ops@B.co');
    await user.tab();
    expect(onSave).toHaveBeenLastCalledWith('email', 'Ops@B.co');
  });

  it('keeps Enter as a line break in a long text', async () => {
    const { user, onSave } = renderNew();

    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'a{Enter}b');

    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('a\nb');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('offers to open a link only once it is an https address, in a new tab that cannot reach back', async () => {
    const { user } = renderNew();
    const box = screen.getByRole('textbox', { name: 'Status page' });

    await user.type(box, 'javascript:alert(1)');
    expect(screen.queryByRole('link')).toBeNull();

    await user.clear(box);
    await user.type(box, 'https://status.example.com/a');
    const open = screen.getByRole('link');
    expect(open).toHaveAttribute('href', 'https://status.example.com/a');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('chooses a person by name and saves the id; "Nobody" clears it', async () => {
    const { user, onSave } = renderNew({ person: LINA });

    await user.click(screen.getByRole('combobox', { name: 'Owner' }));
    await user.click(await screen.findByRole('option', { name: 'Omar Nasser' }));
    expect(onSave).toHaveBeenLastCalledWith('person', '0192c3f0-1a2b-7c3d-8e4f-00000000000b');

    await user.click(screen.getByRole('combobox', { name: 'Owner' }));
    await user.click(await screen.findByRole('option', { name: 'Nobody' }));
    expect(onSave).toHaveBeenLastCalledWith('person', null);
  });

  it('reads a person who is no longer in the brand as a former staff member, once the list is known', async () => {
    renderNew({ person: '0192c3f0-1a2b-7c3d-8e4f-0000000000ff' });

    expect(await screen.findByText('Former staff member')).toBeVisible();
  });

  describe('for a reader who cannot write', () => {
    it('shows a link that opens in a new tab, an email as a left-to-right run, and a person by name', async () => {
      renderNew(
        {
          link: 'https://status.stripe.com/incidents/42',
          email: 'finance@globex.com',
          person: LINA,
          long_text: 'short',
        },
        false,
      );

      const link = screen.getByRole('link', { name: /Status page/ });
      expect(link).toHaveAttribute('href', 'https://status.stripe.com/incidents/42');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText('finance@globex.com').closest('bdi')).toHaveAttribute('dir', 'ltr');
      expect(await screen.findByText('Lina Haddad')).toBeVisible();
      expect(screen.getByText('short')).toBeVisible();
    });

    it('never makes a link of a stored value that is not https', () => {
      renderNew({ link: 'javascript:alert(1)' }, false);

      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('javascript:alert(1)')).toBeVisible();
    });

    it('collapses a long text and expands it with Show all', async () => {
      const text = 'word '.repeat(80);
      const { user } = renderNew({ long_text: text }, false);

      const toggle = screen.getByRole('button', { name: 'Show all' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await user.click(toggle);

      expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    it('says "—" for an empty value', () => {
      renderNew({}, false);

      expect(screen.getAllByText('—')).toHaveLength(4);
    });
  });
});

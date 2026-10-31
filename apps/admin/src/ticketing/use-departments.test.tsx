import { useQueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { departmentsKey, useDepartmentsQuery } from './use-departments.js';

const BRAND = 'brand';

function Names({ label }: { readonly label: string }) {
  const { data } = useDepartmentsQuery(BRAND);
  const shape = data?.departments[0] === undefined ? '' : Object.keys(data.departments[0]).sort();

  return (
    <p data-testid={label}>
      {data?.departments.map((row) => row.name).join(',')}|{String(shape)}
    </p>
  );
}

function Refresh() {
  const queryClient = useQueryClient();

  return (
    <button
      type="button"
      onClick={() => void queryClient.invalidateQueries({ queryKey: departmentsKey(BRAND) })}
    >
      refresh
    </button>
  );
}

describe('useDepartmentsQuery', () => {
  it('gives every observer of the key the same rows and shape, also after a reorder', async () => {
    const { ticketing, staff, auth } = await signedInMockApis();
    const { user } = renderApp(
      <>
        <Names label="a" />
        <Names label="b" />
        <Refresh />
      </>,
      { authApi: auth, staffApi: staff, ticketingApi: ticketing },
    );

    const first = await screen.findByTestId('a');
    await waitFor(() => expect(first.textContent).not.toBe('|'));
    expect(screen.getByTestId('b').textContent).toBe(first.textContent);
    expect(first.textContent).toContain('sortOrder');
    expect(first.textContent).toContain('teamCount');

    const { departments } = await ticketing.departments(BRAND);
    const reversed = departments.map((row) => row.id).reverse();
    await ticketing.reorderDepartments(BRAND, reversed);
    await user.click(screen.getByRole('button', { name: 'refresh' }));

    const expected = [...departments].reverse().map((row) => row.name);
    await waitFor(() =>
      expect(screen.getByTestId('a').textContent).toMatch(new RegExp(`^${expected[0]}`)),
    );
    expect(screen.getByTestId('a').textContent).toContain(expected.join(','));
    expect(screen.getByTestId('b').textContent).toBe(screen.getByTestId('a').textContent);
  });
});

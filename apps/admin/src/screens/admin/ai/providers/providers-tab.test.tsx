import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MockAiApi } from '../../../../ai/mock-api.js';
import { AppRoutes } from '../../../../app/routes.tsx';
import { renderApp } from '../../../../test/render.tsx';
import { signedInMockApis } from '../../../../test/signed-in.js';

/**
 * AI › Providers (`Admin/AI-Providers`) against the fixture: the providers
 * table, the provider form with its SecretField and model discovery, the
 * transcription endpoint pinned by the environment, and the embedding model's
 * re-embed confirmation and 2000-dimension limit.
 */

const renderProviders = async (aiApi = new MockAiApi()) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    aiApi,
    initialEntries: ['/admin/ai'],
  });
  await screen.findByRole('table', { name: 'Providers' });
  return { ...rendered, aiApi };
};

const card = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('AI › Providers', () => {
  it('opens on Providers for an install admin, with every provider and no credential shown', async () => {
    await renderProviders();

    expect(screen.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true');
    const rows = within(screen.getByRole('table', { name: 'Providers' })).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(screen.getByText('http://ollama:11434/v1')).toBeVisible();
    expect(screen.getByText(/1 setting is set by environment/)).toHaveTextContent(
      'HD_TRANSCRIPTION_ENDPOINT comes from .env',
    );
  });

  it('replaces a key through the SecretField and saves the provider', async () => {
    const { user, aiApi } = await renderProviders();
    const save = vi.spyOn(aiApi, 'saveProvider');
    const form = card('OpenAI');

    expect(within(form).getByLabelText('API key')).toHaveAttribute('readonly');
    await user.click(within(form).getByRole('button', { name: 'Replace the API key of OpenAI' }));
    await user.type(within(form).getByLabelText('API key'), 'sk-rotated');
    await user.click(within(form).getByRole('button', { name: 'Save provider' }));

    expect(save).toHaveBeenCalledWith('openai', {
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: null,
      auth: { type: 'apiKey', apiKey: 'sk-rotated' },
    });
    expect(await screen.findByText('Provider saved.')).toBeVisible();
  });

  it('discovers a provider’s models, and says why when the provider refuses', async () => {
    const { user } = await renderProviders();

    await user.click(within(card('OpenAI')).getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByText('4 models found')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Models of OpenAI' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Edit OpenRouter' }));
    await user.click(within(card('OpenRouter')).getByRole('button', { name: 'Discover models' }));
    expect(await within(card('OpenRouter')).findByRole('alert')).toHaveTextContent(
      'The provider could not be asked for its models.',
    );
  });

  it('refuses a new provider without its id, name and key, under each field', async () => {
    const { user } = await renderProviders();

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const form = card('Add provider');
    await user.click(within(form).getByRole('button', { name: 'Save provider' }));

    expect(within(form).getByText('Give the provider a name.')).toBeVisible();
    expect(within(form).getByText('Enter the API key.')).toBeVisible();
    expect(within(form).getByText(/Use 1 to 40 lower-case letters/)).toBeVisible();
  });

  it('shows the transcription endpoint locked by the environment', async () => {
    await renderProviders();
    const transcription = card('Voice transcription');

    expect(within(transcription).getByText('Set by environment')).toBeVisible();
    expect(within(transcription).getByLabelText('Whisper-compatible endpoint')).toHaveAttribute(
      'readonly',
    );
    expect(within(transcription).getByText('HD_TRANSCRIPTION_ENDPOINT')).toBeVisible();
  });

  it('refuses more than 2000 dimensions, and asks before a model change re-embeds', async () => {
    const { user } = await renderProviders();
    const embeddings = card('Embeddings');
    const dims = within(embeddings).getByLabelText('Dimensions');

    fireEvent.change(dims, { target: { value: '3072' } });
    await user.click(within(embeddings).getByRole('button', { name: 'Save' }));
    expect(within(embeddings).getByText(/3072 is above the 2000/)).toBeVisible();
    expect(dims).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(dims, { target: { value: '1536' } });
    fireEvent.change(within(embeddings).getByLabelText('Model'), {
      target: { value: 'text-embedding-3-large' },
    });
    await user.click(within(embeddings).getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Change the embedding model?' });
    expect(within(dialog).getByText(/4812 chunks/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Change and re-embed' }));

    expect(await screen.findByText(/Reindexing to text-embedding-3-large/)).toBeVisible();
    await waitFor(() => {
      expect(
        within(card('Embeddings')).getByRole('progressbar', { name: 'Re-embed progress' }),
      ).toHaveAttribute('aria-valuenow', '0');
    });
  });
});

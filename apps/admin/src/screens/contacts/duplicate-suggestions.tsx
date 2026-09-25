import type { ContactDuplicateSuggestion } from '@helpdock/schemas';
import { Box, Button, Link as MuiLink, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { contactRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { identityLabel } from './format.js';

/**
 * The possible duplicates of one contact (M1-13), as the `Duplicate
 * suggestions` panel of `Admin/Contact dialogs` draws them: the other
 * contact's name as a link, a pill saying **why** it was suggested, the
 * identifier it was suggested on, and the two answers — "Merge…" and "Not the
 * same".
 *
 * The pill is words, never a colour alone (DESIGN §10), and the wording is the
 * reason the api computed rather than one the screen guesses: an unverified
 * email is "email typed in a form" because that is the only way an email ends
 * up unverified on a match (DOMAIN-RULES §4.4).
 */
export function DuplicateSuggestions({
  duplicates,
  disabled,
  onMerge,
  onDismiss,
}: {
  readonly duplicates: readonly ContactDuplicateSuggestion[];
  /** An erased or merged contact is not something to act on. */
  readonly disabled: boolean;
  onMerge(duplicate: ContactDuplicateSuggestion): void;
  onDismiss(duplicate: ContactDuplicateSuggestion): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
      {duplicates.map((duplicate) => (
        <Box
          key={duplicate.id}
          component="li"
          sx={{
            display: 'grid',
            gap: 1,
            paddingBlock: 3,
            borderBlockStart: `1px solid ${tokens['border.default']}`,
          }}
        >
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <MuiLink
              component={Link}
              to={contactRoute(duplicate.other.id)}
              variant="bodyStrong"
              sx={{ flexGrow: 1, minWidth: 0 }}
            >
              {duplicate.other.name}
            </MuiLink>
            <Typography
              variant="caption"
              component="span"
              sx={{
                blockSize: 22,
                paddingInline: 2,
                borderRadius: '6px',
                display: 'inline-flex',
                alignItems: 'center',
                whiteSpace: 'nowrap',
                fontWeight: 500,
                backgroundColor: tokens['status.warning.tint'],
                color: tokens['status.warning.text'],
              }}
            >
              {t(`contacts:duplicates.reason.${duplicate.reason}`)}
            </Typography>
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            <SuggestionLine duplicate={duplicate} />
          </Typography>
          <Box sx={{ display: 'flex', gap: 3, paddingBlockStart: 1 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={disabled}
              aria-label={t('contacts:duplicates.mergeWith', { name: duplicate.other.name })}
              onClick={() => {
                onMerge(duplicate);
              }}
            >
              {t('contacts:duplicates.merge')}
            </Button>
            <Button
              size="small"
              variant="text"
              disabled={disabled}
              aria-label={t('contacts:duplicates.notTheSameWith', { name: duplicate.other.name })}
              onClick={() => {
                onDismiss(duplicate);
              }}
            >
              {t('contacts:identities.notTheSame')}
            </Button>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/**
 * "mona.khalil@acme.de · same account": the identifier the other contact is
 * known by, then what the two share beyond it. The identifier sits in `<bdi>`
 * so an address inside Arabic prose still reads left to right (DESIGN §7).
 */
function SuggestionLine({
  duplicate,
}: {
  readonly duplicate: ContactDuplicateSuggestion;
}): ReactNode {
  const t = useT();
  const identifier = duplicate.other.primaryIdentity;
  const extras = [
    identifier !== null && !identifier.verified ? t('contacts:duplicates.unverified') : null,
    duplicate.sameAccount ? t('contacts:duplicates.sameAccount') : null,
  ].filter((part): part is string => part !== null);

  return (
    <>
      {identifier === null ? null : <bdi>{identityLabel(identifier)}</bdi>}
      {extras.length === 0 ? null : `${identifier === null ? '' : ' · '}${extras.join(', ')}`}
    </>
  );
}

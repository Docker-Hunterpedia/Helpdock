import { CALLOUT_KINDS, type CalloutKind } from '@helpdock/schemas';
import { Box, MenuItem, Select } from '@mui/material';
import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from '@tiptap/react';
import { Lightbulb, TriangleAlert, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * How the editor draws a callout and a video embed (DESIGN §6.3
 * ArticleEditor). What is *stored* is each node's `renderHTML` in
 * `extensions.ts`; these are only the editing surface.
 */

export function CalloutView({ node, updateAttributes, editor }: NodeViewProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const kind = (CALLOUT_KINDS as readonly string[]).includes(String(node.attrs.kind))
    ? (node.attrs.kind as CalloutKind)
    : 'tip';
  const caution = kind === 'caution';
  const Icon = caution ? TriangleAlert : Lightbulb;

  return (
    <NodeViewWrapper
      data-callout={kind}
      style={{
        display: 'flex',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 10,
        backgroundColor: caution ? tokens['status.warning.tint'] : tokens['action.primary.tint'],
        border: `1px solid ${caution ? tokens['status.warning'] : tokens['border.default']}`,
        fontSize: 15,
        lineHeight: '22px',
      }}
    >
      <Box
        component="span"
        contentEditable={false}
        sx={{
          color: caution ? tokens['status.warning.text'] : tokens['action.primary'],
          display: 'inline-flex',
          flexShrink: 0,
          marginBlockStart: '2px',
        }}
      >
        <Icon size={16} aria-hidden="true" />
      </Box>
      <NodeViewContent style={{ flexGrow: 1, minWidth: 0 }} />
      {editor.isEditable ? (
        <Box component="span" contentEditable={false} sx={{ alignSelf: 'flex-start' }}>
          <Select
            size="small"
            value={kind}
            onChange={(event) => {
              updateAttributes({ kind: event.target.value });
            }}
            inputProps={{ 'aria-label': t('helpCenter:editor.callout.style') }}
            SelectDisplayProps={{ 'aria-label': t('helpCenter:editor.callout.style') }}
            sx={{ height: 28, fontSize: 12, backgroundColor: tokens['bg.surface'] }}
          >
            {CALLOUT_KINDS.map((candidate) => (
              <MenuItem key={candidate} value={candidate}>
                {t(`helpCenter:editor.callout.${candidate}`)}
              </MenuItem>
            ))}
          </Select>
        </Box>
      ) : null}
    </NodeViewWrapper>
  );
}

export function VideoView({ node, selected }: NodeViewProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  return (
    <NodeViewWrapper
      data-video={String(node.attrs.src ?? '')}
      style={{
        height: 96,
        borderRadius: 10,
        backgroundColor: tokens['bg.muted'],
        border: `1px solid ${selected ? tokens['border.focus'] : tokens['border.default']}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: tokens['text.secondary'],
        fontSize: 13,
      }}
    >
      <Video size={20} aria-hidden="true" />
      <span>
        {t('helpCenter:editor.video.label')}{' '}
        <bdi style={{ fontFamily: '"IBM Plex Mono", monospace' }}>
          {String(node.attrs.src ?? '')}
        </bdi>
      </span>
    </NodeViewWrapper>
  );
}

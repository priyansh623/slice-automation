import type { StudioAsset } from '@/lib/studio/client';
import { ATTENTION_KINDS } from '@/lib/studio/import-info';

const KIND_TEXT: Record<string, string> = {
  classification_uncertain: 'The pack for this image is a judgement call.',
  setting_discrepancy: 'The imported setting may not match the picture.',
  filename_mismatch: 'The file name does not match what the picture shows.',
  metadata_draft: 'The imported metadata is a draft and needs a human check.',
};
const FLAG_TEXT: Record<string, string> = {
  FACE_NOT_VISIBLE: 'Face not visible', FACE_PARTIAL: 'Face partly hidden', SMALL_SUBJECT: 'Small subject', CROPPED_SUBJECT: 'Subject cut by the frame', HAND_OBJECT_INTERACTION: 'Hands touch an object',
  MULTI_PERSON_BG: 'Other people in the background', REFLECTION: 'Reflection in frame', BRAND_UI: 'Shows a Slice card or app screen', BRAND_TEXT: 'Third-party brand or text', REGIONAL_SIGNAGE: 'Regional signage',
  NIGHT_LOW_LIGHT: 'Low light', LENS_FLARE: 'Lens flare', ALT_DIMENSION: 'Different dimensions', NEAR_DUP_COMPOSITION: 'Similar composition to another image', NEAR_DUP_BG: 'Same backdrop as another image', FILENAME_MISMATCH: 'File name does not match the content',
};
const box = { margin: '12px 0', padding: '9px 11px', border: '1px solid #ECECE8', borderRadius: 10, background: '#FAFAF8' } as const;
const h = { font: '600 12px Satoshi', marginBottom: 4 } as const;
const small = { font: '400 11px/1.5 Satoshi', color: '#75757C' } as const;
const pill = (bg: string, fg: string) => ({ display: 'inline-block', padding: '1px 7px', borderRadius: 999, background: bg, color: fg, font: '500 10px/1.6 Satoshi', marginRight: 5, marginBottom: 3 }) as const;

/**
 * What an import supplied about an image, apart from the scene fields: review items, brand flags, how the subject is framed and the
 * file facts. A brand flag only informs; the image stays visible and selectable. Composition is for character replacement and is not
 * used to search, rank or filter. Nothing about the person in the picture is shown because nothing about the person is stored.
 */
export default function ImportPanel({ asset }: { asset: StudioAsset }) {
  const info = asset.importInfo;
  if (!info) return null;
  const attention = info.review.filter((r) => ATTENTION_KINDS.has(r.kind));
  const draft = info.review.some((r) => r.kind === 'metadata_draft');
  return (
    <div data-testid="import-panel">
      <div style={box}>
        <div style={h}>Imported image {info.importKey ? <span style={{ fontWeight: 400, color: '#75757C' }}>({info.importKey}{info.version && info.version > 1 ? `, version ${info.version}` : ''})</span> : null}</div>
        <div style={small}>Source: {info.source.folder ? `${info.source.folder}/` : ''}{info.source.file ?? 'unknown'}. Fields marked “Imported” came from the inventory; your edits always win, and a re-import never overwrites them.</div>
        {draft && <div style={{ ...small, marginTop: 3 }}>{KIND_TEXT.metadata_draft}</div>}
      </div>
      {attention.length > 0 && (
        <div style={{ ...box, borderColor: '#FDE68A', background: '#FFFBEB' }} role="note" aria-label="Needs review">
          <div style={{ ...h, color: '#92400E' }}>Needs review</div>
          {attention.map((r, i) => <div key={i} style={{ font: '400 12px/1.45 Satoshi', color: '#78350F', marginBottom: 3 }}>{r.note?.startsWith('The pack is a judgement call') ? r.note : `${KIND_TEXT[r.kind] ?? r.kind}${r.note ? ` ${r.note}` : ''}`}</div>)}
        </div>
      )}
      {(info.brand.slice || info.brand.thirdParty || info.flags.length > 0) && (
        <div style={box}>
          <div style={h}>Flags</div>
          <div>{info.flags.map((f) => <span key={f} style={f === 'BRAND_UI' || f === 'BRAND_TEXT' ? pill('#FEE2E2', '#B91C1C') : pill('#F3F4F6', '#4B5563')}>{FLAG_TEXT[f] ?? f}</span>)}</div>
          {info.brand.notes.length > 0 && <div style={small}>In the picture: {info.brand.notes.join('; ')}</div>}
          {(info.brand.slice || info.brand.thirdParty) && <div style={{ ...small, marginTop: 3 }}>Branding is shown for information only. The image stays visible and can be selected for any script.</div>}
        </div>
      )}
      {info.composition.length > 0 && (
        <div style={box}>
          <div style={h}>Composition (for character replacement)</div>
          {info.composition.map((c) => <div key={c.label} style={{ font: '400 12px/1.5 Satoshi' }}><span style={{ color: '#75757C' }}>{c.label}:</span> {c.value}</div>)}
          <div style={{ ...small, marginTop: 3 }}>Not used to search, recommend, rank or hide images.</div>
        </div>
      )}
      {info.technical.length > 0 && (
        <div style={box}>
          <div style={h}>File details</div>
          {info.technical.map((t) => <div key={t.label} style={{ font: '400 12px/1.5 Satoshi' }}><span style={{ color: '#75757C' }}>{t.label}:</span> {t.value}</div>)}
        </div>
      )}
    </div>
  );
}

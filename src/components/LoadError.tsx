'use client';

/** Shown when a screen's data could not be loaded: says so and offers Retry, instead of loading for ever or looking empty. */
export default function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="page-body" style={{ padding: 40 }}>
      <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '48px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <h2 style={{ margin: 0, font: '700 20px/1.3 Satoshi' }}>This page could not be loaded</h2>
        <p style={{ margin: '8px 0 24px', maxWidth: 440, color: '#75757C', font: '400 14px/1.55 Satoshi' }}>{message} Your work is safe.</p>
        <button onClick={onRetry} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    </div>
  );
}

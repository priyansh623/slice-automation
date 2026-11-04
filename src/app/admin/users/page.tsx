'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { UserPlus, Trash2 } from 'lucide-react';

interface AdminUser {
  id: number;
  userId: string;
  email: string;
  addedAt: number;
}

export default function AdminUsersPage() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function loadAdmins() {
    const res = await fetch('/api/v1/admin/users');
    if (!res.ok) { setError('Failed to load admins'); setLoading(false); return; }
    setAdmins(await res.json());
    setLoading(false);
  }

  useEffect(() => { loadAdmins(); }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const email = emailInput.trim();
    if (!email) return;
    setAdding(true);
    setAddError('');
    const res = await fetch('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    if (!res.ok) { setAddError(data.error ?? 'Failed to add admin'); setAdding(false); return; }
    setEmailInput('');
    setAdding(false);
    loadAdmins();
  }

  async function handleRemove(userId: string) {
    setRemovingId(userId);
    const res = await fetch(`/api/v1/admin/users/${userId}`, { method: 'DELETE' });
    setRemovingId(null);
    if (!res.ok) return;
    setAdmins((prev) => prev.filter((a) => a.userId !== userId));
  }

  return (
    <AppShell>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '44px 40px 80px' }}>
          <div style={{ marginBottom: 32 }}>
            <h1 style={{ margin: 0, font: '700 28px/1.1 Satoshi', letterSpacing: '-0.02em' }}>Admin users</h1>
            <p style={{ margin: '8px 0 0', color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
              Manage who has admin access to this app.
            </p>
          </div>

          {/* Add admin form */}
          <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '20px 24px', marginBottom: 24 }}>
            <div style={{ font: '600 14px/1 Satoshi', marginBottom: 14 }}>Add admin by email</div>
            <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10 }}>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="user@example.com"
                required
                style={{
                  flex: 1, height: 38, padding: '0 12px',
                  border: '1px solid #E4E4E0', borderRadius: 9,
                  font: '400 14px/1 Satoshi', outline: 'none',
                  background: '#FAFAF8',
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
              />
              <button
                type="submit"
                disabled={adding}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  height: 38, padding: '0 16px', borderRadius: 9,
                  background: adding ? '#E4E4E0' : '#6C47FF',
                  color: adding ? '#A3A3A9' : '#fff',
                  border: 'none', font: '500 14px/1 Satoshi',
                  cursor: adding ? 'not-allowed' : 'pointer',
                }}
              >
                <UserPlus size={15} />
                {adding ? 'Adding…' : 'Add'}
              </button>
            </form>
            {addError && (
              <div style={{ marginTop: 10, font: '400 13px/1.4 Satoshi', color: '#DC2626' }}>{addError}</div>
            )}
          </div>

          {/* Admin list */}
          {error ? (
            <div style={{ padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B' }}>{error}</div>
          ) : loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#75757C', font: '400 14px/1 Satoshi' }}>Loading…</div>
          ) : admins.length === 0 ? (
            <div style={{ padding: '32px 24px', textAlign: 'center', background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
              No admins yet. Add one above.
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
              {admins.map((a, i) => (
                <div
                  key={a.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px',
                    borderBottom: i < admins.length - 1 ? '1px solid #F3F3F1' : 'none',
                  }}
                >
                  <span style={{
                    width: 32, height: 32, borderRadius: '50%', background: '#F0F0EC', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    font: '700 11px/1 Satoshi', color: '#3A3A3F',
                  }}>
                    {a.email.slice(0, 2).toUpperCase()}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ font: '500 14px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</div>
                    <div style={{ font: '400 12px/1.3 Satoshi', color: '#9A9AA0', marginTop: 2 }}>
                      Added {new Date(a.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(a.userId)}
                    disabled={removingId === a.userId}
                    title="Remove admin"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 32, height: 32, borderRadius: 8,
                      background: 'transparent', border: '1px solid transparent',
                      cursor: removingId === a.userId ? 'not-allowed' : 'pointer',
                      color: '#9A9AA0', flexShrink: 0,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.borderColor = '#FECACA'; e.currentTarget.style.color = '#DC2626'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#9A9AA0'; }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

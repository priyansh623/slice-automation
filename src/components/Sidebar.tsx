'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

function IconGrid({ active }: { active?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={active ? '#111113' : '#75757C'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  );
}

function IconSettings({ active }: { active?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={active ? '#111113' : '#75757C'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

function IconMessageSquare() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#75757C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

export default function Sidebar() {
  const pathname = usePathname();

  const projectsActive = pathname.startsWith('/video-projects');
  const settingsActive = pathname.startsWith('/admin/settings');

  return (
    <aside style={{
      width: 'var(--sidebar-w)',
      minWidth: 'var(--sidebar-w)',
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      position: 'fixed',
      top: 0,
      left: 0,
      bottom: 0,
      zIndex: 40,
    }}>
      {/* Logo */}
      <div style={{
        height: 64,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <Link href="/video-projects" style={{
          font: '700 20px/1 var(--font)',
          letterSpacing: '-0.04em',
          color: 'var(--brand)',
          textDecoration: 'none',
        }}>
          soma
        </Link>
      </div>

      {/* Nav items */}
      <nav style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: 12,
        gap: 4,
        width: '100%',
      }}>
        <Link href="/video-projects" title="Projects" style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
          <span style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 10,
            background: projectsActive ? '#F0F0EC' : 'transparent',
            cursor: 'pointer',
            transition: 'background 0.12s',
          }}>
            <IconGrid active={projectsActive} />
          </span>
        </Link>

        <Link href="/admin/settings" title="Settings" style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
          <span style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 10,
            background: settingsActive ? '#F0F0EC' : 'transparent',
            cursor: 'pointer',
            transition: 'background 0.12s',
          }}>
            <IconSettings active={settingsActive} />
          </span>
        </Link>
      </nav>

      {/* Bottom: feedback + avatar */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        paddingBottom: 16,
        paddingTop: 12,
        borderTop: '1px solid var(--border)',
        width: '100%',
      }}>
        <button
          title="Feedback"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            transition: 'background 0.12s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#F0F0EC')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <IconMessageSquare />
        </button>

        {/* Avatar */}
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'var(--brand)',
          color: 'white',
          fontSize: 12,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          letterSpacing: 0,
        }}>
          S
        </div>
      </div>
    </aside>
  );
}

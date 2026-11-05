'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderOpen, Settings2, MessageSquare, Users, LayoutDashboard } from 'lucide-react';

export default function Sidebar() {
  const pathname = usePathname();

  const projectsActive = pathname.startsWith('/video-projects');
  const settingsActive = pathname.startsWith('/admin/settings');
  const usersActive = pathname.startsWith('/admin/users');
  const dashboardActive = pathname.startsWith('/admin/dashboard');

  const navBg = (active: boolean) => active ? '#F0F0EC' : 'transparent';
  const navFg = (active: boolean) => active ? '#111113' : '#75757C';

  return (
    <nav style={{
      width: 76,
      flexShrink: 0,
      background: '#FFFFFF',
      borderRight: '1px solid #ECECE8',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      position: 'fixed',
      top: 0,
      left: 0,
      bottom: 0,
      zIndex: 40,
      padding: '20px 0 14px',
      gap: 4,
    }}>
      {/* Logo */}
      <div style={{
        font: '700 20px/1 Satoshi',
        letterSpacing: '-0.04em',
        color: '#6C47FF',
        marginBottom: 22,
        textDecoration: 'none',
      }}>
        soma
      </div>

      {/* Projects */}
      <Link href="/video-projects" style={{ textDecoration: 'none' }}>
        <button style={{
          width: 60,
          padding: '9px 0 8px',
          border: 'none',
          borderRadius: 10,
          background: navBg(projectsActive),
          color: navFg(projectsActive),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          font: '500 11px/1 Satoshi',
        }}>
          <FolderOpen size={19} />
          Projects
        </button>
      </Link>

      {/* Settings */}
      <Link href="/admin/settings" style={{ textDecoration: 'none' }}>
        <button style={{
          width: 60,
          padding: '9px 0 8px',
          border: 'none',
          borderRadius: 10,
          background: navBg(settingsActive),
          color: navFg(settingsActive),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          font: '500 11px/1 Satoshi',
        }}>
          <Settings2 size={19} />
          Settings
        </button>
      </Link>

      {/* Dashboard */}
      <Link href="/admin/dashboard" style={{ textDecoration: 'none' }}>
        <button style={{
          width: 60,
          padding: '9px 0 8px',
          border: 'none',
          borderRadius: 10,
          background: navBg(dashboardActive),
          color: navFg(dashboardActive),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          font: '500 11px/1 Satoshi',
        }}>
          <LayoutDashboard size={19} />
          Testers
        </button>
      </Link>

      {/* Admin users */}
      <Link href="/admin/users" style={{ textDecoration: 'none' }}>
        <button style={{
          width: 60,
          padding: '9px 0 8px',
          border: 'none',
          borderRadius: 10,
          background: navBg(usersActive),
          color: navFg(usersActive),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          font: '500 11px/1 Satoshi',
        }}>
          <Users size={19} />
          Admins
        </button>
      </Link>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Feedback */}
      <button style={{
        width: 60,
        padding: '9px 0 8px',
        border: 'none',
        borderRadius: 10,
        background: 'transparent',
        color: '#75757C',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        font: '500 11px/1 Satoshi',
      }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#F6F6F4'; (e.currentTarget as HTMLButtonElement).style.color = '#111113'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#75757C'; }}
      >
        <MessageSquare size={19} />
        Feedback
      </button>

      {/* Avatar + role */}
      <div style={{
        marginTop: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 5,
      }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: '#6C47FF',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: '700 12px/1 Satoshi',
        }}>
          AR
        </div>
        <div style={{ font: '500 10px/1 Satoshi', color: '#9A9AA0' }}>Admin</div>
      </div>
    </nav>
  );
}

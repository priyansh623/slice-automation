'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

function IconFilm({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="3"/>
      <path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>
    </svg>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  );
}

function IconHistory({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
    </svg>
  );
}

function IconSettings({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  matchPrefix?: boolean;
}

export default function Sidebar() {
  const pathname = usePathname();

  function isActive(href: string, matchPrefix = false): boolean {
    if (matchPrefix) return pathname.startsWith(href);
    return pathname === href;
  }

  const videoItems: NavItem[] = [
    {
      label: 'All Projects',
      href: '/video-projects',
      icon: <IconFilm className="nav-icon" />,
      matchPrefix: false,
    },
    {
      label: 'New Project',
      href: '/video-projects/new',
      icon: <IconPlus className="nav-icon" />,
    },
  ];

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <span className="sidebar-wordmark">soma<span>slice</span></span>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        <div className="sidebar-section">
          <span className="sidebar-section-label">Video Projects</span>
        </div>
        {videoItems.map((item) => (
          <Link key={item.href} href={item.href}>
            <span
              className={`sidebar-nav-item${isActive(item.href, item.matchPrefix) ? ' active' : ''}`}
            >
              {item.icon}
              {item.label}
            </span>
          </Link>
        ))}
      </nav>

      {/* Bottom */}
      <div className="sidebar-bottom">
        <div className="sidebar-user">
          <div className="sidebar-avatar" style={{ fontSize: 11, letterSpacing: 0 }}>S</div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">Soma Slice</div>
          </div>
          <Link href="/admin/settings" title="Admin Settings"><IconSettings className="nav-icon" /></Link>
        </div>
      </div>
    </aside>
  );
}

import Sidebar from './Sidebar';

interface Props {
  children: React.ReactNode;
  fullscreen?: boolean;
}

export default function AppShell({ children, fullscreen }: Props) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className={fullscreen ? 'page-content page-content--fullscreen' : 'page-content'}>
        {children}
      </div>
    </div>
  );
}

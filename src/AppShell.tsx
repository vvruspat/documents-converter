import { useEffect, useState, type ReactNode } from 'react';
import {
  Files,
  Building2,
  ChevronLeft,
  ChevronRight,
  File,
  FileSpreadsheet,
  History,
  LogOut,
  Menu,
  Moon,
  Sun,
} from 'lucide-react';
import { ModelSettingsButton } from './ModelSettings';
import s from './shell.module.css';

export type Page = 'convert' | 'history' | 'registry' | 'projects';
export type ShellProps = { page: Page; navigate: (page: Page, search?: string) => void; logout?: () => void; busy: boolean };
export const routes = [
  { page: 'registry', title: 'Реестры документов', icon: Files, path: '/' },
  { page: 'projects', title: 'Строительство', icon: Building2, path: '/projects' },
  { page: 'convert', title: 'Таблицы в Excel', icon: FileSpreadsheet, path: '/convert' },
  { page: 'history', title: 'История', icon: History, path: '/history' },
] as const;
function preference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The preference still works for this page. */
  }
}

export function AppShell({
  page,
  navigate,
  logout,
  busy,
  sidebar,
  breadcrumb,
  action,
  children,
}: ShellProps & {
  sidebar?: ReactNode;
  breadcrumb?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => preference('docs.sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(
    () => preference('docs.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const changeTheme = (value: string) => {
    setTheme(value);
    remember('docs.theme', value);
  };
  function links() {
    return routes.map(({ page: target, path, title, icon: Icon }) => (
      <a
        key={target}
        href={path}
        title={title}
        aria-label={title}
        aria-current={target === page ? 'page' : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setMobileOpen(false);
          navigate(target);
        }}
      >
        <Icon size={17} />
        <span>{title}</span>
      </a>
    ));
  }
  return (
    <div className={s.shell} data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <aside className={s.side}>
        <div className={s.brand}>
          <File size={22} />
          <strong>Документы</strong>
          <button
            className={s.collapse}
            aria-label={collapsed ? 'Развернуть сайдбар' : 'Свернуть сайдбар'}
            aria-expanded={!collapsed}
            onClick={() => {
              setCollapsed(!collapsed);
              remember('docs.sidebar', collapsed ? 'expanded' : 'collapsed');
            }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
          <button
            className={s.mobileMenu}
            aria-expanded={mobileOpen}
            aria-label="Меню разделов"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu size={20} />
          </button>
        </div>
        <div
          className={s.sideBody}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMobileOpen(false);
          }}
        >
          <div
            className={s.navigation}
            onClick={(e) => {
              if ((e.target as Element).closest('[role="tab"],button')) setMobileOpen(false);
            }}
          >
            {sidebar || (
              <nav className={s.routes} aria-label="Навигация">
                {links()}
              </nav>
            )}
          </div>
          <div className={s.bottom}>
            {sidebar && (
              <details className={s.tools}>
                <summary title="Разделы приложения" aria-label="Разделы приложения">
                  <Menu size={16} />
                  <span>Разделы приложения</span>
                </summary>
                <nav className={s.routes} aria-label="Навигация">
                  {links()}
                </nav>
              </details>
            )}
            <div className={s.utilities}>
              <ModelSettingsButton />
              {logout && (
                <button aria-label="Выйти" title="Выйти" disabled={busy} onClick={logout}>
                  <LogOut size={16} />
                </button>
              )}
            </div>
            <div className={s.theme} role="group" aria-label="Тема оформления">
              <button
                title="Светлая тема"
                aria-label="Светлая тема"
                aria-pressed={theme === 'light'}
                onClick={() => changeTheme('light')}
              >
                <Sun size={15} />
              </button>
              <button
                title="Тёмная тема"
                aria-label="Тёмная тема"
                aria-pressed={theme === 'dark'}
                onClick={() => changeTheme('dark')}
              >
                <Moon size={15} />
              </button>
            </div>
          </div>
        </div>
      </aside>
      <div className={s.main}>
        <div className={s.top}>
          <div className={s.trail}>{breadcrumb || routes.find((r) => r.page === page)?.title}</div>
          {action}
        </div>
        <main className={s.content}>{children}</main>
      </div>
    </div>
  );
}

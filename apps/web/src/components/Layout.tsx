import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  Code2,
  LayoutDashboard,
  Settings,
  Shield,
  LogOut,
} from "lucide-react";
import { clsx } from "clsx";

export function Sidebar() {
  const loc = useLocation();
  const { user, logout } = useAuth();
  const nav = useNavigate();

  const items = [
    { to: "/", label: "Workspaces", icon: LayoutDashboard },
    { to: "/settings", label: "Settings", icon: Settings },
  ];
  if (user?.role === "admin") {
    items.push({ to: "/admin", label: "Admin", icon: Shield });
  }

  return (
    <aside className="flex h-full w-60 flex-col border-r border-bg-border bg-bg-panel">
      <div className="flex items-center gap-3 border-b border-bg-border px-4 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-accent text-white">
          <Code2 size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold">PremDev</div>
          <div className="text-[10px] uppercase tracking-wide text-text-muted">
            Cloud IDE
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {items.map((it) => {
          const active = loc.pathname === it.to;
          return (
            <Link
              key={it.to}
              to={it.to}
              className={clsx(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition",
                active
                  ? "bg-bg-hover text-text"
                  : "text-text-muted hover:bg-bg-hover hover:text-text"
              )}
            >
              <it.icon size={16} />
              {it.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-bg-border p-3">
        <div className="mb-2 px-2 text-xs">
          <div className="font-medium text-text">{user?.username}</div>
          <div className="text-text-muted">{user?.email}</div>
        </div>
        <button
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-text-muted hover:bg-bg-hover hover:text-text"
          onClick={async () => {
            await logout();
            nav("/login", { replace: true });
          }}
        >
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}

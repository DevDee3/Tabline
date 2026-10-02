"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ROUTES = [
  { path: "/", label: "Shop" },
  { path: "/tabs", label: "My tabs" },
  { path: "/agent", label: "Agent" },
  { path: "/merchant", label: "Merchant" },
];

export function NavBar() {
  const pathname = usePathname();
  return (
    <header className="bar">
      <Link className="wordmark" href="/" aria-label="Tabline home">
        Tabline
      </Link>
      <nav aria-label="Main">
        {ROUTES.map((r) => (
          <Link key={r.path} href={r.path} aria-current={r.path === pathname ? "page" : undefined}>
            {r.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

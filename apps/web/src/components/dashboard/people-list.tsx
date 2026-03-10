"use client";

import { memo, useMemo, useState } from "react";
import type { PeopleListPerson } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const AVATAR_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
];

function getInitials(name: string): string {
  return name
    .split(/[\s|]+/)
    .filter((p) => p && !/^[(\[|]/.test(p))
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const PeopleList = memo(function PeopleList({
  title,
  people,
  searchable,
  pageSize = 25,
}: {
  title?: string;
  people: PeopleListPerson[];
  searchable?: boolean;
  pageSize?: number;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!search) return people;
    const q = search.toLowerCase();
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.company?.toLowerCase().includes(q) ||
        p.title?.toLowerCase().includes(q),
    );
  }, [people, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const paged = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);

  return (
    <div className="rounded-md border border-border bg-card">
      {(title || searchable) && (
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          {title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
          {searchable && (
            <Input
              type="search"
              placeholder="Search…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="ml-auto h-8 w-48 border-border bg-background px-2.5 text-sm shadow-none focus-visible:ring-1"
            />
          )}
        </div>
      )}
      <ul className="divide-y divide-border">
        {paged.map((person, i) => {
          const bg = AVATAR_COLORS[hashCode(person.name) % AVATAR_COLORS.length];
          return (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              {person.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={person.avatar} alt={person.name} loading="lazy" className="h-8 w-8 rounded-full object-cover" />
              ) : (
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium text-white"
                  style={{ backgroundColor: bg }}
                >
                  {getInitials(person.name)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{person.name}</p>
                {(person.title || person.company) && (
                  <p className="truncate text-xs text-muted-foreground">
                    {[person.title, person.company].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              {person.tags && person.tags.length > 0 && (
                <div className="flex gap-1">
                  {person.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-3xs font-medium text-muted-foreground uppercase">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>{safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, filtered.length)} of {filtered.length}</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="xs" disabled={safePage === 0} onClick={() => setPage((p) => p - 1)} className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-40">Prev</Button>
            <Button type="button" variant="outline" size="xs" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-40">Next</Button>
          </div>
        </div>
      )}
    </div>
  );
});

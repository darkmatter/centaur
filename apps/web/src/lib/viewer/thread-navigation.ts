export type ThreadEntrySource = "threads" | "channel" | "search" | "notification" | "direct";

const ENTRY_SOURCES: ThreadEntrySource[] = [
  "threads",
  "channel",
  "search",
  "notification",
  "direct",
];

export function parseEntrySource(value: string | null): ThreadEntrySource {
  const normalized = (value ?? "").trim().toLowerCase();
  if (ENTRY_SOURCES.includes(normalized as ThreadEntrySource)) {
    return normalized as ThreadEntrySource;
  }
  return "direct";
}

export function entrySourceLabel(source: ThreadEntrySource): string {
  if (source === "threads") return "From Threads";
  if (source === "channel") return "From Channel";
  if (source === "search") return "From Search";
  if (source === "notification") return "From Notification";
  return "Direct link";
}

export function listQueryFromSearchParams(params: URLSearchParams): string {
  const next = new URLSearchParams();
  const q = params.get("q");
  const status = params.get("status");
  if (q) next.set("q", q);
  if (status) next.set("status", status);
  return next.toString();
}

export function parseEntryAnchor(value: string | null): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized || undefined;
}

export function nextListQueryString(
  current: URLSearchParams,
  options: { query: string; status: string },
): string {
  const next = new URLSearchParams(current.toString());
  const query = options.query.trim();
  if (query) {
    next.set("q", query);
  } else {
    next.delete("q");
  }
  if (options.status && options.status !== "all") {
    next.set("status", options.status);
  } else {
    next.delete("status");
  }
  return next.toString();
}

export function listHrefWithAnchor(listQuery?: string, anchor?: string): string {
  const params = new URLSearchParams(listQuery ?? "");
  if (anchor) {
    params.set("entry_anchor", anchor);
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function detailHrefWithEntrySource(
  threadKey: string,
  options?: { source?: ThreadEntrySource; listQuery?: string; anchor?: string },
): string {
  const base = `/${encodeURIComponent(threadKey)}`;
  const params = new URLSearchParams(options?.listQuery ?? "");
  params.set("entry_source", options?.source ?? "threads");
  if (options?.anchor) {
    params.set("entry_anchor", options.anchor);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

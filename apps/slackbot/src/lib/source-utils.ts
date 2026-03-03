"use client";

import { asRecord, asString } from "@/lib/parse-utils";

export type StepSource = {
  url: string;
  title: string;
  snippet?: string;
};

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function sourceFromRecord(value: Record<string, unknown>): StepSource | null {
  const url =
    asString(value.url) ||
    asString(value.href) ||
    asString(value.link) ||
    asString(value.source_url);
  if (!url || !isLikelyUrl(url)) {
    return null;
  }
  const title =
    asString(value.title) ||
    asString(value.name) ||
    asString(value.label) ||
    titleFromUrl(url);
  const snippet =
    asString(value.snippet) ||
    asString(value.description) ||
    asString(value.quote) ||
    undefined;
  return { url, title, snippet };
}

export function dedupeSources(sources: StepSource[]): StepSource[] {
  const deduped = new Map<string, StepSource>();
  for (const source of sources) {
    if (!source.url) continue;
    const existing = deduped.get(source.url);
    if (!existing) {
      deduped.set(source.url, source);
      continue;
    }
    deduped.set(source.url, {
      url: source.url,
      title: existing.title || source.title,
      snippet: existing.snippet || source.snippet,
    });
  }
  return [...deduped.values()];
}

export function extractSourcesFromUnknown(value: unknown): StepSource[] {
  const queue: unknown[] = [value];
  const results: StepSource[] = [];
  let scanned = 0;

  while (queue.length > 0 && scanned < 300) {
    scanned += 1;
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === "string") {
      if (isLikelyUrl(current)) {
        results.push({ url: current, title: titleFromUrl(current) });
      }
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    const record = asRecord(current);
    if (Object.keys(record).length === 0) continue;

    const source = sourceFromRecord(record);
    if (source) {
      results.push(source);
    }

    // Prioritize common source-bearing keys before generic recursion.
    const nestedKeys = [
      "results",
      "sources",
      "citations",
      "references",
      "items",
      "data",
      "content",
      "documents",
    ];
    for (const key of nestedKeys) {
      if (key in record) {
        queue.push(record[key]);
      }
    }

    for (const nested of Object.values(record)) {
      if (typeof nested === "object" && nested !== null) {
        queue.push(nested);
      }
    }
  }

  return dedupeSources(results);
}

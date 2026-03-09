import { useCallback, useSyncExternalStore } from "react";

function subscribe(query: string) {
  return (callback: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  };
}

function getSnapshot(query: string) {
  return () => window.matchMedia(query).matches;
}

const SERVER_SNAPSHOT = false;

export function useMediaQuery(query: string): boolean {
  const subscribeToQuery = useCallback((callback: () => void) => subscribe(query)(callback), [query]);
  const getQuerySnapshot = useCallback(() => getSnapshot(query)(), [query]);

  return useSyncExternalStore(
    subscribeToQuery,
    getQuerySnapshot,
    () => SERVER_SNAPSHOT,
  );
}

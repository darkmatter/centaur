"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { ThreadDetailScreen } from "@/components/thread/thread-detail-screen";

export default function ThreadDetailPage() {
  const params = useParams();
  const rawThreadKey = typeof params.id === "string" ? params.id : "";
  const threadKey = useMemo(() => {
    try {
      return decodeURIComponent(rawThreadKey);
    } catch {
      return rawThreadKey;
    }
  }, [rawThreadKey]);

  return <ThreadDetailScreen threadKey={threadKey} />;
}

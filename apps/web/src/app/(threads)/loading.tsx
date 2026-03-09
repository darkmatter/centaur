export default function ThreadsLoading() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 rounded-md border border-border/80 bg-card/60 animate-shimmer" />
        ))}
      </div>
    </div>
  );
}

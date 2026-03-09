import { ThreadLayout } from "@/components/thread/thread-layout";

const STORAGE_KEY = "threads.sidebar.collapsed.v1";
const COLLAPSE_CLASS = "threads-sidebar-collapsed";

const SIDEBAR_BOOTSTRAP_SCRIPT = `
(() => {
  try {
    var collapsed = window.localStorage.getItem("${STORAGE_KEY}") === "1";
    if (document.body) {
      document.body.classList.toggle("${COLLAPSE_CLASS}", collapsed);
    }
    // Legacy cleanup: previous versions applied this class on <html>.
    document.documentElement.classList.remove("${COLLAPSE_CLASS}");
  } catch (_) {}
})();
`;

export default function ThreadsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOTSTRAP_SCRIPT }} />
      <ThreadLayout>{children}</ThreadLayout>
    </>
  );
}

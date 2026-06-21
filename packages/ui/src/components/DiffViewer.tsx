import { useMemo } from "react";
import { html as diffHtml } from "diff2html";
import DOMPurify from "dompurify";
import { useApp } from "../state";

export function DiffViewer({ diff, stat }: { diff: string; stat?: string }) {
  const { theme } = useApp();
  const rendered = useMemo(() => {
    if (!diff.trim()) return "";
    // The diff (file contents, paths, branch names) is attacker-controlled for a
    // malicious repo. Sanitize diff2html's HTML before injecting it — this page
    // holds the loopback token, so an XSS here would be a full API compromise.
    return DOMPurify.sanitize(
      diffHtml(diff, {
        drawFileList: true,
        matching: "lines",
        outputFormat: "line-by-line",
        colorScheme: (theme === "light" ? "light" : "dark") as never,
      }),
    );
  }, [diff, theme]);

  if (!diff.trim()) {
    return <div className="banner info">No differences between the selected refs.</div>;
  }

  return (
    <div className="diff-wrap">
      {stat && stat.trim() && <pre className="diffstat">{stat.trim()}</pre>}
      <div className="d2h-host" dangerouslySetInnerHTML={{ __html: rendered }} />
    </div>
  );
}

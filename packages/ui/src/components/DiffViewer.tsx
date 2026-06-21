import { useMemo } from "react";
import { html as diffHtml } from "diff2html";
import { useApp } from "../state";

export function DiffViewer({ diff, stat }: { diff: string; stat?: string }) {
  const { theme } = useApp();
  const rendered = useMemo(() => {
    if (!diff.trim()) return "";
    return diffHtml(diff, {
      drawFileList: true,
      matching: "lines",
      outputFormat: "line-by-line",
      colorScheme: (theme === "light" ? "light" : "dark") as never,
    });
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

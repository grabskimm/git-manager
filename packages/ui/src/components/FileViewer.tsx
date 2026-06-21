import { useMemo, useState } from "react";
import hljs from "highlight.js";
import { Markdown } from "./Markdown";
import type { FileContent } from "../types";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  html: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  php: "php",
  swift: "swift",
  kt: "kotlin",
};

function ext(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function CodeView({ content, path, wrap }: { content: string; path: string; wrap: boolean }) {
  const highlighted = useMemo(() => {
    const lang = EXT_LANG[ext(path)];
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(content, { language: lang }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      return content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
    }
  }, [content, path]);

  const lineCount = content.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");

  return (
    <div className={`code-block ${wrap ? "wrap" : ""}`} style={{ display: "flex" }}>
      <pre className="code-gutter" aria-hidden>
        {gutter}
      </pre>
      <pre className="code-pre">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

export function FileViewer({ file }: { file: FileContent }) {
  const isMarkdown = ["md", "markdown", "mdx"].includes(ext(file.path));
  const [rendered, setRendered] = useState(true);
  const [wrap, setWrap] = useState(false);
  const showCode = !file.binary && !file.truncated && !(isMarkdown && rendered);

  return (
    <div className="file-view">
      <div className="file-view-head">
        <span>{file.path}</span>
        <span className="spacer" />
        <span className="faint">{file.size} bytes</span>
        {showCode && (
          <button
            className={`icon-btn ${wrap ? "on" : ""}`}
            onClick={() => setWrap((w) => !w)}
            title="Toggle soft wrap"
          >
            ↩ wrap
          </button>
        )}
        {isMarkdown && (
          <button className="icon-btn" onClick={() => setRendered((r) => !r)} title="Toggle render">
            {rendered ? "{ } source" : "▤ rendered"}
          </button>
        )}
      </div>
      {file.binary ? (
        <div className="banner info" style={{ margin: 14 }}>
          Binary file — not shown.
        </div>
      ) : file.truncated ? (
        <div className="banner info" style={{ margin: 14 }}>
          File is too large to display ({file.size} bytes).
        </div>
      ) : isMarkdown && rendered ? (
        <Markdown source={file.content} />
      ) : (
        <CodeView content={file.content} path={file.path} wrap={wrap} />
      )}
    </div>
  );
}

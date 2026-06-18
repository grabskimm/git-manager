import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js";

marked.setOptions({ gfm: true, breaks: false });

/** Render Markdown to sanitized HTML, with syntax-highlighted code fences. */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const rawHtml = marked.parse(source, { async: false }) as string;
    const clean = DOMPurify.sanitize(rawHtml);
    return clean;
  }, [source]);

  // Highlight any code blocks after render.
  const ref = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  };

  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

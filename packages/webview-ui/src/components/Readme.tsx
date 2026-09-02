import * as React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { request } from "../hostBridge";

marked.setOptions({ gfm: true, breaks: false });

/**
 * Render an npm package readme (Markdown, frequently with embedded HTML) as
 * sanitized HTML. Links are opened in the user's browser through the host rather
 * than navigating the panel; anything that fails to parse falls back to the raw
 * text so the readme is never lost.
 */
export function Readme({ markdown }: { markdown: string }): JSX.Element {
  const html = React.useMemo(() => {
    try {
      const raw = marked.parse(markdown, { async: false }) as string;
      return DOMPurify.sanitize(raw, {
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
        ADD_ATTR: ["target"]
      });
    } catch {
      return "";
    }
  }, [markdown]);

  const onClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) {
      e.preventDefault();
      void request({ kind: "openExternal", url: href });
    }
  }, []);

  if (!html) return <pre>{markdown}</pre>;
  return <div className="readme-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

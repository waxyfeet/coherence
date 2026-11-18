import { PrivateImage } from "./PrivateImage";
import {
  useEffect,
  useId,
  useState,
  isValidElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isLightTheme, useTheme } from "./themes/useTheme";
function MermaidDiagram({ source }: { source: string }) {
  const theme = useTheme();
  const id = useId()
    .replaceAll(":", "")
    .replaceAll("«", "")
    .replaceAll("»", "");
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isLightTheme(theme) ? "default" : "dark",
          fontFamily: "Inter, sans-serif",
        });
        const rendered = await mermaid.render(
          "diagram" + id.replace(/[^a-zA-Z0-9]/g, ""),
          source,
        );
        if (active) setSvg(rendered.svg);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [source, id, theme]);
  if (failed)
    return (
      <pre>
        <code>{source}</code>
      </pre>
    );
  return svg ? (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <p className="muted">Rendering diagram…</p>
  );
}
export function MarkdownDocument({
  content,
  projectId,
  path,
  onFile,
}: {
  content: string;
  projectId: string;
  path: string;
  onFile: (path: string) => void;
}) {
  const resolve = (value: string) =>
    new URL(value, "https://spec.local/" + path).pathname.slice(1);
  function headingText(value: ReactNode): string {
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : Array.isArray(value)
        ? value.map(headingText).join("")
        : isValidElement<{ children?: ReactNode }>(value)
          ? headingText(value.props.children)
          : "";
  }
  function slug(value: ReactNode) {
    return headingText(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
  }
  return (
    <article className="markdown-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          table: ({ children }) => (
            <div className="markdown-table-scroll">
              <table>{children}</table>
            </div>
          ),
          h1: ({ children }) => <h1 id={slug(children)}>{children}</h1>,
          h2: ({ children }) => <h2 id={slug(children)}>{children}</h2>,
          h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
          h4: ({ children }) => <h4 id={slug(children)}>{children}</h4>,
          code({ className, children, ...props }) {
            const source = String(children).replace(/\n$/, "");
            return className === "language-mermaid" ? (
              <MermaidDiagram source={source} />
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          img({ src, alt }) {
            if (
              typeof src !== "string" ||
              /^(?:https?:|data:|blob:|\/)/i.test(src)
            )
              return (
                <span className="muted">[External image blocked: {alt}]</span>
              );
            return (
              <PrivateImage
                src={`/api/projects/${projectId}/files/raw?path=${encodeURIComponent(resolve(src))}`}
                alt={alt ?? "Screenshot evidence"}
                loading="lazy"
              />
            );
          },
          a({ href, children }) {
            if (!href) return <span>{children}</span>;
            if (/^https?:/i.test(href))
              return (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children} ↗
                </a>
              );
            if (href.startsWith("#"))
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    let id = href.slice(1);
                    try {
                      id = decodeURIComponent(id);
                    } catch {}
                    document.getElementById(id)?.scrollIntoView({
                      block: "start",
                      behavior:
                        document.documentElement.dataset.motion === "reduced"
                          ? "instant"
                          : "smooth",
                    });
                  }}
                >
                  {children}
                </a>
              );
            return (
              <button
                className="markdown-file-link"
                onClick={() =>
                  onFile(
                    resolve(href) +
                      new URL(href, "https://spec.local/" + path).hash,
                  )
                }
              >
                {children}
              </button>
            );
          },
        }}
      >
        {content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}
      </ReactMarkdown>
    </article>
  );
}

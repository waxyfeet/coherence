import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { SESSION_CHANGED_EVENT } from "../shared/localAuth";
import { sessionFetch } from "./localSession";

/** Private images use the authenticated channel; blob URLs contain no session credential. */
export function PrivateImage({
  src,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [blob, setBlob] = useState<{ source: string; url: string }>();
  const [session, setSession] = useState(0);
  useEffect(() => {
    const changed = () => setSession((v) => v + 1);
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    if (!src?.startsWith("/api/")) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void sessionFetch(src, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const image = await res.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(image);
        setBlob({ source: src, url: objectUrl });
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, session]);
  return (
    <img
      {...props}
      src={
        src?.startsWith("/api/")
          ? blob?.source === src
            ? blob.url
            : undefined
          : src
      }
    />
  );
}

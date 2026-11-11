import type { ReactNode } from "react";
import { safeHref } from "../../lib/safe-href";

interface ExternalLinkProps {
  /** URL chưa kiểm tra (thường từ dữ liệu server). */
  href: string | null | undefined;
  className?: string;
  title?: string;
  children: ReactNode;
  /** Hiển thị khi URL không an toàn; mặc định là nội dung link dạng chữ thường. */
  fallback?: ReactNode;
}

/** Link ra ngoài: chỉ http/https, mở tab mới, không lộ opener/referrer. */
export function ExternalLink({ href, className, title, children, fallback }: ExternalLinkProps) {
  const safe = safeHref(href);
  if (!safe) return <>{fallback ?? <span className={className}>{children}</span>}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className} title={title}>
      {children}
    </a>
  );
}

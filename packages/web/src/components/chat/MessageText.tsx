import { Fragment, memo } from "react";
import styles from "./chat.module.css";

interface MessageTextProps {
  text: string;
}

/** Văn bản agent: tách đoạn theo dòng trống, `code` hiện font mono. Không render HTML. */
export const MessageText = memo(function MessageText({ text }: MessageTextProps) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== "");
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className={styles.paragraph}>
          {p.split(/(`[^`\n]+`)/).map((part, j) =>
            part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
              <code key={j} className={styles.inlineCode}>
                {part.slice(1, -1)}
              </code>
            ) : (
              <Fragment key={j}>{part}</Fragment>
            ),
          )}
        </p>
      ))}
    </>
  );
});

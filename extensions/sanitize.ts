import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Match Pi's terminal width, preserving combining marks and emoji sequences. */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

export function truncateTitle(text: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || maxWidth < 1) return "";
  let result = "";
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    const nextWidth = displayWidth(segment);
    if (width + nextWidth > Math.floor(maxWidth)) break;
    result += segment;
    width += nextWidth;
  }
  return result.trimEnd();
}

/** Only clean model output; never manufacture a title from a failed request. */
export function sanitizeTitle(raw: string, maxWidth = 40): string {
  let title = stripTerminalSequences(raw)
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (/^```/.test(title)) title = title.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  title = title.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  for (let i = 0; i < 3; i++) {
    title = title
      .replace(/^(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, "")
      .replace(/[。！？!?，,；;：:、.]+$/, "")
      .replace(/^["'“”‘’「」『』《》〈〉`*]+|["'“”‘’「」『』《》〈〉`*]+$/g, "")
      .replace(/^(?:(?:session\s+)?title|标题|会话标题|会话名称)\s*[:：]\s*/i, "")
      .trim();
  }
  if (/^(?:NO_TITLE|null|none)$/i.test(title)) return "";
  title = title.replace(/\s+/g, " ").replace(/[。！？!?，,；;：:、.]+$/, "").trim();
  // Keep useful technical punctuation, e.g. C++, C#, .NET and OAuth/OIDC.
  if (!/[\p{L}\p{N}]/u.test(title)) return "";
  return truncateTitle(title, maxWidth);
}

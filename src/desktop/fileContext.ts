/**
 * Bounded, ephemeral, session-scoped local-file context for Yuzuki
 * Desktop (YUZUKI-DESKTOP-CONTEXT-FILES-P0-IMPLEMENTATION-001). Pure,
 * client-only validation and decoding — no network call, no filesystem
 * write, no persistence of any kind. See
 * docs/product/YUZUKI_DESKTOP_CONTEXT_FILES_P0_IMPLEMENTATION_HANDOFF.md
 * §4-5-7 for the exact rules and numeric limits this module implements.
 *
 * Extension is authoritative (never browser-reported MIME — it is
 * frequently absent or inconsistent across platforms). Validation order
 * is deliberately cheapest-first: extension, then raw byte size (both
 * synchronous, no I/O), then decode, then decoded character count — a
 * file that fails either of the first two checks is never read at all.
 */

export const MAX_RAW_FILE_BYTES = 102_400; // 100 KiB
export const MAX_CONTEXT_TEXT_LENGTH = 8000;
export const MAX_CONTEXT_FILENAME_LENGTH = 200;
export const ALLOWED_EXTENSIONS = [".txt", ".md", ".json", ".csv"] as const;
/** Value for <input type="file accept="...">> — a UX hint only, never authoritative on its own (some OS dialogs let users pick "All files" regardless). */
export const FILE_PICKER_ACCEPT = ALLOWED_EXTENSIONS.join(",");

/** The bounded, admitted source that may accompany a chat request. */
export type AdmittedFileSource = {
  filename: string;
  text: string;
};

/**
 * Client-only file-admission lifecycle. Never a product-truth registry
 * entry (that describes a standing capability; this describes transient
 * per-session UI state) — see the implementation handoff §16.
 */
export type FileSourceState =
  | { kind: "idle" }
  | { kind: "selected" }
  | { kind: "reading" }
  | { kind: "ready"; filename: string; text: string }
  | { kind: "unsupported"; extension: string }
  | { kind: "too_large"; stage: "raw" | "decoded" }
  | { kind: "read_failed"; reason: "invalid_encoding" | "binary_content" };

export const IDLE_FILE_STATE: FileSourceState = { kind: "idle" };

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * True if `text` contains a C0 control character other than tab, line
 * feed, or carriage return — mirrors server/lib/chatValidation.mjs's
 * containsBinaryLikeControlChars() exactly (defense-in-depth is only
 * meaningful if both sides agree on the rule). A file that decodes
 * "successfully" as valid UTF-8 can still contain raw control bytes
 * indicating it isn't really a text document.
 */
function containsBinaryLikeControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isControlChar = code <= 0x1f;
    const isAllowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d; // tab, LF, CR
    if (isControlChar && !isAllowedWhitespace) return true;
  }
  return false;
}

/**
 * A byte-order mark is decoding metadata, not content — strip exactly
 * one leading U+FEFF before any length count or content use.
 */
function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Validates and reads one browser `File` end to end, per the exact
 * precedence in the implementation handoff §4. Never throws — every
 * outcome, success or rejection, is a `FileSourceState` value. Makes no
 * network request.
 */
export async function validateAndReadFile(file: File): Promise<FileSourceState> {
  const extension = getExtension(file.name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return { kind: "unsupported", extension: extension || file.name };
  }

  if (file.size > MAX_RAW_FILE_BYTES) {
    return { kind: "too_large", stage: "raw" };
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { kind: "read_failed", reason: "invalid_encoding" };
  }

  const text = stripBom(raw);

  // The standard UTF-8 decode never throws on invalid byte sequences — it
  // substitutes U+FFFD instead. A genuine text/Markdown/JSON/CSV file
  // authored as UTF-8 should never legitimately contain one; its presence
  // is a cheap, reliable signal of a binary or wrongly-encoded file that
  // slipped past the extension check.
  if (text.includes("�")) {
    return { kind: "read_failed", reason: "invalid_encoding" };
  }
  if (containsBinaryLikeControlChars(text)) {
    return { kind: "read_failed", reason: "binary_content" };
  }
  if (text.length > MAX_CONTEXT_TEXT_LENGTH) {
    return { kind: "too_large", stage: "decoded" };
  }

  // Empty file (0-length text) is a valid, successful admission — never
  // treated as a failure.
  const filename =
    file.name.length > MAX_CONTEXT_FILENAME_LENGTH ? file.name.slice(0, MAX_CONTEXT_FILENAME_LENGTH) : file.name;

  return { kind: "ready", filename, text };
}

/** Short, safe, user-facing copy for every rejection state — never a raw browser exception. */
export function describeFileSourceState(state: FileSourceState): string | null {
  switch (state.kind) {
    case "unsupported":
      return `"${state.extension || "This file type"}" isn't supported. Try .txt, .md, .json, or .csv.`;
    case "too_large":
      return state.stage === "raw"
        ? `This file is larger than ${MAX_RAW_FILE_BYTES / 1024} KB. Try a smaller file.`
        : `This file's text is longer than ${MAX_CONTEXT_TEXT_LENGTH.toLocaleString()} characters once read. Try a shorter file.`;
    case "read_failed":
      return state.reason === "invalid_encoding"
        ? "This file couldn't be read as text — it may not be UTF-8 encoded."
        : "This file appears to contain binary data, not text.";
    default:
      return null;
  }
}

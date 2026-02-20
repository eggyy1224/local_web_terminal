const TMUX_FIELD_SEPARATOR = "\u001f";
const TMUX_ESCAPED_FIELD_SEPARATOR = "\\037";
const TMUX_PANE_ID_PATTERN = /^%\d+$/;
const TMUX_SESSION_WINDOW_PANE_PATTERN = /^[^\s:]+:\d+\.\d+$/;

function isRawTmuxTarget(value: string): boolean {
  const candidate = value.trim();
  return TMUX_PANE_ID_PATTERN.test(candidate) || TMUX_SESSION_WINDOW_PANE_PATTERN.test(candidate);
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstToken(value: string): string {
  if (value.includes(TMUX_FIELD_SEPARATOR)) {
    return (value.split(TMUX_FIELD_SEPARATOR)[0] ?? "").trim();
  }
  if (value.includes(TMUX_ESCAPED_FIELD_SEPARATOR)) {
    return (value.split(TMUX_ESCAPED_FIELD_SEPARATOR)[0] ?? "").trim();
  }
  return value.trim();
}

function invalidTargetError(rawTarget: string, normalized: string, reason: string): Error {
  return new Error(
    `invalid tmux pane target: rawTarget=${JSON.stringify(rawTarget)} normalized=${JSON.stringify(normalized)} reason=${reason}`
  );
}

export function assertRawTmuxTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    throw invalidTargetError(rawTarget, trimmed, "empty_target");
  }
  if (isRawTmuxTarget(trimmed)) {
    return trimmed;
  }
  throw invalidTargetError(rawTarget, trimmed, "not_raw_tmux_target");
}

export function normalizeUpstreamPaneTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    throw invalidTargetError(rawTarget, trimmed, "empty_target");
  }

  const firstRaw = firstToken(trimmed);
  if (isRawTmuxTarget(firstRaw)) {
    return firstRaw;
  }

  const firstRawDecoded = decodeOnce(firstRaw);
  if (isRawTmuxTarget(firstRawDecoded)) {
    return firstRawDecoded;
  }

  const decodedWhole = decodeOnce(trimmed);
  const firstDecodedWhole = firstToken(decodedWhole);
  if (isRawTmuxTarget(firstDecodedWhole)) {
    return firstDecodedWhole;
  }

  const firstDecodedWholeDecoded = decodeOnce(firstDecodedWhole);
  if (isRawTmuxTarget(firstDecodedWholeDecoded)) {
    return firstDecodedWholeDecoded;
  }

  throw invalidTargetError(rawTarget, firstDecodedWholeDecoded, "unable_to_normalize_to_raw_target");
}

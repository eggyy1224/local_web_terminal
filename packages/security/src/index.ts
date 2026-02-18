const SENSITIVE_PATTERNS = [
  /(api[_-]?key\s*[=:]\s*)([^\s]+)/gi,
  /(token\s*[=:]\s*)([^\s]+)/gi,
  /(password\s*[=:]\s*)([^\s]+)/gi,
  /(secret\s*[=:]\s*)([^\s]+)/gi,
  /(-----BEGIN [A-Z ]+-----)([\s\S]*?)(-----END [A-Z ]+-----)/g
];

const DANGEROUS_COMMAND_PATTERN = /(^|\s)(rm|rmdir|unlink)(\s|$)/i;

export function maskSensitive(input: string): string {
  return SENSITIVE_PATTERNS.reduce((acc, pattern) => {
    return acc.replace(pattern, (full, prefix, value, suffix) => {
      if (suffix) {
        return `${prefix}[REDACTED]${suffix}`;
      }

      if (value) {
        return `${prefix}[REDACTED]`;
      }

      return `${full.slice(0, Math.min(full.length, 20))}[REDACTED]`;
    });
  }, input);
}

export function detectRiskFlags(command: string): string[] {
  const flags: string[] = [];
  if (DANGEROUS_COMMAND_PATTERN.test(command)) {
    flags.push("destructive-delete");
  }
  return flags;
}

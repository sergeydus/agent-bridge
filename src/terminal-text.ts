// These expressions intentionally match terminal control characters.
const OSC_SEQUENCE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)',
  'g',
);
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = new RegExp('\\u001B\\[[0-?]*[ -/]*[@-~]', 'g');
// eslint-disable-next-line no-control-regex
const CHARACTER_SET_SEQUENCE = new RegExp('\\u001B[()][0-2A-Z]', 'g');
const CONTROL_CHARACTERS = new RegExp(
  // Preserve only tab and line feed for ordinary terminal text.
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]',
  'g',
);
const BIDIRECTIONAL_CONTROLS = /[\u202A-\u202E\u2066-\u206F]/g;

export function sanitizeTerminalText(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(CHARACTER_SET_SEQUENCE, '')
    .replaceAll('\u001B', '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(BIDIRECTIONAL_CONTROLS, '')
    .replaceAll('\t', '  ');
}

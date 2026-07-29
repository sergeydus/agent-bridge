import { join } from 'node:path';

import { readTextFilePrefix } from './filesystem.ts';

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const MAX_INSTRUCTION_CHARS = 40_000;

export interface InstructionContext {
  files: Array<{ path: string; contents: string }>;
  prompt: string;
}

export async function loadInstructionContext(
  projectRoot: string,
): Promise<InstructionContext> {
  const files: InstructionContext['files'] = [];
  let remaining = MAX_INSTRUCTION_CHARS;
  for (const name of INSTRUCTION_FILES) {
    const path = join(projectRoot, name);
    try {
      const contents = await readTextFilePrefix({
        path,
        maxCharacters: remaining,
      });
      files.push({ path, contents });
      remaining -= contents.length;
      if (remaining <= 0) {
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const prompt =
    files.length === 0
      ? 'No root AGENTS.md or CLAUDE.md instruction file was found.'
      : files
          .map(
            ({ path, contents }) =>
              `Project instructions from ${JSON.stringify(path)}:\n${JSON.stringify(contents)}`,
          )
          .join('\n\n');
  return { files, prompt };
}

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.tsx') || url.endsWith('.ts')) {
    const filePath = fileURLToPath(url);
    const source = await fs.readFile(filePath, 'utf8');
    const stripped = stripTypeScriptTypes(source);
    return {
      format: 'module',
      shortCircuit: true,
      source: stripped,
    };
  }
  return nextLoad(url, context);
}

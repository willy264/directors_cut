import { cp } from 'node:fs/promises';
await cp(new URL('../src/overlay/', import.meta.url), new URL('../dist/overlay/', import.meta.url), { recursive: true });

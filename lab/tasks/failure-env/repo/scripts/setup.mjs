// Provisions the check's one dependency, which a fresh checkout does not have.
import { cpSync } from 'node:fs';

cpSync(new URL('../vendor/fmt', import.meta.url), new URL('../node_modules/fmt', import.meta.url), { recursive: true });

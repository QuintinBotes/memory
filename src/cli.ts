import { pluginVersion } from './version.ts';

const USAGE = `usage: memory <command>

  --version   print the version`;

const [command] = process.argv.slice(2);
if (command === '--version') {
  console.log(pluginVersion());
} else {
  console.error(USAGE);
  process.exitCode = command === undefined || command === '--help' ? 0 : 2;
}

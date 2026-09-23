// Fake acceptance command for acceptance-runner tests.
// Behavior driven by flags so one fixture covers every scenario:
//   --exit N     exit with status N (default 0)
//   --sleep N    run for N seconds before exiting (default 0)
//   --spew N     print N dots to stdout and N x's to stderr
//   --mark F     write the given filename into the cwd, then read it back and
//                print the names of any sibling marker files found there
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const parse = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const exitCode = Number(parse('--exit') ?? 0);
const sleepSeconds = Number(parse('--sleep') ?? 0);
const spewCount = Number(parse('--spew') ?? 0);
const mark = parse('--mark');

if (spewCount > 0) {
  process.stdout.write('.'.repeat(spewCount));
  process.stderr.write('x'.repeat(spewCount));
}
if (mark) {
  writeFileSync(join(process.cwd(), mark), '');
  const markers = readdirSync(process.cwd()).filter((f) => f.endsWith('.txt'));
  process.stdout.write(markers.join(','));
}
if (sleepSeconds > 0) {
  const deadline = Date.now() + sleepSeconds * 1000;
  while (Date.now() < deadline) {
    // burn CPU — no timers to keep the process alive unexpectedly
  }
}
if (exitCode === 0 && !mark && !existsSync(join(process.cwd(), '__acceptance_fake_unused__'))) {
  process.stdout.write('passed');
}
process.exit(exitCode);

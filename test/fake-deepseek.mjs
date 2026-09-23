// Tiny protocol fixture for the orchestrator's DeepSeek adapter.  It behaves
// like the rc8 headless command from the adapter's point of view: plain final
// text on stdout, an optional `dsh: <CODE>: <message>` stderr diagnostic, and
// an exit code selected by the test environment.
if (process.env.FAKE_DSH_TURN_ZERO === '1') {
  // Zero-turn failure mode: empty stdout + a harness `dsh:` diagnostic on
  // stderr + a non-zero exit — the case the adapter surfaces as a structured
  // result error event carrying only the sanitized dsh code.
  process.stderr.write('dsh: TURN_ZERO: no turn completed in the run interval\n');
  process.exit(1);
}
if (process.env.FAKE_DSH_RECORD_PATCH === '1') {
  // Bridge opt-in contract mode: mirrors what a real Harness run receives
  // without starting any real harness.  The exact --patch argument (if any)
  // is echoed on stdout so the orchestrator tests can assert it.
  const i = process.argv.indexOf('--patch');
  const patchArg = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
  process.stdout.write(`patch=${JSON.stringify(patchArg)}\n`);
  process.exit(0);
}
const text = process.env.FAKE_DSH_RESULT || 'DSH_DONE';
process.stdout.write(`${text}\n`);
process.exit(Number(process.env.FAKE_DSH_EXIT_CODE || '0'));


const fs = require('node:fs');
const path = require('node:path');
const tool = process.argv[2];
const args = process.argv.slice(3);
if (args.includes('--version')) { console.log(`${tool} test/1`); process.exit(0); }
const behavior = JSON.parse(process.env.CREW_TEST_BEHAVIOR || '{}');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), `${tool}-input.json`), JSON.stringify({ input, args,
    registeredCore: process.env.CODEX_WINDOWS_REGISTERED_CORE ?? null,
    sandboxPackage: process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY ?? null,
  }), 'utf8');
  if (behavior.stderr) process.stderr.write(behavior.stderr);
  if (behavior.empty) { process.exitCode = behavior.exitCode || 0; return; }
  if (behavior.invalid) { console.log('invalid json'); return; }
  const text = behavior.text ?? 'CREW_OK 中文正常';
  if (tool === 'claude') console.log(JSON.stringify({ result: text, is_error: behavior.toolError ?? false }));
  if (tool === 'codex') {
    console.log('process log: this is not the final answer');
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], text, 'utf8');
  }
  if (tool === 'agy') {
    console.log(JSON.stringify({ event: 'step_update', step_update: { text_delta: 'thinking' } }));
    console.log(JSON.stringify({ event: 'result', result: { status: behavior.toolError ? 'ERROR' : 'SUCCESS', response: text,
      error: behavior.toolError ? text : undefined } }));
  }
  process.exitCode = behavior.exitCode ?? 0;
});

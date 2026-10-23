import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const testTmpdir = mkdtempSync(join(tmpdir(), 'ultimate-test-temp-'))
const agentDir = mkdtempSync(join(testTmpdir, 'ultimate-test-pi-'))
process.env.PI_CODING_AGENT_DIR = agentDir
// Every boot would otherwise run the machine's real `claude auth status` (about 170 ms of CPU each); tests that need
// a Claude CLI stub their own.
process.env.PI_CLAUDE_CODE_COMMAND = join(testTmpdir, 'no-claude')
// Provider credentials from the environment would make a configured model available, and the default summary model
// would fall back to it over the scripted faux one (HF_TOKEN and COPILOT_GITHUB_TOKEN name Pi's env auth, as do the
// AWS and Google ambient credentials): tests see only the logins they create.
const machineCredential =
  /(?:^|_)(?:API_KEY|TOKEN)$|^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|PROFILE|BEARER_TOKEN_BEDROCK|WEB_IDENTITY_TOKEN_FILE|CONTAINER_CREDENTIALS_(?:FULL_URI|RELATIVE_URI))$|^GOOGLE_APPLICATION_CREDENTIALS$/
for (const key of Object.keys(process.env)) if (machineCredential.test(key)) delete process.env[key]
// Test servers, and the previews they start, must never publish on this machine's tailnet: they find no Tailscale CLI.
process.env.TAILSCALE_COMMAND = join(testTmpdir, 'no-tailscale')
// Instance startup sweeps must never inspect the machine's real preview homes during tests.
const previousTmpdir = process.env.TMPDIR
process.env.TMPDIR = testTmpdir

afterAll(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir
  rmSync(testTmpdir, { recursive: true, force: true })
})

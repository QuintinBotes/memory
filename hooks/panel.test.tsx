import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// #104: the review pane and the band, with the memory CLI stood in for by process.run.
const ESC = String.fromCharCode(27)
const proposal = (id: string, statement = 'Releases are cut from main') => ({
  id, status: 'proposed', type: 'convention', scope: 'repository', scope_key: 'acme/api', statement, shadow: 'hold',
  evidence: [{ source_ref: 'session-1', author_role: 'agent', agent: 'codex', taint: null }],
})
// The person typing /memory-review at the prompt.
const OPEN = { command: 'memory-review', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const BAND = { plugin: 'memory', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = { plugin: 'memory', component: 'Pane', requestId: 'memory-review', props: { title: 'Memory review', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

/** A CLI whose store holds `waiting`; approve and reject take the proposal out, and every call is kept. */
function cli(on: On, waiting: object[]) {
  const calls: string[][] = []
  let list = [...waiting] as { id: string }[]
  on('command.register', () => ({ value: { command: 'memory-review' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(2)
    calls.push(args)
    if (args[0] === 'review') return { value: { exitCode: 0, stdout: JSON.stringify({ proposals: list, edits: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    list = list.filter(p => p.id !== args[1])
    return { value: { exitCode: 0, stdout: `${args[0] === 'approve' ? 'approved' : 'rejected'} ${args[1]}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return calls
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`#104 SC2 the band counts what waits, and Approve in the pane makes it active and clears the band (${surface})`, async ($, on) => {
    const calls = cli(on, [proposal('m-aaaa'), proposal('m-bbbb')])
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run(OPEN)
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /waiting/ }))?.text).toContain('2 proposals waiting')
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /Releases/ }))?.text).toBe('Releases are cut from main')
    expect((await pane.find({ type: 'Text', text: /evidence/ }))?.text).toContain('session-1 (agent) via codex')
    await pane.press({ key: 'approve-m-aaaa' })
    await pane.press({ key: 'approve-m-bbbb' })
    await pane.unmount()
    expect(calls.filter(c => c[0] !== 'review')).toEqual([['approve', 'm-aaaa'], ['approve', 'm-bbbb']])

    const after = await $.ui.mount({ ...BAND, surface })
    expect(await after.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
    await after.unmount()
  })
}

test('#142 the band counts items expiring soon apart from proposals, and shows with no proposal waiting', async ($, on) => {
  on('command.register', () => ({ value: { command: 'memory-review' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const soon = { id: 'm-cccc', scope: 'person', scope_key: '', type: 'preference', statement: 'Explain changes in plain English', days_left: 10 }
  let waiting = [proposal('m-aaaa')]
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ proposals: waiting, edits: [], expiring: [soon] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(OPEN)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /expiring/ }))?.text).toContain('1 proposal waiting · 1 expiring soon')
  await band.unmount()
  waiting = []
  await $.command.run(OPEN)
  const alone = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await alone.find({ type: 'Text', text: /expiring/ }))?.text).toContain('memory · 1 expiring soon')
  await alone.unmount()
})

test('#104 SC3 Reject in the pane runs memory reject on that proposal only', async ($, on) => {
  const calls = cli(on, [proposal('m-aaaa'), proposal('m-bbbb')])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(OPEN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'reject-m-bbbb' })
  await pane.unmount()
  expect(calls.filter(c => c[0] !== 'review')).toEqual([['reject', 'm-bbbb']])
})

test('#104 a statement with control characters is drawn without them', async ($, on) => {
  cli(on, [proposal('m-aaaa', `Run it${ESC}[2J now`)])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(OPEN)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await pane.find({ type: 'Text', text: /Run it/ })
  expect(row?.text.includes(ESC)).toBe(false)
  await pane.unmount()
})

test('#104 with nothing waiting there is no band, and a failing CLI says so in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'memory-review' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'memory is not set up\n', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(OPEN)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /failed/ }))?.text).toContain('memory is not set up')
  await pane.unmount()
})

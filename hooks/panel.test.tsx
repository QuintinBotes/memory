import { expect, test } from 'claude-code/testing'

// #104: the review pane and the band, with the memory CLI stood in for by process.run.
const ESC = String.fromCharCode(27)
const proposal = (id: string, statement = 'Releases are cut from main') => ({
  id, status: 'proposed', type: 'convention', scope: 'repository', scope_key: 'acme/api', statement, shadow: 'hold',
  evidence: [{ source_ref: 'session-1', author_role: 'agent', agent: 'codex', taint: null }],
})
const BAND = { plugin: 'memory', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80 } } as const
const PANE = { plugin: 'memory', component: 'Pane', requestId: 'memory-review', props: { title: 'Memory review', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

/** A CLI whose store holds `waiting`; approve and reject take the proposal out, and every call is kept. */
function cli(on: Parameters<Parameters<typeof test>[1]>[1], waiting: object[]) {
  const calls: string[][] = []
  let list = [...waiting] as { id: string }[]
  on('command.register', () => ({ value: { command: 'memory-review' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(2)
    calls.push(args)
    if (args[0] === 'review') return { value: { exitCode: 0, stdout: JSON.stringify({ proposals: list, edits: [] }), stderr: '' } }
    list = list.filter(p => p.id !== args[1])
    return { value: { exitCode: 0, stdout: `${args[0] === 'approve' ? 'approved' : 'rejected'} ${args[1]}\n`, stderr: '' } }
  })
  return calls
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`#104 SC2 the band counts what waits, and Approve in the pane makes it active and clears the band (${surface})`, async ($, on) => {
    const calls = cli(on, [proposal('m-aaaa'), proposal('m-bbbb')])
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'memory-review' })
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

test('#104 SC3 Reject in the pane runs memory reject on that proposal only', async ($, on) => {
  const calls = cli(on, [proposal('m-aaaa'), proposal('m-bbbb')])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'memory-review' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'reject-m-bbbb' })
  await pane.unmount()
  expect(calls.filter(c => c[0] !== 'review')).toEqual([['reject', 'm-bbbb']])
})

test('#104 a statement with control characters is drawn without them', async ($, on) => {
  cli(on, [proposal('m-aaaa', `Run it${ESC}[2J now`)])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'memory-review' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await pane.find({ type: 'Text', text: /Run it/ })
  expect(row?.text.includes(ESC)).toBe(false)
  await pane.unmount()
})

test('#104 with nothing waiting there is no band, and a failing CLI says so in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'memory-review' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'memory is not set up\n' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'memory-review' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /failed/ }))?.text).toContain('memory is not set up')
  await pane.unmount()
})

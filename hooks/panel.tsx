import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MemoryProposal } from '../types'

// #104: /memory-review opens a review pane, and a band says when proposals wait. Every read and decision runs the bundled
// CLI, so the CLI's checks hold; the mod registers no tool, so only a person's press decides.
const PANE = 'memory-review'
const proposals = atom({ plugin: 'memory', key: 'proposals' } as const, [], { shape: 'proposals-1' })
const problem = atom({ plugin: 'memory', key: 'problem' } as const, '')
const busy = atom({ plugin: 'memory', key: 'busy' } as const, '')
// #142: how many items expire soon; renewing and pinning are terminal commands, so the pane only counts them.
const expiring = atom({ plugin: 'memory', key: 'expiring' } as const, 0)

// Statements come from agents: no control or bidi characters reach the terminal, and none runs long.
const clean = (s: unknown, max = 400): string => {
  const flat = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

type Raw = { id?: unknown; type?: unknown; scope?: unknown; scope_key?: unknown; statement?: unknown; shadow?: unknown; evidence?: { source_ref?: unknown; author_role?: unknown; agent?: unknown }[] }

export function parse(stdout: string): MemoryProposal[] {
  const list = (JSON.parse(stdout) as { proposals?: Raw[] }).proposals ?? []
  return list.map(p => ({
    id: clean(p.id, 40),
    type: clean(p.type, 40),
    where: clean(p.scope_key === '' || p.scope_key == null ? p.scope : `${p.scope} ${p.scope_key}`, 120),
    statement: clean(p.statement),
    evidence: (p.evidence ?? []).slice(0, 3).map(e => clean(`${e.source_ref} (${e.author_role})${e.agent == null ? '' : ` via ${e.agent}`}`, 160)),
    shadow: clean(p.shadow, 20),
  }))
}

const memory = ($: EngineInterface, ...args: string[]) =>
  $.process.run(['node', `${$.plugin.root}/dist/memory.mjs`, ...args], { timeoutMs: 15_000 })

async function refresh($: EngineInterface): Promise<void> {
  try {
    const r = await memory($, 'review', '--json')
    if (r.exitCode !== 0) throw new Error(clean(r.stderr, 200) || `memory review exited ${r.exitCode}`)
    const list = parse(r.stdout)
    const soon = ((JSON.parse(r.stdout) as { expiring?: unknown[] }).expiring ?? []).length
    await update($, proposals, () => list)
    await update($, expiring, () => soon)
    await update($, problem, () => '')
  } catch (error) {
    await update($, proposals, () => [])
    await update($, expiring, () => 0)
    await update($, problem, () => clean((error as Error).message, 200))
  }
}

async function decide($: EngineInterface, id: string, decision: 'approve' | 'reject'): Promise<void> {
  if ((await read($, busy)) !== '') return
  await update($, busy, () => id)
  try {
    const r = await memory($, decision, id)
    $.ui.toast(clean(r.exitCode === 0 ? r.stdout.split('\n')[0] || `${decision}d ${id}` : r.stderr, 200))
  } finally {
    await update($, busy, () => '')
    await refresh($)
  }
}

const count = (n: number) => `${n} proposal${n === 1 ? '' : 's'}`
const soonText = (n: number) => `${n} expiring soon`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'memory-review', description: "Review memory's proposals in a pane" })
    void refresh($)
    return next(e)
  })

  // Capture runs detached at Stop, so its proposals show from the next turn's end.
  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'memory-review' }, async $ => {
    try {
      await refresh($)
      const opened = await $.ui.open({ id: PANE, title: 'Memory review' })
      if (opened.isPlaced) return { text: 'Memory review opened.' }
      // No pane here (a narrow terminal, a surface without panes): the CLI's own listing instead.
      const r = await memory($, 'review')
      return { text: `${r.stdout}${r.stderr}`.trim() || 'No proposals to review here.' }
    } catch (error) {
      return { text: `memory review failed: ${clean((error as Error).message, 200)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, proposals)
    const why = await read($, problem)
    const running = await read($, busy)
    const soon = await read($, expiring)
    return (
      <Box flexDirection="column">
        {why !== '' && <Text color="red">memory review failed: {why}</Text>}
        {why === '' && list.length === 0 && <Text dimColor>No proposals to review here.</Text>}
        {list.length > 0 && <Text dimColor>{count(list.length)} waiting. Approve makes one active; reject keeps it as a tombstone.</Text>}
        {soon > 0 && <Text dimColor>{soonText(soon)}: memory review lists them; renew or pin one with memory renew or memory pin in a terminal.</Text>}
        {list.map(p => (
          <Box key={p.id} flexDirection="column" marginTop={1}>
            <Text dimColor>[{p.id}] {p.type} · {p.where} · shadow gate: {p.shadow}</Text>
            <Text>{p.statement}</Text>
            {p.evidence.map(line => <Text dimColor>  evidence: {line}</Text>)}
            <Box>
              <Button key={`approve-${p.id}`} label={running === p.id ? 'Working…' : 'Approve'} onPress={() => decide($, p.id, 'approve')} />
              <Text> </Text>
              <Button key={`reject-${p.id}`} label="Reject" onPress={() => decide($, p.id, 'reject')} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, proposals)
    const soon = await read($, expiring)
    if (e.props.hasSurvey || (list.length === 0 && soon === 0)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = [...(list.length > 0 ? [`${count(list.length)} waiting`] : []), ...(soon > 0 ? [soonText(soon)] : [])]
    return (
      <Box>
        <Text dimColor>memory · {parts.join(' · ')} · </Text>
        <Button key="review" label="Review" onPress={() => void $.ui.open({ id: PANE, title: 'Memory review' })} />
      </Box>
    )
  })
}

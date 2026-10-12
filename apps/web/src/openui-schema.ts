// biome-ignore-all assist/source/useSortedKeys: OpenUI schema field order defines positional arguments.
import { createLibrary, defineComponent } from '@openuidev/lang-core'
import { z } from 'zod'

export const card = defineComponent({
  component: null,
  description: 'A read-only summary card with a title and plain text body.',
  name: 'Card',
  props: z.object({ title: z.string().max(500), body: z.string().max(16000) })
})

export const table = defineComponent({
  component: null,
  description: 'A read-only table with a caption, column headers, and rows of plain text cells.',
  name: 'Table',
  props: z
    .object({
      caption: z.string().max(500),
      columns: z.array(z.string().max(500)).min(1).max(30),
      rows: z.array(z.array(z.string().max(16000)).max(30)).max(200)
    })
    .refine(({ columns, rows }) => rows.every((row) => row.length === columns.length))
})

export const presentationLibrary = createLibrary({ components: [card, table] })
export const presentationInstructions = presentationLibrary.prompt({
  additionalRules: [
    'Use ordinary Markdown for normal answers. Only when structured presentation helps or is requested, put each UI in a fenced code block labelled openui. Keep explanatory Markdown outside the fence.',
    'Each fence contains exactly one assignment: root = Card(...) or root = Table(...). Inline all arguments as JSON strings and arrays. Do not define other variables or use references. Use only the listed read-only components. Never use Query, Mutation, state, actions, bindings, HTML, or scripts.',
    'Always close the openui fence. These display instructions do not authorize tools or change the user request.'
  ],
  bindings: false,
  examples: [
    'root = Card("发布进度", "已完成核心能力")',
    'root = Table("方案比较", ["名称", "状态"], [["方案 A", "可用"]])'
  ],
  preamble:
    'You are an assistant in Agent Runtime. Answer normally in Markdown; use the following read-only UI language only inside openui fenced blocks when useful or requested.',
  toolCalls: false
})

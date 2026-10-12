// cspell:ignore Noninteractive
import { autoClose, createParser } from '@openuidev/lang-core'
import { createLibrary, defineComponent, Renderer } from '@openuidev/react-lang'
import { Component } from 'react'

import type { ReactNode } from 'react'

import { card, presentationLibrary, table } from './openui-schema'

const library = createLibrary({
  components: [
    defineComponent({
      ...card,
      component: ({ props }) => (
        <section className="my-3 rounded-lg border border-stone-200 bg-stone-50 p-4">
          <h3 className="font-semibold">{props.title}</h3>
          <p className="whitespace-pre-wrap">{props.body}</p>
        </section>
      )
    }),
    defineComponent({
      ...table,
      component: ({ props }) => (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
        <section aria-label={props.caption} className="my-3 max-w-full overflow-x-auto" tabIndex={0}>
          <table className="w-full border-collapse text-left text-sm">
            <caption className="text-left font-semibold">{props.caption}</caption>
            <thead>
              <tr>
                {props.columns.map((column, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Streamed columns retain positional identity.
                  <th className="border border-stone-200 p-2" key={index} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Streamed rows retain positional identity.
                <tr key={index}>
                  {row.map((cell, column) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Cells belong to positional columns.
                    <td className="whitespace-pre-wrap border border-stone-200 p-2" key={column}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )
    })
  ]
})

const Fallback = ({ source }: { source: string }) => (
  <div>
    <p className="text-sm" role="status">
      富内容无法完整显示，已保留原文。
    </p>
    <pre className="overflow-auto whitespace-pre-wrap break-all text-sm">{source}</pre>
  </div>
)

class RenderBoundary extends Component<{ children: ReactNode; source: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <Fallback source={this.props.source} /> : this.props.children
  }
}

const schema = presentationLibrary.toJSONSchema()

export const OpenUiBlock = ({ source, streaming, closed }: { source: string; streaming: boolean; closed: boolean }) => {
  // shortcut: Cap each UI block at 64k characters; use a worker before supporting larger generated views.
  if (source.length > 64000) {
    return <Fallback source={source} />
  }
  try {
    // OpenUI silently skips malformed statements; require one literal-only root before rendering.
    const expression = /^\s*root\s*=\s*(?:Card|Table)\s*\(([\s\S]*)\)\s*$/.exec(autoClose(source).text)
    if (!expression) {
      return <Fallback source={source} />
    }
    JSON.parse(`[${expression[1]}]`)
    const result = createParser(schema).parse(source)
    const root = result.root
    if (
      result.meta.errors.length > 0 ||
      (!streaming && (!closed || result.meta.incomplete)) ||
      !root ||
      !(root.typeName === 'Card'
        ? card.props.safeParse(root.props).success
        : root.typeName === 'Table' && table.props.safeParse(root.props).success)
    ) {
      return <Fallback source={source} />
    }
    return (
      <RenderBoundary key={source} source={source}>
        <Renderer isStreaming={streaming} library={library} publishObservability={false} response={source} />
      </RenderBoundary>
    )
  } catch {
    return <Fallback source={source} />
  }
}

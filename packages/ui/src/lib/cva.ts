import { cn as merge } from 'cn'
import { defineConfig } from 'cva/config'

export const { cva } = defineConfig({ cx: merge })
export type * from 'cva'

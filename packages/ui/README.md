# @qingshaner/ui

Shared React components and Tailwind styles for Agent Runtime. Consumers compile
this source package with their existing React and Tailwind build.

```tsx
import { Button } from '@qingshaner/ui/components/button'
import '@qingshaner/ui/styles.css'
```

The stylesheet registers the package components as Tailwind sources. React and
React DOM are peer dependencies supplied by the application.

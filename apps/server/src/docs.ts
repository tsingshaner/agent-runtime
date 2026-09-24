export const apiReference = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Runtime API</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      import { createApiReference } from 'https://cdn.jsdelivr.net/npm/@scalar/api-reference/esm.js'

      createApiReference('#app', {
        url: '/spec.json',
        persistAuth: false,
        showOperationId: true,
        theme: 'alternate'
      })
    </script>
  </body>
</html>`

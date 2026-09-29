import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => <Outlet />,
  errorComponent: () => (
    <main className="p-8" role="alert">
      <h1>暂时无法打开页面</h1>
      <a className="text-button" href="/login">
        返回登录
      </a>
    </main>
  ),
  notFoundComponent: () => (
    <main className="p-8">
      <h1>页面不存在</h1>
      <Link className="text-button" to="/workspace">
        返回工作台
      </Link>
    </main>
  )
})

/**
 * 这是一个示例包，用于演示如何使用 TSDoc 注释来描述包的信息。
 *
 * @remarks
 * 这个包包含一些基本的数学运算函数。
 *
 * @example
 * 下面是如何使用这个包的示例：
 *
 * ```typescript
 * import { add } from 'my-package';
 *
 * const result = add(2, 3);
 * console.log(result); // 输出: 5
 * ```
 *
 * @packageDocumentation
 */
export { add } from './core'

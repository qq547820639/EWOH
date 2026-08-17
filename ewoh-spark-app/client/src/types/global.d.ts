declare module '*.css';

// Type declarations for importing static assets
declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare module '*.webp' {
  const value: string;
  export default value;
}

declare module '*.ico' {
  const value: string;
  export default value;
}

// CLI-612：`*.json` 的 any 模块声明已删除——tsconfig.app.json 已启用
// resolveJsonModule，JSON 导入由编译器推断真实字面量类型，不再退化为 any。

declare module '*.md' {
  const value: string;
  export default value;
}

declare module '*.csv' {
  const value: string;
  export default value;
}

declare namespace React {
  export interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}

// Network Information API (`navigator.connection`) — optional, not part of the
// standard lib.dom types. Declared globally so workbench code can read it in a
// type-safe way instead of casting to `any`.
interface NetworkInformation {
  readonly effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
}

interface Navigator {
  readonly connection?: NetworkInformation;
}

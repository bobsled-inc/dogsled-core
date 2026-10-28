declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export interface ReactTestRenderer {
    unmount(): void;
  }

  interface TestRendererModule {
    create(element: ReactElement): ReactTestRenderer;
  }

  const TestRenderer: TestRendererModule;
  export default TestRenderer;
}

// Vite inline worker imports (bundled into the page as a string; see src/workers/pool.ts).
declare module '*?worker&inline' {
  const WorkerFactory: new (options?: { name?: string }) => Worker;
  export default WorkerFactory;
}

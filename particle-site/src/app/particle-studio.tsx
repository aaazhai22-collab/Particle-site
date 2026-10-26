'use client';

import dynamic from 'next/dynamic';

// The editor reads localStorage during initialization and owns a WebGL canvas.
// Keep that entire module out of server rendering and build-time evaluation.
const Editor = dynamic(() => import('../App'), {
  ssr: false,
  loading: () => <main className="studio-loading" role="status" aria-live="polite">正在加载粒子工坊…</main>,
});

export default function ParticleStudio() {
  return <Editor />;
}

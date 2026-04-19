'use client';

import dynamic from 'next/dynamic';
import Head from 'next/head';

const ARView = dynamic(() => import('@/components/ARView'), {
  ssr: false,
});

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-0 overflow-hidden bg-black">
      <Head>
        <title>AR Partition Planner</title>
        <meta name="description" content="Place and visualize aluminium partitions in AR" />
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
      </Head>

      <div className="w-full h-full">
        <ARView />
      </div>
    </main>
  );
}

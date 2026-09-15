'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { VideoPlayer } from '@/components/VideoPlayer';

/**
 * The room code rides in a query param rather than the path.
 *
 * A static export has to know every path at build time, and a 6-character code
 * from a 31-character alphabet is ~887 million of them — `generateStaticParams`
 * cannot enumerate that. A query param keeps the whole frontend a single set of
 * static files while leaving the code visible in the URL.
 *
 * Nothing is lost: the URL was never the way a room is shared. The code is read
 * aloud (§7's alphabet exists for exactly that), and a hard load of this page
 * has no File to play anyway, so VideoPlayer sends it back to the lobby.
 */
function Room() {
  const code = (useSearchParams().get('code') ?? '').toUpperCase();
  return <VideoPlayer code={code} />;
}

export default function RoomPage() {
  // useSearchParams needs a Suspense boundary: the params are not known while
  // the shell is prerendered.
  return (
    <Suspense>
      <Room />
    </Suspense>
  );
}

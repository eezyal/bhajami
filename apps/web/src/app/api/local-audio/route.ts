import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { getRecordingById } from '@/lib/catalog-store';

export const runtime = 'nodejs';

const ALLOWED_ROOTS = [
  '/Users/chax/Downloads/BhajanDownloader',
  '/Users/chax/Downloads/RaviMp3',
];

function isUnderAllowedRoot(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing recording id' }, { status: 400 });
  }

  const recording = getRecordingById(id);
  if (!recording?.localPath) {
    return NextResponse.json({ error: 'Local recording not found' }, { status: 404 });
  }

  const resolvedPath = path.resolve(recording.localPath);
  if (!isUnderAllowedRoot(resolvedPath) || !fs.existsSync(resolvedPath)) {
    return NextResponse.json({ error: 'Audio file unavailable' }, { status: 404 });
  }

  const stat = fs.statSync(resolvedPath);
  const fileSize = stat.size;
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(Number.parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }

    const chunkSize = end - start + 1;
    const nodeStream = fs.createReadStream(resolvedPath, { start, end });
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }

  const nodeStream = fs.createReadStream(resolvedPath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fileSize),
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

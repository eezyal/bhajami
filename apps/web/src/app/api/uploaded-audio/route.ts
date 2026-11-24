import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { verifyUserBearerToken } from '@/lib/firebase-admin';
import { hasCloudConfig } from '@/lib/firestore-rest';
import { logEvent } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.mp4',
  '.aac',
  '.wav',
  '.ogg',
  '.opus',
  '.webm',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
};

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.webm',
};

function resolveUploadsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'data/uploads'),
    path.resolve(process.cwd(), 'apps/web/data/uploads'),
    '/Users/chax/.gemini/antigravity/scratch/bhajami/apps/web/data/uploads',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.dirname(candidate))) {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    }
  }
  const fallback = '/Users/chax/.gemini/antigravity/scratch/bhajami/apps/web/data/uploads';
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function sanitizeBaseName(rawName: string): string {
  const base = path.basename(rawName, path.extname(rawName));
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'community-audio';
}

function resolveExtension(fileName: string, mimeType: string): string | null {
  const extFromName = path.extname(fileName).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(extFromName)) {
    return extFromName;
  }
  const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_MIME[normalizedMime] ?? null;
}

export async function POST(request: Request) {
  try {
    if (hasCloudConfig()) {
      const auth = await verifyUserBearerToken(request.headers.get('authorization'));
      if (!auth.ok) {
        return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
      }
      if (process.env.LOCAL_UPLOADS_ENABLED !== 'true') {
        return NextResponse.json(
          {
            error:
              'Local upload storage is disabled in read-only cloud mode. Please provide an external audio URL instead.',
          },
          { status: 501 },
        );
      }
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'Please select an audio file to upload (field "file").' },
        { status: 400 },
      );
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: 'Uploaded audio file is empty.' }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'Audio recording exceeds the 25 MB upload limit.' },
        { status: 413 },
      );
    }

    const ext = resolveExtension(file.name, file.type);
    if (!ext) {
      return NextResponse.json(
        {
          error:
            'Unsupported audio format. Please upload .mp3, .m4a, .mp4, .aac, .wav, .ogg, .opus, or .webm.',
        },
        { status: 400 },
      );
    }

    const uploadsDir = resolveUploadsDir();
    const safeStem = sanitizeBaseName(file.name);
    const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const storedFileName = `${safeStem}-${uniqueId}${ext}`;
    const destPath = path.join(uploadsDir, storedFileName);

    const bytes = Buffer.from(await file.arrayBuffer());
    await fsp.writeFile(destPath, bytes);

    const mimeType = MIME_BY_EXT[ext] ?? (file.type || 'audio/mpeg');
    const url = `/api/uploaded-audio?file=${encodeURIComponent(storedFileName)}`;

    return NextResponse.json(
      {
        fileName: storedFileName,
        originalName: file.name,
        mimeType,
        sizeBytes: bytes.length,
        url,
      },
      { status: 201 },
    );
  } catch (error) {
    logEvent('error', {
      route: '/api/uploaded-audio POST',
      errCode: 'upload_failed',
      httpStatus: 500,
      message: error instanceof Error ? error.message : 'Failed to upload audio.',
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload audio.' },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawFile = searchParams.get('file')?.trim() ?? '';
  if (!rawFile || rawFile !== path.basename(rawFile) || rawFile.includes('..')) {
    return NextResponse.json({ error: 'Invalid uploaded audio filename.' }, { status: 400 });
  }

  const ext = path.extname(rawFile).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: 'Unsupported audio file extension.' }, { status: 400 });
  }

  const uploadsDir = resolveUploadsDir();
  const targetPath = path.resolve(uploadsDir, rawFile);
  if (!targetPath.startsWith(uploadsDir + path.sep) || !fs.existsSync(targetPath)) {
    return NextResponse.json({ error: 'Uploaded audio file not found.' }, { status: 404 });
  }

  const stat = fs.statSync(targetPath);
  const total = stat.size;
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : total - 1;
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      end >= total ||
      start > end
    ) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      });
    }

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(targetPath, { start, end });
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(chunkSize),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const stream = fs.createReadStream(targetPath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

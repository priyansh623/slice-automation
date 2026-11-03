import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// Only allow UUID-based filenames (no path traversal)
const SAFE_FILENAME = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif)$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { filename } = await params;

  if (!SAFE_FILENAME.test(filename)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Files are stored under the uploading user's id prefix
  const storagePath = `${user.id}/${filename}`;
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

  const serviceSupabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await serviceSupabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Redirect to the signed URL so the browser fetches directly from Supabase CDN
  return NextResponse.redirect(data.signedUrl, { status: 302 });
}

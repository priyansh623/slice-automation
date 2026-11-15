import { NextResponse } from 'next/server';
import { studioRoute } from '@/lib/studio/api';
import { generationConfig } from '@/lib/studio/mock-provider';

// Whether image generation is switched on, and whether it is the test provider (fake pictures). Contains no secrets.
export const GET = studioRoute(async () => NextResponse.json({ generation: generationConfig() }));
